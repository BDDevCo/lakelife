"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { takePayment, NO_PROCESSOR_REASON, chargeKey } from "@/lib/charge-gate";
import { crewShareOfFee } from "@/lib/cancellation";
import { statementDescriptor } from "@/lib/descriptor";
import { alertOpsDoubleCharge } from "@/lib/automation";
import {
  recoveryHeadline, crewIsOutOfPocket,
} from "@/lib/recovery";
import { assertOps } from "./data";
import { mustRead, readFailedMessage } from "@/lib/must-read";

/**
 * THE OTHER HALF OF "RESCHEDULE OR THEY GET CHARGED".
 *
 * The window closes and nobody picked a day. What happens next is a DECISION,
 * not a job for a cron:
 *
 *   The house rule is that something may run unattended only if its worst
 *   outcome is a sentence on a screen, or a write the database would refuse if
 *   it were wrong. Putting a fee on somebody's card because a crew tapped a
 *   button on a doorstep a week ago is neither of those. If the crew got the
 *   address wrong, or the customer did answer and nobody logged it, the
 *   unattended version bills a blameless person and we find out from a
 *   chargeback.
 *
 * So the sweep PROPOSES — it works out what the policy says and puts a number
 * on an ops screen. A person releases it or waives it. That is one click for
 * a rare event, and it is the click that ought to have a person behind it.
 */


export interface RecoveryResult {
  ok: boolean;
  error?: string;
  signal?: string;
}


