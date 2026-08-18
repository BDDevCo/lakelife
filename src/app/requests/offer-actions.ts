"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { autoAssignJob } from "@/app/book/dispatch";
import { computeScarcityOffer, type ScarcityOfferView } from "./offer-data";
import { ReadFailed, readFailedMessage } from "@/lib/must-read";

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
  const jobRes = await admin
    .from("jobs")
    .select("id, customer_price, properties(owner_id)")
    .eq("id", jobId)
    .maybeSingle();
  // A failed read is `data: null`, which lands in the same branch as somebody
  // else's job — so the owner of the request was told it wasn't theirs. Whose
  // it is was never read; say what actually happened.
  if (jobRes.error) return { ok: false, error: readFailedMessage("this request", jobRes.error, { money: true }) };
  const job = jobRes.data;
  const owner = (Array.isArray(job?.properties) ? job?.properties[0] : job?.properties) as { owner_id?: string } | null;
  if (!job || owner?.owner_id !== user.id) return { ok: false, error: "That request isn't yours." };

  // Recompute the offer NOW — the authoritative number. computeScarcityOffer
  // THROWS on a failed read rather than returning the null that would land in
  // the "no longer needs a boost" branch below — a statement about their
  // request we'd have no basis for. An action can't throw (its caller is a
  // button awaiting { ok, error }), so it becomes a sentence here instead.
  let offer: ScarcityOfferView | null;
  try {
    offer = await computeScarcityOffer(jobId);
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("this request", e, { money: true }) };
    throw e;
  }
  if (!offer) return { ok: false, error: "This request no longer needs a boost — check its status." };

  const oldPrice = Number(job.customer_price ?? 0);

  // Apply the bump only while the job is still unassigned (guarded, race-safe).
  const bumpRes = await admin
    .from("jobs")
    .update({ customer_price: offer.newPrice })
    .eq("id", jobId)
    .eq("status", "requested")
    .is("vendor_id", null)
    .select("id");
  // A failed update returns `data: null` too, and "a crew just picked this up"
  // is good news we'd be inventing — they'd stop waiting for one.
  if (bumpRes.error) return { ok: false, error: readFailedMessage("this request", bumpRes.error, { money: true }) };
  const bumped = bumpRes.data;
  if (!bumped || bumped.length === 0) return { ok: false, error: "A crew just picked this up — no boost needed. 🌊" };

  const r = await autoAssignJob(jobId);
  if (!r.assigned) {
    // Never leave the customer at a higher price with nothing locked in.
    await admin.from("jobs").update({ customer_price: oldPrice }).eq("id", jobId).eq("status", "requested").is("vendor_id", null);
    return { ok: false, error: "Couldn't lock a crew in just now — your price is unchanged. Try again shortly." };
  }
  return { ok: true, newPrice: offer.newPrice };
}
