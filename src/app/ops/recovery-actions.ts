"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";
import { proposedFee, deadlinePassed } from "@/lib/recovery";
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
