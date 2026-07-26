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

/**
 * WHICH DISPUTE STATES EACH CUSTOMER ANSWER MAY ACT ON.
 *
 * Accepting is always allowed — a customer may call it settled at any point,
 * including while the crew is still deciding or already booked to come back.
 * Ending early in the crew's favour costs nobody anything.
 *
 * ESCALATING ("still not right") is the one that moves money: it fires the
 * policy engine, which can refund the customer and claw back the crew's pay.
 * It is allowed ONLY after the crew has actually had its turn — they stood by
 * the work ('verifying') or opened a conversation ('talk'). That is the
 * right-to-cure (ToS §11.5), and it is the whole point of the ladder.
 *
 * The SMS door used to enforce this by construction: the customer only ever
 * RECEIVES their token in the text that crewChooseVerify/crewChooseTalk sends,
 * so during 'crew_review' the token was not in their hands. The in-portal door
 * resolves the token server-side, which removes that structural gate — so the
 * rule has to be stated here and enforced in the action, not in the JSX that
 * decides whether to draw a button (review finding, 2026-07-26).
 */
export const DISPUTE_ACCEPTABLE_STATUSES = ["crew_review", "fixing", "verifying", "talk"] as const;
export const DISPUTE_ESCALATABLE_STATUSES = ["verifying", "talk"] as const;

/** May this customer answer act on a dispute in this state? */
export function customerMayAnswer(status: string, answer: "resolved" | "still"): boolean {
  const allowed: readonly string[] =
    answer === "still" ? DISPUTE_ESCALATABLE_STATUSES : DISPUTE_ACCEPTABLE_STATUSES;
  return allowed.includes(status);
}