export async function chargeProposedFee(jobId: string): Promise<RecoveryResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();

  const jobRes = await admin
    .from("jobs")
    .select("id, recovery_state, fee_proposed_amount, vendor_id, vendor_cost")
    .eq("id", jobId)
    .maybeSingle();
  // "No such visit." asserts the row is gone. On a failed read we know nothing
  // of the sort, and this button is about to put a fee on somebody's card.
  if (jobRes.error) return { ok: false, error: readFailedMessage("that visit", jobRes.error, { money: true }) };
  const job = jobRes.data;
  if (!job) return { ok: false, error: "No such visit." };
  if (job.recovery_state !== "fee_proposed") {
    return { ok: false, error: "There's no fee waiting on that one." };
  }

  const amount = Number(job.fee_proposed_amount ?? 0);
  if (!(amount > 0)) return { ok: false, error: "That fee is zero — waive it instead." };

  // CLAIM THE ROW FIRST. Two ops tabs, two clicks — only one may proceed past
  // here, and it must be decided before any money moves.
  const claimRes = await admin
    .from("jobs")
    .update({ recovery_state: "fee_charging" })
    .eq("id", jobId)
    .eq("recovery_state", "fee_proposed")
    .select("id, property_id, service_id, properties(owner_id)")
    .maybeSingle();
  // A failed claim reads back exactly like a lost race — `data: null`. Telling
  // ops "somebody just decided that one" when nobody did sends them looking for
  // a colleague who never touched it, and hides that the fee is still waiting.
  if (claimRes.error) return { ok: false, error: readFailedMessage("that visit's fee", claimRes.error, { money: true }) };
  const claimed = claimRes.data;
  if (!claimed) return { ok: false, error: "Somebody just decided that one." };

  const ownerId = ((Array.isArray(claimed.properties) ? claimed.properties[0] : claimed.properties) as
    { owner_id?: string } | null)?.owner_id ?? null;

  // AND THEN ACTUALLY CHARGE IT. The first version of this only wrote
  // `recovery_state = 'fee_charged'` and told ops "Fee of $151.00 recorded."
  // — the customer was never billed a cent, the row left the queue, and every
  // screen said charged forever. Worse, `raiseTripFees` reads that state as
  // COLLECTED CASH, so it also understated what LakeLife was funding.
  // ONE INVOICE PER JOB — `invoices_one_per_job` is a UNIQUE index, and this
  // used to be a bare INSERT. That made the SECOND attempt impossible: the
  // first click raises the invoice, the card declines, the state goes back to
  // `fee_proposed` and the invoice stays. Click Charge again and the insert
  // hits 23505, which supabase-js hands back as `{error, data:null}` — so
  // `invoice` was null, the whole charge block was skipped, and ops was told
  // "That card declined (or there isn't one on file)" about a card that was
  // never presented. A customer who fixed their card could never be charged.
  // Reuse the row, exactly as the late-cancellation path and the nightly do.
  const invoiceRes = await admin
    .from("invoices").select("id, status").eq("job_id", jobId).maybeSingle();
  // A FAILED READ HERE IS NOT "THERE IS NO INVOICE". Falling through on null
  // walks straight into the insert branch this whole comment block exists to
  // fix, and — worse — skips the `status === 'paid'` guard below, which is the
  // only thing standing between a settled fee and a second bite at the card.
  // The unique index would still refuse it, but "refused by an index" is not a
  // safety property anyone should be relying on. Put the row back and stop.
  if (invoiceRes.error) {
    await admin.from("jobs").update({ recovery_state: "fee_proposed" }).eq("id", jobId);
    return { ok: false, error: readFailedMessage("that visit's invoice", invoiceRes.error, { money: true }) };
  }
  let invoice = invoiceRes.data;
  if (!invoice) {
    const { data: created, error: iErr } = await admin
      .from("invoices")
      .insert({ job_id: jobId, property_id: claimed.property_id, amount, status: "due" })
      .select("id, status")
      .single();
    if (iErr || !created) {
      // Put the row back on the queue rather than stranding it mid-claim.
      await admin.from("jobs").update({ recovery_state: "fee_proposed" }).eq("id", jobId);
      return { ok: false, error: "Couldn't raise the invoice — nothing was charged." };
    }
    invoice = created;
  } else if (invoice.status === "paid") {
    // Already settled. Charging again would be a second bite at the same card.
    await admin.from("jobs").update({ recovery_state: "fee_charged" }).eq("id", jobId);
    return { ok: false, error: "That one is already paid — nothing further was charged." };
  }

  let charged = false;
  let ref: string | null = null;
  if (invoice && ownerId) {
    const pmRes = await admin
      .from("payment_methods").select("token").eq("user_id", ownerId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    // THE SENTENCE AT THE BOTTOM OF THIS FUNCTION IS A CLAIM ABOUT THEIR CARD
    // — "That card declined (or there isn't one on file)". A failed read here
    // takes the same branch as a customer with no card, so ops rings somebody
    // to say their card bounced about a card that was never presented. Put the
    // row back on the queue and say what actually happened.
    if (pmRes.error) {
      await admin.from("jobs").update({ recovery_state: "fee_proposed" }).eq("id", jobId);
      return { ok: false, error: readFailedMessage("the card on file", pmRes.error, { money: true }) };
    }
    const pm = pmRes.data;
    if (pm?.token) {
      // HOW MANY TIMES THIS CARD HAS ALREADY DECLINED ON THIS INVOICE. It is
      // half the idempotency key: an interrupted attempt must REPLAY rather
      // than debit a second time, and a real decline must be free to RETRY
      // rather than be answered with a replay of the refusal.
      //
      // A failed read is not zero. A key built from a count we never saw is a
      // key that differs from the interrupted attempt's, which is precisely a
      // second charge — so the row goes back on the queue instead.
      const declinesRes = await admin
        .from("payments").select("id", { count: "exact", head: true })
        .eq("invoice_id", invoice.id).eq("status", "failed");
      if (declinesRes.error) {
        await admin.from("jobs").update({ recovery_state: "fee_proposed" }).eq("id", jobId);
        return { ok: false, error: readFailedMessage("that visit's card attempts", declinesRes.error, { money: true }) };
      }
      const charge = await takePayment({
        token: pm.token as string,
        amountCents: Math.round(amount * 100),
        description: statementDescriptor("visit_fee"),
        idempotencyKey: chargeKey("visit_fee", invoice.id as string, declinesRes.count ?? 0),
      });
      // A NON-ATTEMPT IS NOT A DECLINE (see charge-gate). With no processor
      // connected nobody's card was asked, so there is no attempt to file and
      // nothing to blame them for.
      if (!charge.ok && charge.reason === NO_PROCESSOR_REASON) {
        return { ok: false, error: "Card payments aren't switched on yet — nothing was charged, and the fee is still proposed." };
      }
      const { error: payErr } = await admin.from("payments").insert({
        invoice_id: invoice.id, amount,
        status: charge.ok ? "captured" : "failed", processor_ref: charge.ref ?? null,
      });
      // ANY failure to record a real charge, not only a duplicate. The old
      // condition named 23505 alone, so a dropped connection took the fee and
      // told nobody — and the sentence at the bottom of this function would
      // have said the money was charged while the ledger held nothing.
      if (charge.ok && payErr) {
        await alertOpsDoubleCharge(admin, invoice.id as string, amount, charge.ref ?? null);
      }
      charged = charge.ok;
      ref = charge.ref ?? null;
      // 'paid' means a payment row says so. When the charge worked and the row
      // did not, the invoice stays 'due' and the alert above is what carries
      // it to a person — there is no nightly retry for a visit fee.
      if (charged && !payErr) {
        await admin.from("invoices").update({ status: "paid", processor_ref: ref }).eq("id", invoice.id);
      }
    }
  }

  // The state must tell the truth about whether money arrived. A failed charge
  // goes BACK to proposed so it stays on the queue rather than vanishing into
  // a 'charged' that never happened.
  await admin
    .from("jobs")
    .update({ recovery_state: charged ? "fee_charged" : "fee_proposed" })
    .eq("id", jobId);

  // THE FLOOR ACTUALLY PAYS NOW.
  //
  // 0090 promised the crew `max(trip fee, their share of a fee the customer
  // actually paid)`. The share half could never happen: `raiseTripFees` runs
  // the night after the visit and stamps the attempt, while a fee is not
  // chargeable for another seven days — so by the time money arrived, the
  // top-up branch had nothing left to look at. The crew always got the flat
  // $35 and never the share, even on a job whose share is $200.
  //
  // So the top-up is paid HERE, at the only moment the share becomes real:
  // when the customer's money lands.
  if (charged) {
    try {
      const fullRes = await admin
        .from("jobs").select("vendor_id, vendor_cost").eq("id", jobId).maybeSingle();
      if (fullRes.error) {
        // Reading a `vendor_cost` of 0 out of a failed read makes the share 0
        // and pays the crew nothing, silently. Skip and let ops chase it.
        console.error("[read failed] the crew's cost on that visit:", fullRes.error);
        throw fullRes.error;
      }
      const full = fullRes.data;
      const dials = await getPlatformSettings();
      // ONE HOME (@/lib/cancellation). This multiplied and never rounded, so
      // the crew's share of a visit fee could differ in the cents from the
      // same crew's share of a late cancellation on an identical job.
      const share = crewShareOfFee(dials.cancelFeePct, Number(full?.vendor_cost ?? 0));

      // FAILS OPEN, AND IT PAYS TWICE. This read is the ONLY thing that knows
      // the crew already had the flat trip fee. `data: null` on a dropped
      // connection reduces to `paid = 0`, so the top-up below is computed as
      // the WHOLE share and inserted on top of a payout that already exists —
      // real money, out the door, with nothing on any screen to say so. A
      // failed read here must skip the top-up, never assume nothing was paid.
      const alreadyRes = await admin
        .from("payouts").select("amount").eq("job_id", jobId).eq("kind", "trip");
      if (alreadyRes.error) {
        console.error("[read failed] what the crew was already paid for that trip:", alreadyRes.error);
        throw alreadyRes.error;
      }
      const already = alreadyRes.data;
      const paid = (already ?? []).reduce((n, r) => n + Number(r.amount ?? 0), 0);

      const topUp = Math.round((share - paid) * 100) / 100;
      if (full?.vendor_id && topUp > 0) {
        await admin.from("payouts").insert({
          vendor_id: full.vendor_id,
          job_id: jobId,
          amount: topUp,
          original_amount: topUp,
          status: "released",
          kind: "trip",
        });
      }
    } catch {
      /* The customer's charge stands. A missed top-up is ops' to chase, not a
         reason to unwind money that has already moved. */
    }
  }

  revalidatePath("/ops");
  if (!charged) {
    return {
      ok: false,
      error: "That card declined (or there isn't one on file). The invoice is raised and still due — it stays on your list.",
    };
  }
  return { ok: true, signal: `Charged $${amount.toFixed(2)}.` };
}

