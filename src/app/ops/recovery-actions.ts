"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { proposedFee, deadlinePassed, tripFeeFor } from "@/lib/recovery";
import { assertOps } from "./data";

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

/**
 * RAISE THE TRIP FEE FOR EVERY ATTEMPT THAT HASN'T HAD ONE.
 *
 * Runs nightly, and it accrues WITHOUT asking a person — deliberately. The
 * worst case if it fires wrongly is that we pay a crew $35 they did not earn:
 * small, clawback-able, and invisible to the customer. That is a different
 * animal from putting money on somebody's card, which is why the other half of
 * this path still waits for a human.
 *
 * Idempotent by construction: it only ever looks at attempts whose
 * `trip_fee_payout_id` is null, and stamps it the moment the payout exists. A
 * job attempted, rescheduled and attempted again is TWO trips and is paid
 * twice — correctly — because the unit of work here is the attempt, never the
 * job.
 */
export async function raiseTripFees(): Promise<{ paid: number; total: number; onUs: number }> {
  const admin = createServiceClient();
  const settings = await getPlatformSettings();

  const { data: attempts } = await admin
    .from("job_visit_attempts")
    .select("id, job_id, vendor_id, outcome, jobs(recovery_state, fee_proposed_amount, vendor_cost)")
    .is("trip_fee_payout_id", null)
    .not("vendor_id", "is", null);

  let paid = 0;
  let total = 0;
  let onUs = 0;

  for (const a of attempts ?? []) {
    const job = (Array.isArray(a.jobs) ? a.jobs[0] : a.jobs) as
      { recovery_state?: string; fee_proposed_amount?: number; vendor_cost?: number } | null;

    // Their share of a fee the customer ACTUALLY paid. A proposed fee is not a
    // paid one, so only 'fee_charged' funds anything.
    const collectedCrewShare =
      job?.recovery_state === "fee_charged"
        ? Math.max(0, Number(job.vendor_cost ?? 0)) * settings.cancelFeePct
        : 0;

    const t = tripFeeFor({
      outcome: a.outcome as "no_access" | "stood_down",
      collectedCrewShare,
      tripFee: settings.crewTripFee,
    });
    if (!(t.owed > 0)) continue;

    const { data: payout, error } = await admin
      .from("payouts")
      .insert({
        vendor_id: a.vendor_id,
        job_id: a.job_id,
        amount: t.owed,
        original_amount: t.owed,
        // Released on sight: the trip is the deliverable and it already
        // happened. It rides the same month-end batch as job earnings.
        status: "released",
        kind: "trip",
      })
      .select("id")
      .single();
    if (error || !payout) continue;

    // Stamp it immediately — this is what makes a retry safe.
    await admin
      .from("job_visit_attempts")
      .update({ trip_fee_payout_id: payout.id })
      .eq("id", a.id);

    paid += 1;
    total += t.owed;
    if (t.fundedBy === "lakelife") onUs += t.owed;
  }

  return { paid, total: Math.round(total * 100) / 100, onUs: Math.round(onUs * 100) / 100 };
}

export interface RecoveryResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

/**
 * Nightly: any unworked visit whose window has closed gets a number attached
 * and moves to `fee_proposed`. Nothing is charged and nobody is told.
 *
 * A stand-down is skipped entirely — our record was wrong, and we told the
 * customer in writing that nothing would be charged.
 */
export async function proposeOverdueFees(): Promise<{ proposed: number; skipped: number }> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const settings = await getPlatformSettings();

  const { data: rows } = await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id, reschedule_deadline, no_show_at, stood_down_at")
    .eq("recovery_state", "awaiting_customer")
    .not("reschedule_deadline", "is", null);

  let proposed = 0;
  let skipped = 0;

  for (const j of rows ?? []) {
    if (!deadlinePassed((j.reschedule_deadline as string) ?? null, today)) continue;

    // Never fee-eligible: the profile was ours and it was wrong.
    if (j.stood_down_at) {
      await admin.from("jobs")
        .update({ recovery_state: "fee_waived", reschedule_deadline: null })
        .eq("id", j.id);
      skipped += 1;
      continue;
    }

    const q = proposedFee(
      {
        hasCrew: !!j.vendor_id,
        customerPrice: Number(j.customer_price ?? 0),
        vendorCost: j.vendor_cost == null ? null : Number(j.vendor_cost),
      },
      {
        cancelFeePct: settings.cancelFeePct,
        cancelRoutineHours: settings.cancelRoutineHours,
        cancelWaterDays: settings.cancelWaterDays,
      },
    );

    if (q.free) {
      // The policy says nothing is owed. Close it rather than parking a $0
      // decision on somebody's desk.
      await admin.from("jobs")
        .update({ recovery_state: "fee_waived", reschedule_deadline: null })
        .eq("id", j.id);
      skipped += 1;
      continue;
    }

    await admin.from("jobs")
      .update({ recovery_state: "fee_proposed", fee_proposed_amount: q.fee })
      .eq("id", j.id);
    proposed += 1;
  }

  return { proposed, skipped };
}

/**
 * A person releases the fee. THIS is where money moves, and only here.
 *
 * Deliberately not implemented as a card charge yet: the processor keys do not
 * exist (CLAUDE.md rule 4 — build against the mock until they do), and a
 * half-built charge path is worse than an honest one. What this does today is
 * record the decision and hand the amount to the existing billing pipeline the
 * same way a late-cancellation fee is handed over.
 */
export async function chargeProposedFee(jobId: string): Promise<RecoveryResult> {
  if (!(await assertOps())) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();

  const { data: job } = await admin
    .from("jobs")
    .select("id, recovery_state, fee_proposed_amount, vendor_id, vendor_cost")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "No such visit." };
  if (job.recovery_state !== "fee_proposed") {
    return { ok: false, error: "There's no fee waiting on that one." };
  }

  const amount = Number(job.fee_proposed_amount ?? 0);
  if (!(amount > 0)) return { ok: false, error: "That fee is zero — waive it instead." };

  const { error } = await admin
    .from("jobs")
    .update({ recovery_state: "fee_charged" })
    .eq("id", jobId)
    .eq("recovery_state", "fee_proposed");   // no double-charge on a double-click
  if (error) return { ok: false, error: error.message };

  revalidatePath("/ops");
  return { ok: true, signal: `Fee of $${amount.toFixed(2)} recorded.` };
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
      scope_note: `Visit fee waived: ${why.trim()}`,
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

  const { data: jobs } = await admin
    .from("jobs")
    .select("id, date, fee_proposed_amount, vendor_cost, no_show_at, no_show_reason, stood_down_at, stood_down_reason, services(name), properties(address)")
    .eq("recovery_state", "fee_proposed")
    .order("date", { ascending: true });
  if (!jobs?.length) return [];

  const settings = await getPlatformSettings();
  const ids = jobs.map((j) => j.id as string);

  // What the crew already received for each wasted trip.
  const { data: trips } = await admin
    .from("payouts").select("job_id, amount").in("job_id", ids).eq("kind", "trip");
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
      attemptedOn: (j.date as string) ?? "",
      outcome: standDown ? "stood_down" : "no_access",
      reason: ((standDown ? j.stood_down_reason : j.no_show_reason) as string) ?? "",
      fee: Number(j.fee_proposed_amount ?? 0),
      crewShare: Math.max(0, Number(j.vendor_cost ?? 0)) * settings.cancelFeePct,
      tripFeePaid: paidByJob.get(j.id as string) ?? 0,
    };
  });
}
