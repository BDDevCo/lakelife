"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { autoAssignJob } from "@/app/book/dispatch";
import { computeScarcityOffer } from "./offer-data";

/**
 * Customer ACCEPTS a scarcity offer (Phase C, ladder rung 3): bump the job's
 * all-in price to the machine-computed level that clears the margin floor,
 * then immediately re-run auto-dispatch. Everything is recomputed server-side
 * at accept time (never trust the number the browser saw — rates may have
 * moved). If the assignment STILL doesn't land, the price is reverted — the
 * customer is never left paying more with nothing locked in. Nothing is
 * charged here; charging happens at completion as always.
 */

export interface OfferResult {
  ok: boolean;
  error?: string;
  newPrice?: number;
}

export async function acceptScarcityOffer(jobId: string): Promise<OfferResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  if (!jobId) return { ok: false, error: "No request selected." };

  // Ownership: the job's property must belong to the signed-in user.
  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, customer_price, properties(owner_id)")
    .eq("id", jobId)
    .maybeSingle();
  const owner = (Array.isArray(job?.properties) ? job?.properties[0] : job?.properties) as { owner_id?: string } | null;
  if (!job || owner?.owner_id !== user.id) return { ok: false, error: "That request isn't yours." };

  // Recompute the offer NOW — the authoritative number.
  const offer = await computeScarcityOffer(jobId);
  if (!offer) return { ok: false, error: "This request no longer needs a boost — check its status." };

  const oldPrice = Number(job.customer_price ?? 0);

  // Apply the bump only while the job is still unassigned (guarded, race-safe).
  const { data: bumped } = await admin
    .from("jobs")
    .update({ customer_price: offer.newPrice })
    .eq("id", jobId)
    .eq("status", "requested")
    .is("vendor_id", null)
    .select("id");
  if (!bumped || bumped.length === 0) return { ok: false, error: "A crew just picked this up — no boost needed. 🌊" };

  const r = await autoAssignJob(jobId);
  if (!r.assigned) {
    // Never leave the customer at a higher price with nothing locked in.
    await admin.from("jobs").update({ customer_price: oldPrice }).eq("id", jobId).eq("status", "requested").is("vendor_id", null);
    return { ok: false, error: "Couldn't lock a crew in just now — your price is unchanged. Try again shortly." };
  }
  return { ok: true, newPrice: offer.newPrice };
}
