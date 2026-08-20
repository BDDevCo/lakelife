"use server";

import { revalidatePath } from "next/cache";
import { assertOps } from "@/app/ops/data";
import { opsResolveEscalated } from "@/lib/disputes";

/**
 * The human's exit for escalated Make-It-Right disputes (Autonomy Ladder —
 * escalations are the ONE place a person decides). Two buttons on the ops
 * card post here: refund the customer (held-aware clawback, remainder
 * releases to the crew) or close in the crew's favor (hold releases).
 * Without this, an escalation strands the crew's held pay forever (review
 * finding, 2026-07-23).
 */
/**
 * The result the card renders. This used to be `Promise<void>`: a failure
 * logged to a server console nobody reads, the page revalidated, and the same
 * card came back unchanged — so the honest response was to tap it again, on
 * the button that refunds a customer and releases a crew's frozen pay.
 */
export interface EscalationResult {
  ok: boolean;
  message: string;
}

export async function resolveEscalationAction(
  _prev: EscalationResult | null,
  formData: FormData,
): Promise<EscalationResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, message: "You're not signed in as ops any more — sign in again." };
  const disputeId = String(formData.get("disputeId") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  if (!disputeId || (outcome !== "refund" && outcome !== "close")) {
    return { ok: false, message: "That didn't come through — try again." };
  }
  const res = await opsResolveEscalated(disputeId, outcome, ops.id);
  if (!res.ok) {
    console.error(`[resolveEscalation ${disputeId}] ${outcome} failed: ${res.error}`);
    // The crew's pay is still frozen and the customer still has no refund.
    // Saying so is the whole point — silence here reads as success.
    return { ok: false, message: res.error ?? "That didn't go through — nothing has changed." };
  }
  revalidatePath("/ops");
  return {
    ok: true,
    message: outcome === "refund"
      ? "Refunded. The crew's remainder has been released."
      : "Closed in the crew's favour. Their pay has been released.",
  };
}
