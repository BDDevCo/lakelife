/**
 * Pure dispute policy (Autonomy Ladder) — testable without a server.
 * The machine's decision when a cure fails or the crew goes silent:
 * small verified-charge disputes refund themselves; big ones escalate
 * with the answer pre-computed. No captured cash = nothing to auto-refund
 * (charge-on-completion means most bad days never involve money at all).
 */

export type PolicyDecision = "auto_refund" | "escalate";

export function decideDisputeOutcome(input: {
  capturedCash: number; // 0 = never charged / charge failed
  customerPrice: number;
  autoRefundMax: number; // dispute_auto_refund_max dial
  priorDisputesByCustomer: number; // resolved_refunded count, trailing year
}): PolicyDecision {
  if (!(input.capturedCash > 0)) return "escalate";
  if (input.customerPrice > input.autoRefundMax) return "escalate";
  // A pattern of refunded disputes is a fraud smell — humans look at #3+.
  if (input.priorDisputesByCustomer >= 2) return "escalate";
  return "auto_refund";
}

/** Hours until a silent crew forfeits their cure window. */
export function respondByFrom(nowMs: number, responseHours: number): string {
  return new Date(nowMs + Math.max(1, responseHours) * 3_600_000).toISOString();
}
