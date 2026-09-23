"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { autoAssignJob } from "@/app/book/dispatch";
import { assertOps } from "./data";
import { readFailedMessage } from "@/lib/must-read";
import { NO_FIT_LABEL } from "@/lib/dispatch";

export interface RetryResult {
  ok: boolean;
  assigned: boolean;
  error?: string;
  /**
   * WHY NOT, IN WORDS, when the engine found nobody.
   *
   * THIS IS THE ONE DOORWAY WHERE A PERSON ASKS DISPATCH A QUESTION AND THE
   * ENGINE ANSWERS LIVE — and it used to throw the answer away. `outcome` has
   * carried `decision.reasonNoFit` all along; this returned `{ ok, assigned }`
   * and the button's toast then said "Still no crew fits — recruit one for
   * this lake" for ALL EIGHT reasons. Three of them make that advice actively
   * wrong: `all_full_or_blocked` is a full calendar (recruiting changes
   * nothing today), `no_qualifying_rate` is a crew who is already on the lake
   * and has not priced the work, and a price hold is a crew who is there and
   * would charge a different number. Ops was sent recruiting in all three.
   */
  whyNot?: string;
}

/**
 * Re-run the auto-dispatch engine for one stuck job (ops only). Same code path
 * the nightly self-heal uses — the machine picks the crew; this just runs it
 * early. Returns whether a crew was found and applied, and when it wasn't, the
 * engine's own reason in the shared words (lib/dispatch NO_FIT_LABEL).
 */
export async function retryAssign(jobId: string): Promise<RetryResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, assigned: false, error: "Ops only." };
  if (!jobId) return { ok: false, assigned: false, error: "No job selected." };

  try {
    const outcome = await autoAssignJob(jobId);
    if (outcome.assigned) return { ok: true, assigned: true };
    const code = outcome.decision?.reasonNoFit;
    const whyNot = outcome.priceHeld
      ? "A crew is available but their rate isn't the price this customer agreed to — that's a price conversation, not a recruiting one"
      : outcome.pricedToZero
        ? "Every crew's rate card prices this property at nothing — there is no job here to quote"
        : code
          ? NO_FIT_LABEL[code]
          // The engine really does return no reason sometimes: autoAssignJob
          // skips a job whose own read failed, deliberately refusing to guess.
          // Saying "recruit somebody" over that would be the guess.
          : "Dispatch ran and couldn't say why nobody fits — try again, and check the job's own record";
    return { ok: true, assigned: false, whyNot };
  } catch (e) {
    return { ok: false, assigned: false, error: e instanceof Error ? e.message : "Couldn't run dispatch." };
  }
}

export interface PreferredResult {
  ok: boolean;
  error?: string;
}

/**
 * Set (or clear, with vendorId null) a property's preferred crew (ops only).
 * A preferred crew gets first right of refusal at dispatch, so we only allow an
 * active crew that actually does at least one service (has a private rate on
 * file, or lists service types). Clearing needs no vendor validation.
 */
export async function setPreferredCrew(propertyId: string, vendorId: string | null): Promise<PreferredResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!propertyId) return { ok: false, error: "No property selected." };

  const admin = createServiceClient();

  if (vendorId) {
    const vendorRes = await admin
      .from("vendors")
      .select("id, status, service_types")
      .eq("id", vendorId)
      .maybeSingle();
    // "That crew doesn't exist" is a statement about the roster. A failed read
    // arrives as the same `data: null` and knows nothing of the sort — and ops
    // would go looking for a crew row that is sitting there fine.
    if (vendorRes.error) return { ok: false, error: readFailedMessage("that crew", vendorRes.error) };
    const vendor = vendorRes.data;
    if (!vendor) return { ok: false, error: "That crew doesn't exist." };
    if (vendor.status !== "active") return { ok: false, error: "Only an active crew can be a preferred crew." };

    // "Does at least one service" — a private rate set, or listed service types.
    const rateRes = await admin
      .from("vendor_rates")
      .select("id", { count: "exact", head: true })
      .eq("vendor_id", vendorId);
    // An errored count is null, which reduces the test below to "no rates" and
    // refuses a crew who may have a full rate card — telling ops to go and set
    // something that is already set.
    if (rateRes.error) return { ok: false, error: readFailedMessage("that crew's rates", rateRes.error) };
    const rateCount = rateRes.count;
    const listsService = ((vendor.service_types as string[] | null) ?? []).length > 0;
    if (!(rateCount && rateCount > 0) && !listsService) {
      return { ok: false, error: "That crew doesn't do any service yet — set a rate or service type first." };
    }
  }

  const { error } = await admin
    .from("properties")
    .update({ preferred_vendor: vendorId })
    .eq("id", propertyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
