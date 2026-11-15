"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "@/app/ops/data";
import { bankKeyConfigured } from "@/lib/gate";
import { notify } from "@/lib/notify";
import { mercuryConfigured, requestPayout, payoutKey, NOT_CONFIGURED } from "@/lib/mercury";
import { ensureMercuryRecipient } from "@/app/ops/mercury-recipient";
import { payoutEligibility, type PlanBatch } from "@/app/api/ops/payout-export/export-plan";

/**
 * PAY THE CREWS THROUGH MERCURY, instead of downloading a file.
 *
 * The CSV rail still exists and still works; this is the one that replaces it.
 * 0202 makes a batch take exactly ONE of them, because a batch that went into
 * a bank file AND to Mercury pays a crew twice out of LakeLife's own account.
 *
 * WHAT THIS DOES NOT DO IS MOVE MONEY. Mercury's `request-send-money` queues a
 * payment for approval — it is the path that needs no IP allowlist, which
 * matters because Vercel has no static egress IP. So this run ends with
 * everything sitting in Mercury waiting for one tap there. That is the
 * standing "nothing goes out until he says" rule, enforced by the bank.
 */

export interface MercuryRunResult {
  ok: boolean;
  error?: string;
  signal?: string;
  /** Batches now waiting for approval in Mercury. */
  submitted?: number;
  /** Batches we could not send, and why, for the screen to list. */
  failures?: Array<{ payee: string; why: string }>;
  skippedNoBank?: number;
  excludedFixture?: number;
}