/**
 * A person waives it. Says out loud who ends up carrying the trip, because
 * the crew drove there and this is the branch where they get nothing.
 */
export async function waiveProposedFee(jobId: string, why: string): Promise<RecoveryResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  if (!why.trim()) return { ok: false, error: "Say why — it's a decision, not a default." };

  const admin = createServiceClient();
  const { error } = await admin
    .from("jobs")
    .update({
      recovery_state: "fee_waived",
      reschedule_deadline: null,
      // NOT `scope_note`. That column means one thing — what the crew did
      // versus what they found on a job that went ahead at a reduced scope —
      // and a waiver reason is a different fact about a job where NO work
      // happened. Two meanings in one column is how a screen ends up printing
      // "Visit fee waived: goodwill" where it promised to say what was done.
      fee_waived_reason: why.trim(),
    })
    .eq("id", jobId)
    .in("recovery_state", ["fee_proposed", "awaiting_customer"]);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/ops");
  return { ok: true, signal: "Waived. The crew is out of pocket for that trip." };
}

export interface ProposedFeeRow {
  jobId: string;
  serviceName: string;
  address: string;
  attemptedOn: string;
  outcome: "no_access" | "stood_down";
  reason: string;
  fee: number;
  crewShare: number;
  /** What the crew has already been paid for the wasted trip (0090). */
  tripFeePaid: number;
  /** The at-a-glance state line for a list somebody is triaging. */
  headline: string;
  /** True when nothing at all has reached the crew for this trip. */
  crewOutOfPocket: boolean;
  /** Which of the three states this row is actually in. */
  state: "fee_proposed" | "fee_waived" | "fee_charging";
  /** Why ops waived it — required at the time, and now readable afterwards. */
  waivedReason: string | null;
}

