/**
 * Refund math (docs/refunds-design.md) — PURE, no I/O, fully unit-testable.
 * The ops action loads the rows and applies the plan; every dollar decision
 * lives here so it can be tested in isolation, same pattern as dispatch.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How much cash can still go back on this invoice: what was actually
 * captured minus what's already been refunded. Credits the customer spent
 * are NOT cash and are never refunded here (v1 — ops re-grants manually).
 */
export function refundableRemaining(capturedCash: number, alreadyRefunded: number): number {
  return round2(Math.max(0, capturedCash - Math.max(0, alreadyRefunded)));
}

/**
 * Default crew clawback: the refund's proportional share of the crew's cut,
 * clamped to what the crew was owed. Ops can override (crew-fault refunds
 * may claw more, goodwill refunds zero) — but never above vendorCost and
 * never negative. Rule-1 note: this math uses ops-side numbers only; the
 * crew is shown ONLY their own adjustment, never the customer refund.
 */
export function defaultClawback(refundAmount: number, customerPrice: number, vendorCost: number): number {
  if (!(refundAmount > 0) || !(customerPrice > 0) || !(vendorCost > 0)) return 0;
  return round2(Math.min(vendorCost, refundAmount * (vendorCost / customerPrice)));
}

/** Clamp an ops-chosen clawback into the legal band [0, vendorCost]. */
export function clampClawback(requested: number, vendorCost: number): number {
  if (!Number.isFinite(requested)) return 0;
  return round2(Math.min(Math.max(0, requested), Math.max(0, vendorCost)));
}

export interface PayoutSnapshot {
  id: string;
  amount: number;
  status: string; // 'released' | 'paid' | ... (batch membership is what matters)
  batchId: string | null;
}

export type ClawbackPlan =
  | { mode: "none" }
  | { mode: "reduce"; payoutId: string; newAmount: number; newStatus: "released" | "held" | "clawed" }
  | { mode: "adjust"; adjustmentAmount: number } // negative row, nets against next batch (ToS §7.6)
  | { mode: "reduce_and_adjust"; payoutId: string; newAmount: 0; newStatus: "clawed"; adjustmentAmount: number };

/**
 * Decide HOW to recover the clawback from the crew:
 * - earning payout still loose (unbatched, released OR HELD) → reduce it
 *   in place; a held remainder STAYS held (the dispute that froze it still
 *   owns its release); reduced to zero it flips to 'clawed' so batches
 *   skip an empty row. Treating a held row as untouchable would insert an
 *   adjustment while the full held earning survives — the crew loses the
 *   clawback twice the moment the hold releases (review finding).
 * - already batched/paid → a negative 'adjustment' payout that the next
 *   batch nets automatically.
 * - loose but smaller than the clawback (prior partial reductions) →
 *   drain it AND adjust for the remainder.
 * No payout at all (job never settled a payout — shouldn't happen for a
 * paid invoice, but fail safe) → adjustment for the full clawback.
 */
export function planClawback(clawback: number, payout: PayoutSnapshot | null): ClawbackPlan {
  const c = round2(clawback);
  if (!(c > 0)) return { mode: "none" };
  const loose = payout != null && payout.batchId == null && (payout.status === "released" || payout.status === "held");
  if (!payout || !loose) {
    return { mode: "adjust", adjustmentAmount: -c };
  }
  const available = round2(Math.max(0, payout.amount));
  if (available >= c) {
    const newAmount = round2(available - c);
    return newAmount > 0
      ? { mode: "reduce", payoutId: payout.id, newAmount, newStatus: payout.status as "released" | "held" }
      : { mode: "reduce", payoutId: payout.id, newAmount: 0, newStatus: "clawed" };
  }
  // Drain what's loose, adjust the rest.
  const remainder = round2(c - available);
  return { mode: "reduce_and_adjust", payoutId: payout.id, newAmount: 0, newStatus: "clawed", adjustmentAmount: -remainder };
}

/** Full refund ⇒ invoice flips to 'refunded'; partial keeps 'paid'. */
export function invoiceStatusAfter(capturedCash: number, totalRefundedAfter: number): "paid" | "refunded" {
  return totalRefundedAfter >= capturedCash ? "refunded" : "paid";
}
