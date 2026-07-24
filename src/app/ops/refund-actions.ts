"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "@/app/ops/data";
import { LakeLifePayments } from "@/lib/payments";
import {
  refundableRemaining, defaultClawback, clampClawback, planClawback,
  invoiceStatusAfter, type PayoutSnapshot,
} from "@/lib/refunds";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

export interface RefundResult {
  ok: boolean;
  error?: string;
  refunded?: number;
  clawback?: number;
}

/**
 * Quote what a refund WOULD do — drives the ops modal preview. Read-only.
 * Rule 1 lives here too: this whole surface is ops-only (assertOps), and
 * the crew-side notification never carries the customer refund amount.
 */
export async function quoteRefund(jobId: string): Promise<{
  ok: boolean; error?: string;
  refundable?: number; capturedCash?: number; alreadyRefunded?: number;
  suggestedClawback?: number; vendorCost?: number; crewPaidOut?: boolean;
}> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();

  const { data: job } = await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const { data: invoice } = await admin
    .from("invoices").select("id, amount, status").eq("job_id", jobId).maybeSingle();
  if (!invoice) return { ok: false, error: "No invoice on this job yet." };
  const { data: payment } = await admin
    .from("payments").select("id, amount, status, processor_ref")
    .eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle();
  if (!payment) return { ok: false, error: "Nothing captured on this job — there's no cash to send back." };

  const { data: priorRows } = await admin
    .from("refunds").select("amount, crew_clawback").eq("invoice_id", invoice.id);
  const already = (priorRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const alreadyClawed = (priorRows ?? []).reduce((s, r) => s + Number(r.crew_clawback ?? 0), 0);
  const captured = Number(payment.amount ?? 0);
  const refundable = refundableRemaining(captured, already);

  const { data: payout } = await admin
    .from("payouts").select("id, amount, original_amount, status, batch_id")
    .eq("job_id", jobId).eq("kind", "earning").maybeSingle();
  // Across MULTIPLE partial refunds the crew can never give back more than
  // they were EVER OWED (the earning's immutable original — a cancellation
  // fee only ever paid the crew their share, never vendor_cost).
  const everOwed = Number(payout?.original_amount ?? payout?.amount ?? 0);
  const clawable = Math.max(0, Math.round((everOwed - alreadyClawed) * 100) / 100);

  return {
    ok: true,
    refundable,
    capturedCash: captured,
    alreadyRefunded: Math.round(already * 100) / 100,
    suggestedClawback: Math.min(clawable, defaultClawback(refundable, Number(job.customer_price ?? 0), Number(job.vendor_cost ?? 0))),
    vendorCost: clawable,
    crewPaidOut: !!payout && (payout.batch_id != null || payout.status !== "released"),
  };
}

/**
 * Issue a refund (docs/refunds-design.md). The refunds LEDGER is the lock:
 * the row is inserted first as a claim, the running total is re-checked
 * AFTER insert, and an over-refund (double-tap race) deletes its own claim
 * and aborts — nothing external happens until the claim survives. Then the
 * processor refund runs (mock today, same shape as the real adapter), the
 * crew clawback plan applies (reduce loose payout / negative adjustment
 * that nets against the next batch — ToS §7.6), un-matured referral
 * accruals from the job void on a FULL refund, and both sides hear about
 * it — the crew WITHOUT ever seeing the customer amount (rule 1).
 */
