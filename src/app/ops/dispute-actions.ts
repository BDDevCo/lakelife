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
export async function resolveEscalationAction(formData: FormData): Promise<void> {
  const ops = await assertOps();
  if (!ops) return;
  const disputeId = String(formData.get("disputeId") ?? "");
  const outcome = String(formData.get("outcome") ?? "");
  if (!disputeId || (outcome !== "refund" && outcome !== "close")) return;
  const res = await opsResolveEscalated(disputeId, outcome, ops.id);
  if (!res.ok) console.error(`[resolveEscalation ${disputeId}] ${outcome} failed: ${res.error}`);
  revalidatePath("/ops");
}