export async function sendQueuedToMercury(): Promise<MercuryRunResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  // ASKED BEFORE ANYTHING IS READ, for the reason the CSV route asks: without
  // the key EVERY blob fails to open, and counting each one as "no bank on
  // file" produces a run that blames the crews for a missing env var.
  if (!bankKeyConfigured()) {
    return {
      ok: false,
      error:
        "The key that decrypts crew bank details isn't set, so nothing was sent and nothing " +
        "has changed. Nobody's payout is affected — they stay queued.",
    };
  }
  if (!mercuryConfigured()) return { ok: false, error: NOT_CONFIGURED };

  const admin = createServiceClient();

  // Only 'queued'. A batch that is 'building' is still being assembled and a
  // batch that is 'exported' has already taken the other rail — 0202 refuses
  // that move at the database, and asking for it here would be asking for a
  // refusal.
  const batchRes = await admin
    .from("payout_batches")
    .select("id, user_id, kind, net, status, vendors(company), users(name, is_fixture)")
    .eq("status", "queued");
  if (batchRes.error) {
    console.error("[mercury run] could not read the queue:", batchRes.error.message);
    return { ok: false, error: "We couldn't read the payout queue just now — nothing was sent." };
  }
  const raw = (batchRes.data ?? []) as unknown as Array<{
    id: string; user_id: string; kind: string; net: number | string | null; status: string;
    vendors: unknown; users: unknown;
  }>;
  if (raw.length === 0) {
    return { ok: true, submitted: 0, signal: "Nothing is queued — every released payout has already gone." };
  }

  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const batches: PlanBatch[] = raw.map((b) => {
    const vendor = first(b.vendors) as { company?: string | null } | null;
    const user = first(b.users) as { name?: string | null; is_fixture?: boolean | null } | null;
    return {
      id: b.id, user_id: b.user_id, kind: b.kind, net: b.net, status: b.status,
      payee: vendor?.company || user?.name || "Unknown payee",
      isFixture: user?.is_fixture === true,
    };
  });

  const acctRes = await admin
    .from("payout_accounts")
    // NO BLOBS HERE, DELIBERATELY. `account_last4` is written by
    // `setPayoutAccount` alongside the sealed numbers, so it answers "do they
    // have a bank on file?" without this file ever naming a credential — and
    // `route.test.ts` keeps a list of the only files allowed to. The one
    // decryption happens inside `ensureMercuryRecipient`, once per crew ever.
    .select("user_id, bank_name, account_last4, mercury_recipient_id")
    .in("user_id", batches.map((b) => b.user_id));
  // A FAILED READ IS NOT "NOBODY HAS A BANK ON FILE" — the same refusal the
  // CSV route makes, for the same reason: falling through would report every
  // crew as unbanked when the truth is we could not look.
  if (acctRes.error) {
    console.error("[mercury run] could not read bank details:", acctRes.error.message);
    return { ok: false, error: "We couldn't read the crews' bank details just now — nothing was sent." };
  }
  const accounts = (acctRes.data ?? []) as unknown as Array<{
    user_id: string; bank_name: string | null;
    account_last4: string | null; mercury_recipient_id: string | null;
  }>;
  const byUser = new Map(accounts.map((a) => [a.user_id, a]));

  const failures: Array<{ payee: string; why: string }> = [];
  let submitted = 0;
  let skippedNoBank = 0;
  let excludedFixture = 0;

  for (const b of batches) {
    // THE SAME ELIGIBILITY THE FILE USES. Shared so the two rails cannot
    // disagree about who is owed or who is fenced out — the fixture fence in
    // particular, which exists because production holds three released
    // payouts to a crew whose owner is `is_fixture`.
    const acct = byUser.get(b.user_id);
    const verdict = payoutEligibility(b, Boolean(acct?.account_last4));
    if (verdict === "fixture") { excludedFixture += 1; continue; }
    if (verdict === "no-bank") { skippedNoBank += 1; continue; }

    const netCents = Math.round(Number(b.net ?? 0) * 100);

    // 1. Mercury needs to know the payee. Once per crew, ever — and the only
    //    moment their numbers are readable, inside that function.
    const recipient = await ensureMercuryRecipient(
      b.user_id, b.payee, acct?.mercury_recipient_id ?? null,
    );
    if (!recipient.ok) { failures.push({ payee: b.payee, why: recipient.error ?? "Mercury refused the payee." }); continue; }

    // 2. Ask for the payment. Keyed on the batch, so a retry after a timeout
    //    cannot ask twice for the same money.
    const asked = await requestPayout(
      { recipientId: recipient.recipientId!, amountCents: netCents, note: `LakeLife payout ${b.id.slice(0, 8)}` },
      payoutKey(b.id),
    );
    if (!asked.ok) { failures.push({ payee: b.payee, why: asked.error ?? "Mercury refused the payment." }); continue; }

    // 3. Record it. GUARDED ON 'queued', so two people tapping this at once
    //    cannot both claim the same batch — the second update matches no row.
    const flip = await admin
      .from("payout_batches")
      .update({ status: "submitted", mercury_request_id: asked.data!.requestId })
      .eq("id", b.id)
      .eq("status", "queued")
      .select("id");
    if (flip.error || (flip.data ?? []).length === 0) {
      // MONEY IS QUEUED AT MERCURY AND OUR LEDGER DOES NOT SAY SO. The worst
      // state this function can reach, and it must never be silent — the same
      // posture as a charge that succeeded with a row that failed.
      console.error(
        `[mercury run] ASKED MERCURY FOR ${netCents}c ON BATCH ${b.id} ` +
        `(request ${asked.data!.requestId}) AND COULD NOT RECORD IT:`,
        flip.error?.message ?? "the batch was no longer queued",
      );
      failures.push({
        payee: b.payee,
        why:
          `Mercury has the request (${asked.data!.requestId}) but we couldn't mark the batch — ` +
          `do NOT approve it in Mercury until this is sorted, or they may be paid twice.`,
      });
      continue;
    }
    submitted += 1;
  }

  if (submitted > 0) {
    try {
      const people = await admin.from("users").select("email, phone").eq("role", "ops");
      for (const o of people.data ?? []) {
        await notify(
          "ops that payouts are waiting for approval in Mercury",
          { email: (o.email as string) ?? null, phone: (o.phone as string) ?? null },
          {
            subject: `${submitted} payout${submitted === 1 ? "" : "s"} waiting for approval in Mercury`,
            body:
              `${submitted} crew payout${submitted === 1 ? " is" : "s are"} queued at Mercury and ` +
              `waiting for approval there.\n\nNothing has moved yet — Mercury will not send them ` +
              `until somebody approves.`,
            sms: `LakeLife: ${submitted} payout${submitted === 1 ? "" : "s"} waiting for your approval in Mercury. 🌊`,
          },
        );
      }
    } catch { /* the requests are queued; an unsent nudge must not undo that */ }
  }

  revalidatePath("/ops");
  return {
    ok: true,
    submitted,
    failures: failures.length > 0 ? failures : undefined,
    skippedNoBank,
    excludedFixture,
    signal:
      submitted === 0
        ? "Nothing went to Mercury."
        : `${submitted} payout${submitted === 1 ? "" : "s"} queued at Mercury — they're waiting for your approval there. Nothing has moved yet.`,
  };
}