export async function issueRefund(input: {
  jobId: string;
  amount: number;
  clawback?: number | null; // null/undefined = proportional default
  reason: string;
  /** Client-minted UUID: a timed-out-then-retried submit lands exactly once. */
  idempotencyKey?: string;
}): Promise<RefundResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();

  const amount = Math.round(Number(input.amount) * 100) / 100;
  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (!(amount > 0)) return { ok: false, error: "Refund amount must be positive." };
  if (!reason) return { ok: false, error: "Give the refund a reason — it's the audit trail." };

  const { data: job } = await admin
    .from("jobs")
    .select("id, customer_price, vendor_cost, vendor_id, property_id, services(name), properties(address, users(id, phone, email))")
    .eq("id", input.jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const { data: invoice } = await admin
    .from("invoices").select("id, amount, status").eq("job_id", input.jobId).maybeSingle();
  if (!invoice) return { ok: false, error: "No invoice on this job yet." };
  const { data: payment } = await admin
    .from("payments").select("id, amount, status, processor_ref")
    .eq("invoice_id", invoice.id).eq("status", "captured").maybeSingle();
  if (!payment) return { ok: false, error: "Nothing captured on this job — there's no cash to send back." };
  const captured = Number(payment.amount ?? 0);

  const { data: priorRows } = await admin
    .from("refunds").select("amount, crew_clawback").eq("invoice_id", invoice.id);
  const already = (priorRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const alreadyClawed = (priorRows ?? []).reduce((s, r) => s + Number(r.crew_clawback ?? 0), 0);
  if (amount > refundableRemaining(captured, already)) {
    return { ok: false, error: `Only $${refundableRemaining(captured, already).toFixed(2)} is still refundable on this bill.` };
  }

  // Clawback band: cap by what the crew was EVER OWED on this job (the
  // earning's immutable original_amount — a cancellation-fee job only ever
  // paid the crew their fee share, never vendor_cost) minus what earlier
  // refunds already clawed. Two "full crew cut" overrides can never
  // recover the crew's pay twice (review findings, 2026-07-23).
  const { data: earningRow } = await admin
    .from("payouts").select("id, amount, original_amount, status, batch_id")
    .eq("job_id", job.id).eq("kind", "earning").maybeSingle();
  const everOwed = Number(earningRow?.original_amount ?? earningRow?.amount ?? 0);
  const clawable = Math.max(0, Math.round((everOwed - alreadyClawed) * 100) / 100);
  const clawback = input.clawback == null
    ? Math.min(clawable, defaultClawback(amount, Number(job.customer_price ?? 0), Number(job.vendor_cost ?? 0)))
    : clampClawback(Number(input.clawback), clawable);

  // THE CLAIM — insert first, re-check totals after, self-delete on a lost
  // race. The ledger is the lock; the processor is only called for a claim
  // that survived. The idempotency key makes a double-submitted action
  // (timeout + retry) land exactly once.
  const { data: claim, error: insErr } = await admin
    .from("refunds")
    .insert({
      invoice_id: invoice.id, job_id: job.id, amount, crew_clawback: clawback,
      reason, created_by: ops.id, idempotency_key: input.idempotencyKey ?? null,
    })
    .select("id")
    .single();
  if (insErr || !claim) {
    if (insErr && /duplicate|unique/i.test(insErr.message)) {
      return { ok: false, error: "This refund was already submitted — refresh to see it." };
    }
    return { ok: false, error: insErr?.message ?? "Couldn't record the refund." };
  }

  const { data: afterRows } = await admin
    .from("refunds").select("id, amount, crew_clawback").eq("invoice_id", invoice.id);
  const totalAfter = (afterRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  if (totalAfter > captured + 0.001) {
    await admin.from("refunds").delete().eq("id", claim.id);
    return { ok: false, error: "Another refund landed first — refresh and re-check the remaining balance." };
  }
  // Same ledger-lock for the CLAWBACK band: if concurrent claims jointly
  // over-claw what the crew was ever owed, shrink THIS row's clawback to
  // the honest remainder (the ledger stays the source of truth).
  let effectiveClawback = clawback;
  const clawedByOthers = (afterRows ?? [])
    .filter((r) => r.id !== claim.id)
    .reduce((s, r) => s + Number(r.crew_clawback ?? 0), 0);
  const remainder = Math.max(0, Math.round((everOwed - clawedByOthers) * 100) / 100);
  if (clawback > remainder) {
    effectiveClawback = remainder;
    await admin.from("refunds").update({ crew_clawback: effectiveClawback }).eq("id", claim.id);
  }

  // Processor (mock today; the real adapter slots in behind the same shape).
  const res = await LakeLifePayments.refund({
    chargeRef: (payment.processor_ref as string) ?? "",
    amountCents: Math.round(amount * 100),
  });
  if (!res.ok) {
    await admin.from("refunds").delete().eq("id", claim.id);
    return { ok: false, error: res.error ?? "The processor refused the refund." };
  }
  await admin.from("refunds").update({ processor_ref: res.ref ?? null }).eq("id", claim.id);

  // Crew clawback per plan (ToS §7.6). Conservation rule: reduction-applied
  // plus adjustment-inserted must equal effectiveClawback EXACTLY. The
  // reduce is a compare-and-set on the snapshot amount — a concurrent
  // refund or batch claim that moved the row makes the CAS miss, and the
  // whole planned reduction converts into an adjustment instead of a stale
  // absolute write clobbering someone else's clawback (review findings).
  let clawbackWarning: string | undefined;
  if (effectiveClawback > 0 && job.vendor_id) {
    const { data: payoutRow } = await admin
      .from("payouts").select("id, amount, status, batch_id")
      .eq("job_id", job.id).eq("kind", "earning").maybeSingle();
    const snapshot: PayoutSnapshot | null = payoutRow
      ? { id: payoutRow.id as string, amount: Number(payoutRow.amount ?? 0), status: payoutRow.status as string, batchId: (payoutRow.batch_id as string) ?? null }
      : null;
    const plan = planClawback(effectiveClawback, snapshot);
    let adjustMagnitude = plan.mode === "adjust" || plan.mode === "reduce_and_adjust"
      ? -plan.adjustmentAmount // stored negative; magnitude here
      : 0;
    if (plan.mode === "reduce" || plan.mode === "reduce_and_adjust") {
      const plannedReduction = Math.round(((snapshot?.amount ?? 0) - plan.newAmount) * 100) / 100;
      const { data: reduced } = await admin.from("payouts")
        .update({ amount: plan.newAmount, status: plan.newStatus })
        .eq("id", plan.payoutId)
        .eq("amount", snapshot?.amount ?? -1) // CAS: only the exact row we planned against
        .eq("status", "released").is("batch_id", null)
        .select("id");
      if (!reduced || reduced.length === 0) {
        // The row moved (batch claim or concurrent refund) — recover the
        // whole planned reduction forward as an adjustment.
        adjustMagnitude = Math.round((adjustMagnitude + plannedReduction) * 100) / 100;
      }
    }
    if (adjustMagnitude > 0) {
      const { error: adjErr } = await admin.from("payouts").insert({
        vendor_id: job.vendor_id, job_id: job.id, kind: "adjustment",
        amount: -adjustMagnitude,
        status: "released",
      });
      if (adjErr) {
        // The refund already went out — never fail silently on the recovery
        // half. Surface it loudly to ops for a manual fix.
        console.error(`[refund ${claim.id}] adjustment insert failed:`, adjErr.message);
        clawbackWarning = `Refund sent, but the crew adjustment of $${adjustMagnitude.toFixed(2)} FAILED to record — fix manually (refund ${claim.id}).`;
        try {
          const { data: opsUsers } = await admin.from("users").select("phone").eq("role", "ops").not("phone", "is", null).limit(3);
          for (const o of opsUsers ?? []) void sendSms(o.phone as string, `LakeLife OPS: ${clawbackWarning}`);
        } catch { /* best effort */ }
      }
    }
  }

  // Referral unwind + invoice flip, decided from DURABLE rows only — a
  // concurrent claim that later fails its processor call and self-deletes
  // must not have flipped the invoice or voided referrals on its way down
  // (review finding). Durable = a refund the processor actually honored.
  const { data: durableRows } = await admin
    .from("refunds").select("amount").eq("invoice_id", invoice.id).not("processor_ref", "is", null);
  const durableTotal = (durableRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const isFull = invoiceStatusAfter(captured, durableTotal) === "refunded";
  if (isFull) {
    await admin.from("referral_earnings")
      .update({ status: "void" })
      .eq("source_job", job.id)
      .eq("status", "accrued");
    await admin.from("invoices").update({ status: "refunded" }).eq("id", invoice.id);
  }

  // Both sides hear about it — the crew never sees the customer amount.
  const svcName = ((Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string } | null)?.name ?? "service";
  const prop = (Array.isArray(job.properties) ? job.properties[0] : job.properties) as { address?: string; users?: unknown } | null;
  const owner = (Array.isArray(prop?.users) ? (prop?.users as unknown[])[0] : prop?.users) as { phone?: string; email?: string } | null;
  try {
    if (owner?.phone) {
      void sendSms(owner.phone, `LakeLife: $${amount.toFixed(2)} for your ${svcName} is on its way back to your card — allow a few business days. 🌊`);
    }
    if (owner?.email) {
      void sendEmail({
        to: owner.email,
        subject: `Refund issued — $${amount.toFixed(2)}`,
        html: `<p>We've sent <b>$${amount.toFixed(2)}</b> back to your card for your ${svcName}.</p><p>Reason: ${reason.replace(/</g, "&lt;")}</p><p>Refunds usually land within a few business days. Questions? Just reply. 🌊</p>`,
      });
    }
    if (effectiveClawback > 0 && job.vendor_id) {
      const { data: v } = await admin.from("vendors").select("user_id").eq("id", job.vendor_id).maybeSingle();
      const { data: vu } = v?.user_id
        ? await admin.from("users").select("phone").eq("id", v.user_id as string).maybeSingle()
        : { data: null };
      if (vu?.phone) {
        void sendSms(vu.phone as string, `LakeLife: a customer refund on your ${svcName} job adjusted your pay by −$${effectiveClawback.toFixed(2)} per the service terms. Details in Earnings. Reply here with questions.`);
      }
    }
  } catch { /* notifications are best effort — the money moves regardless */ }

  return { ok: true, refunded: amount, clawback: effectiveClawback, ...(clawbackWarning ? { error: clawbackWarning } : {}) };
}