/**
 * The fee decisions waiting on a person.
 *
 * The nightly PROPOSES; nobody's card is touched until somebody here says so.
 * Each row carries what the crew already got for the trip, because that is the
 * fact that should change how generous ops feels able to be — waiving is much
 * easier to do kindly when the crew is not the one absorbing it.
 */
export async function getProposedFees(): Promise<ProposedFeeRow[]> {
  if (!(await assertOps())) return [];
  const admin = createServiceClient();

  // A LOADER, not a button — it returns rows, so it throws like every other
  // loader rather than returning a message nothing here could render. /ops
  // already wraps this call in its own try/catch (deliberately: a fee nobody
  // can see beats a console nobody can), so the throw is caught there and the
  // failure finally shows up in the log instead of as an empty list.
  const jobs = mustRead(
    "the fee decisions waiting on a person",
    await admin
      .from("jobs")
      .select("id, date, recovery_state, fee_proposed_amount, fee_waived_reason, reschedule_deadline, vendor_cost, no_show_at, no_show_reason, stood_down_at, stood_down_reason, services(name), properties(address)")
      // ALL THREE STATES. A stand-down is auto-waived by the nightly (never
      // fee-eligible), so filtering on `fee_proposed` alone meant a crew who
      // drove out because OUR profile was wrong never appeared on anybody's
      // screen. Nothing is charged for these — the card offers no fee — but the
      // trip happened and somebody should see it.
      //
      // AND `fee_charging`, which 0092 said in writing "needs a human" — and
      // then no query anywhere selected it. A charge that died mid-flight was
      // invisible to this screen, refused by both action guards and ignored by
      // the nightly: the one row a person was told to look at was the one row
      // nobody could see.
      .in("recovery_state", ["fee_proposed", "fee_waived", "fee_charging"])
      .order("date", { ascending: true }),
  );
  if (!jobs?.length) return [];

  const settings = await getPlatformSettings();
  const ids = jobs.map((j) => j.id as string);

  // What the crew already received for each wasted trip. On a failed read this
  // would come back 0 for every row, and 0 is what drives `crewOutOfPocket` —
  // i.e. the card would tell the person deciding whether to waive that the crew
  // got nothing, which is the single fact this screen exists to put in front of
  // them. It must be true or it must not render.
  const trips = mustRead(
    "what the crews were already paid for those trips",
    await admin.from("payouts").select("job_id, amount").in("job_id", ids).eq("kind", "trip"),
  );
  // The real attempt dates, from the append-only record.
  const attempts = mustRead(
    "the dates the crews actually went",
    await admin
      .from("job_visit_attempts").select("job_id, attempted_on").in("job_id", ids)
      .order("attempted_on", { ascending: false }),
  );
  const attemptByJob = new Map<string, string>();
  for (const a of attempts ?? []) {
    if (!attemptByJob.has(a.job_id as string)) {
      attemptByJob.set(a.job_id as string, a.attempted_on as string);
    }
  }

  const paidByJob = new Map<string, number>();
  for (const t of trips ?? []) {
    paidByJob.set(t.job_id as string, (paidByJob.get(t.job_id as string) ?? 0) + Number(t.amount ?? 0));
  }

  return jobs.map((j) => {
    const svc = (Array.isArray(j.services) ? j.services[0] : j.services) as { name?: string } | null;
    const prop = (Array.isArray(j.properties) ? j.properties[0] : j.properties) as { address?: string } | null;
    const standDown = !!j.stood_down_at;
    return {
      jobId: j.id as string,
      serviceName: svc?.name ?? "Service",
      address: prop?.address ?? "—",
      // THE DATE THE CREW WENT, not the date the job was scheduled for. They
      // are the same only until a job is rescheduled — after that the card
      // said "nobody let them in on Aug 20" about a trip made on Aug 12.
      attemptedOn: attemptByJob.get(j.id as string)
        ?? ((standDown ? j.stood_down_at : j.no_show_at) as string | null)?.slice(0, 10)
        ?? ((j.date as string) ?? ""),
      outcome: standDown ? "stood_down" : "no_access",
      reason: ((standDown ? j.stood_down_reason : j.no_show_reason) as string) ?? "",
      fee: Number(j.fee_proposed_amount ?? 0),
      crewShare: Math.round(Math.max(0, Number(j.vendor_cost ?? 0)) * settings.cancelFeePct * 100) / 100,
      tripFeePaid: paidByJob.get(j.id as string) ?? 0,
      // The one line a person triaging a list needs, and the plain statement
      // of who ends up carrying the trip. Both were written in 0089 and
      // rendered nowhere until now.
      headline: recoveryHeadline("fee_proposed", {
        outcome: standDown ? "stood_down" : "no_access",
        deadline: (j.reschedule_deadline as string) ?? null,
        todayISO: todayLakeDate(),
        fee: Number(j.fee_proposed_amount ?? 0),
      }),
      crewOutOfPocket: crewIsOutOfPocket(
        "fee_proposed",
        standDown ? "stood_down" : "no_access",
        paidByJob.get(j.id as string) ?? 0,
      ),
      state: (j.recovery_state as ProposedFeeRow["state"]) ?? "fee_proposed",
      // 0095 justified this column on "in six months the only way to know why
      // is if they wrote it down". Ops was made to type it — the button is
      // disabled without one — and then nothing ever read it back.
      waivedReason: (j.fee_waived_reason as string) ?? null,
    };
  });
}
