"use server";

import { revalidatePath } from "next/cache";
import { asHtml } from "@/lib/html-safe";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { sendEmail } from "@/lib/email";
import { loadNoticeContext, alreadyNotified } from "./notice-context";
import { planBillNotices, type BillNoticePlan } from "./bill-notice-helpers";
import { whyItDidntGo } from "./reminder-helpers";
import type { ParkResult } from "./actions";
import { prettyMonth } from "./ledger-helpers";
import { mustRead, ReadFailed, readFailedMessage } from "@/lib/must-read";

/**
 * "YOUR BILL IS READY" — the first thing a household should hear about money,
 * and until 0192 the thing the product could not say.
 *
 * `runCharges` ends its own success sentence with the words "Nobody has been
 * told." The run raises eighteen bills and the only resident-facing money
 * message was the OVERDUE demand, which by definition fires after somebody is
 * already late. On 1 January 2027 every household at The Haven signs at
 * $542.53 — $400 rent plus a $142.53 grounds fee most of them have never paid
 * before — the run raises their bills, and the first word any of them gets is
 * a demand.
 *
 * NOT ON A CRON, and not folded into the run. The run is one tap that touches
 * every household; writing to all of them is a second, deliberate act, so it
 * is previewed and then sent, exactly as the chase is. `parks.notices_held_at`
 * still gates every send inside `sendEmail` — nothing leaves until he lifts
 * the hold, and a refusal reaches the owner in the hold's own words.
 *
 * SMS IS NOT A CHANNEL HERE EITHER. 0 of 81 texts have ever been delivered, so
 * `channelFor` routes a texts-preferring household to email or paper and says
 * why. That is the one home for the rule; this file does not second-guess it.
 */

const DENIED = "You don't manage that park.";

/**
 * FALSE for the same reason as the chase's copy of this, and it stays false
 * until a text this app sends actually ARRIVES. Approval is permission to
 * send, not evidence anything landed.
 */
const SMS_ENABLED = false;

async function loadBillPlan(
  parkId: string,
  month?: string,
): Promise<{ plan: BillNoticePlan; parkName: string; month: string } | null> {
  const ctx = await loadNoticeContext(parkId, month);
  if (!ctx) return null;

  const admin = createServiceClient();
  // THE BILL'S OWN FROZEN BREAKDOWN. At The Haven every January bill is $400
  // plus $142.53, and a household who has only ever paid $400 needs the second
  // line explained before being asked for it — otherwise the first thing they
  // do is ring the office and the second is assume they were overcharged.
  // Read, never recomputed: the notice must say what the bill says.
  const bills = mustRead("what each bill is for", await admin
    .from("park_charges")
    .select("id, lines")
    .eq("park_id", parkId)
    .eq("period_month", ctx.month));

  const linesByCharge = new Map<string, { label: string; amount: number }[]>();
  for (const b of bills ?? []) {
    const raw = Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]) : [];
    if (raw.length === 0) continue;
    linesByCharge.set(b.id as string, raw.map((l) => ({
      label: String(l.label ?? "Rent"),
      amount: Number(l.amount ?? 0),
    })));
  }

  const plan = planBillNotices(ctx.page.rows, ctx.contacts, ctx.month, {
    parkName: ctx.parkName,
    officeLine: ctx.officeLine,
    smsEnabled: SMS_ENABLED,
    alreadyReminded: new Set<string>(),
    alreadyTold: await alreadyNotified(parkId, "raised"),
    linesByCharge,
  });

  return { plan, parkName: ctx.parkName, month: ctx.month };
}

/** What WOULD go out. Nothing is sent, nothing is logged. */
export async function previewBillNotices(
  parkId: string,
  month?: string,
): Promise<{ ok: boolean; error?: string; plan?: BillNoticePlan; month?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  let loaded: Awaited<ReturnType<typeof loadBillPlan>>;
  try {
    loaded = await loadBillPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    // "Nobody to tell." would claim we looked and found nobody.
    return { ok: false, error: readFailedMessage("this month's bills", e) };
  }
  if (!loaded) return { ok: false, error: "Nothing to work from." };
  return { ok: true, plan: loaded.plan, month: loaded.month };
}

/**
 * Tell them.
 *
 * Per-notice, errors collected — one bad address must not stop the other
 * seventeen. Every outcome is logged, the ones that could not go included, so
 * "was this household told?" has an answer for every household rather than for
 * the lucky ones.
 */
