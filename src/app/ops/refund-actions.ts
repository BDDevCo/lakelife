"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "@/app/ops/data";
import { refundableRemaining, defaultClawback } from "@/lib/refunds";
import { executeRefund, type RefundResult } from "@/lib/refund-core";
// NOTE no `export type` re-exports from a "use server" module — the server
// actions loader re-exports every name as a VALUE and crashes at runtime
// (proof run, 2026-07-24). Import RefundResult from @/lib/refund-core.

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
  return executeRefund({ ...input, createdBy: ops.id });
}