export async function sendBillNotices(
  parkId: string,
  month?: string,
): Promise<ParkResult & { sent?: number; printed?: number; blocked?: number; failed?: number }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  let loaded: Awaited<ReturnType<typeof loadBillPlan>>;
  try {
    loaded = await loadBillPlan(parkId, month);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    // Says out loud what the owner's first question is: the read failed BEFORE
    // any letter was addressed, so nobody has been written to.
    return {
      ok: false,
      error: "We couldn't load this month's bills just now, so nobody has been told. Try again in a moment.",
    };
  }
  if (!loaded) return { ok: false, error: "Nothing to work from." };

  const { plan, parkName } = loaded;
  if (plan.totalTold === 0 && plan.blocked.length === 0) {
    return { ok: false, error: "Nobody to tell." };
  }

  const admin = createServiceClient();
  const { data: auth } = await (await createClient()).auth.getUser();
  const by = auth?.user?.id ?? null;
  const log: Record<string, unknown>[] = [];
  let sent = 0;
  /** Why each one didn't go. Length is the count; the reasons name the cause. */
  const failed: string[] = [];

  for (const r of plan.toSend) {
    const address = await emailFor(admin, r.renterId);
    if (address.failed) {
      // "No email address on file" is a fact about their record, and writing
      // it into a permanent row at the moment we could not READ that record
      // would be a guess. The two are named apart.
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
        channel: "email", outcome: "failed", sent_by: by,
        reason: address.reason, body: r.body,
      });
      failed.push(address.reason);
      continue;
    }
    if (!address.email) {
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
        channel: "email", outcome: "failed", sent_by: by,
        reason: "No email address on file.", body: r.body,
      });
      failed.push("No email address on file.");
      continue;
    }
    const res = await sendEmail({
      to: address.email,
      subject: `${parkName} — your ${prettyMonth(loaded.month)} bill for lot ${r.lotNumber}`,
      text: r.body,
      html: asHtml(r.body),
      // Named for the receipt row: on a month these stop arriving, the question
      // is which park's residents were never told their bills existed.
      about: { kind: "bill raised", parkId },
    });
    if (res?.ok === false) {
      // THE HOLD IS THE LIKELIEST REFUSAL, and it is one he set himself.
      // `whyItDidntGo` keeps sendEmail's own sentence — "Notices are on hold
      // for this park — …" — rather than writing "check the address" into a
      // permanent row about a perfectly good address.
      const why = whyItDidntGo(res.error);
      failed.push(why);
      log.push({
        park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
        channel: "email", outcome: "failed", sent_by: by,
        reason: why, body: r.body,
      });
      continue;
    }
    sent += 1;
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
      channel: "email", outcome: "sent", sent_by: by, body: r.body,
    });
  }

  // A printed notice counts as told once the owner has the sheet in hand.
  for (const r of plan.toPrint) {
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
      channel: "paper", outcome: "printed", sent_by: by, body: r.body,
    });
  }

  // The ones nothing can reach, WITH the reason, so they are visible rather
  // than absent.
  for (const r of plan.blocked) {
    log.push({
      park_id: parkId, charge_id: r.chargeId, party: "resident", kind: "raised",
      channel: r.channel, outcome: "blocked", sent_by: by,
      reason: r.reason ?? "Couldn't reach them.", body: r.body,
    });
  }

  // THE LOG MUST NOT THROW. By this point the emails have gone; unwinding would
  // leave the park told with no record of it, and the next click would tell
  // them all over again — which the unique index would then refuse, putting
  // "try again" on screen for something that can never succeed. So a failure
  // here degrades, and it degrades OUT LOUD in the sentence below.
  let logged = true;
  if (log.length > 0) {
    const { error } = await admin.from("park_reminders").insert(log);
    if (error) {
      console.error("[sendBillNotices] told them, but the record did not save:", error);
      logged = false;
    }
  }

  revalidatePath("/park/rent");
  revalidatePath("/park");

  const printed = plan.toPrint.length;
  const blocked = plan.blocked.length;
  const parts: string[] = [];
  if (sent > 0) parts.push(`${sent} emailed`);
  if (printed > 0) parts.push(`${printed} to print and hand over`);
  if (blocked > 0) parts.push(`${blocked} we couldn't reach`);
  if (failed.length > 0) parts.push(`${failed.length} didn't go — ${failed[0]}`);
  return {
    ok: sent > 0 || printed > 0,
    sent, printed, blocked, failed: failed.length,
    signal: parts.length > 0
      ? parts.join(" · ") + (logged ? "" : " ⚠️ The record of this didn't save — don't send again until you've checked.")
      : "Nothing went out.",
    error: sent === 0 && printed === 0
      ? `Nothing went out — ${failed[0] ?? "nobody could be reached"}.`
      : undefined,
  };
}

/**
 * Their address, or WHY we don't have one — the two are not the same, and a
 * permanent log row must not blame a household's record for a read that failed.
 */
async function emailFor(
  admin: ReturnType<typeof createServiceClient>,
  renterId: string | null,
): Promise<{ email: string | null; failed: boolean; reason: string }> {
  if (!renterId) return { email: null, failed: false, reason: "No household on that bill." };
  const res = await admin.from("park_renters").select("email").eq("id", renterId).maybeSingle();
  if (res.error) {
    console.error("[read failed] their email address:", res.error);
    return { email: null, failed: true, reason: "We couldn't read their record just now." };
  }
  return { email: (res.data?.email as string) ?? null, failed: false, reason: "No email address on file." };
}
