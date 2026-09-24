"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ReadFailed, readFailedMessage } from "@/lib/must-read";
import { getMyVendorId } from "./data";
import { setDailyCapacity, setServiceLakes } from "./onboarding-actions";
import { setMyRate } from "./rates-actions";
import type { RatePayload } from "./rates-helpers";
import { cleanWorkDays } from "@/lib/crew-setup";

/**
 * THE CREW SAYS YES — AND THAT TAP IS WHAT MAKES ANY OF IT TRUE.
 *
 * Ops types a crew's details down the phone (0181, app/ops/crews-invite.ts) and
 * NOTHING they type lands on a column the product reads. It sits in
 * `crew_setup_proposals` until this action runs, and this action runs only for
 * the crew themselves. If they change nothing, their tap is still the act.
 *
 * ============ IT REUSES THE DOORS, IT DOES NOT REBUILD THEM ============
 *
 * Every write below goes through the action the crew's own screens already
 * call — `setServiceLakes`, `setDailyCapacity`, `setMyRate` — rather than
 * writing the columns directly. Those actions carry rules that are invisible
 * from here and would have been silently dropped by a second copy:
 *
 *   setServiceLakes refuses a lake this crew is COOLING DOWN off (0124 +
 *   lake-standing), and fences fixture lakes out of the column entirely.
 *   setDailyCapacity holds the 1–20 band `approveCrew` and `assertRoutable`
 *   both depend on.
 *   setMyRate re-derives the pricing STRUCTURE from the authoritative service
 *   row, so only the crew's dollars ever reach `vendor_rates`.
 *
 * A confirmation screen that wrote `vendors.service_lakes` itself would be the
 * fourth doorway with three of those rules missing.
 *
 * ============ AND IT DOES NOT SETTLE ON A PARTIAL APPLY ============
 *
 * If any piece fails, the proposal stays open. What saved is saved, the card
 * comes back with the rest still in it, and the crew is told exactly which
 * line did not take. Settling a half-applied setup would remove the only
 * screen that knows anything is missing, and leave a crew who believes they
 * are set up sitting behind gaps they cannot see.
 */

export interface SetupResult {
  ok: boolean;
  error?: string;
  /** Saved, but not all of it — the card stays and names what is left. */
  partial?: string[];
}

export interface ConfirmSetupInput {
  /** The proposal the crew was actually looking at. */
  proposalId: string;
  lakeIds: string[];
  workDays: string[];
  dailyCapacity: number | string | null;
  rates: Array<{ serviceId: string; payload: RatePayload }>;
}

/** The signed-in crew's own vendor id and user id, or a sentence saying why not. */
async function meAndMyCrew(): Promise<
  { ok: true; userId: string; vendorId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // getMyVendorId THROWS on a failed read rather than answer "you are not a
  // crew". A rejection out of a "use server" action is a blank failure on a
  // phone, so it becomes a sentence here. Nothing is written at this point.
  let vendorId: string | null = null;
  try {
    vendorId = await getMyVendorId();
  } catch (e) {
    if (e instanceof ReadFailed) return { ok: false, error: readFailedMessage("your crew account", e) };
    throw e;
  }
  if (!vendorId) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  return { ok: true, userId: user.id, vendorId };
}

/**
 * Find the open proposal for the SESSION's own crew, and check it is the one
 * the screen was showing.
 *
 * THE ID IS A STALENESS CHECK, NEVER A LOOKUP KEY. This file is "use server",
 * so both exports here are public endpoints and `proposalId` arrived from a
 * browser. The row is found by the vendor id derived from the session; the
 * argument only has to AGREE with it. Looking a proposal up by its id would let
 * anyone signed in settle somebody else's — 0181's trigger would still refuse
 * the write, but the refusal would be a raw Postgres string on a stranger's
 * screen rather than a door that was never open.
 */
async function openProposalFor(
  vendorId: string,
  proposalId: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const admin = createServiceClient();
  const res = await admin
    .from("crew_setup_proposals")
    .select("id")
    .eq("vendor_id", vendorId)
    .is("settled_at", null)
    .maybeSingle();
  // "There's nothing waiting for you" is a claim about their account, and a
  // dropped read has no standing to make it — they would go and type it all in
  // again by hand.
  if (res.error) return { ok: false, error: readFailedMessage("the setup waiting for you", res.error) };
  if (!res.data) {
    return { ok: false, error: "That setup has already been dealt with. Pull the page down to refresh." };
  }
  if ((res.data.id as string) !== proposalId) {
    return { ok: false, error: "This was changed since you opened it — refresh the page and have another look." };
  }
  return { ok: true, id: res.data.id as string };
}

export async function confirmMySetup(input: ConfirmSetupInput): Promise<SetupResult> {
  const me = await meAndMyCrew();
  if (!me.ok) return { ok: false, error: me.error };

  const found = await openProposalFor(me.vendorId, (input?.proposalId ?? "").trim());
  if (!found.ok) return { ok: false, error: found.error };

  const left: string[] = [];

  // LAKES FIRST, because it is the one whose failure is otherwise silent: a
  // crew with no lakes is simply never offered anything, on any water, forever.
  const lakeIds = Array.isArray(input.lakeIds) ? input.lakeIds : [];
  if (lakeIds.length > 0) {
    const r = await setServiceLakes(lakeIds);
    if (!r.ok) left.push(r.error ?? "your lakes");
  }

  const cap = input.dailyCapacity;
  if (cap != null && cap !== "") {
    const r = await setDailyCapacity(Number(cap));
    if (!r.ok) left.push(r.error ?? "how many jobs a day you take");
  }

  // WORK DAYS ARE WRITTEN HERE because there is no "set the whole week" action
  // — the crew's own screen toggles one chip at a time. `cleanWorkDays` is the
  // same whitelist that screen now uses: a day stored in any other spelling is
  // a day `isEligible` can never match, so the crew looks available and is
  // never offered the work.
  const days = cleanWorkDays(input.workDays);
  if (days.length > 0) {
    const admin = createServiceClient();
    const { error } = await admin.from("vendors").update({ work_days: days }).eq("id", me.vendorId);
    if (error) left.push("the days you work");
  }

  // THE RATES, THROUGH THE CREW'S OWN RATE DOOR. Each one is theirs from the
  // moment it saves — there is no record anywhere of what was proposed versus
  // what they set, and there is not meant to be. His words: "we are not setting
  // anypricing."
  for (const r of input.rates ?? []) {
    if (!r || typeof r.serviceId !== "string" || !r.serviceId) continue;
    const res = await setMyRate(r.serviceId, r.payload ?? {});
    if (!res.ok) left.push(res.error ?? "one of your rates");
  }

  if (left.length > 0) {
    // NOT SETTLED. The card stays, holding everything that did land, and names
    // what did not. De-duplicated because three rates failing for one reason is
    // one thing to fix, not three.
    return { ok: false, partial: [...new Set(left)], error: "Most of that saved. A couple of things didn't:" };
  }

  const admin = createServiceClient();
  const { error } = await admin
    .from("crew_setup_proposals")
    .update({ settled_at: new Date().toISOString(), settled_as: "confirmed", settled_by: me.userId })
    .eq("id", found.id)
    .is("settled_at", null);
  if (error) {
    // EVERYTHING IS SAVED — only the bookkeeping failed, and telling them
    // otherwise would send them round the whole card again. The card will still
    // be there on the next load, now showing their own confirmed values, and
    // confirming a second time is harmless: every write above is idempotent.
    console.error("[write failed] settling the setup proposal for vendor", me.vendorId, error);
    return { ok: true };
  }
  return { ok: true };
}

/**
 * "I'll do it myself." Writes NOTHING to `vendors` or `vendor_rates` — it only
 * closes the card, and the ordinary six-card wizard is what they get.
 *
 * THIS IS NOT A REJECTION OF ANYTHING. Ops typed notes from a phone call; the
 * crew is allowed to say they would rather fill it in. Nobody is told, no
 * report counts it, and nothing measures a decline against a confirmation.
 */
export async function declineMySetup(proposalId: string): Promise<SetupResult> {
  const me = await meAndMyCrew();
  if (!me.ok) return { ok: false, error: me.error };

  const found = await openProposalFor(me.vendorId, (proposalId ?? "").trim());
  if (!found.ok) return { ok: false, error: found.error };

  const admin = createServiceClient();
  const { error } = await admin
    .from("crew_setup_proposals")
    .update({ settled_at: new Date().toISOString(), settled_as: "declined", settled_by: me.userId })
    .eq("id", found.id)
    .is("settled_at", null);
  if (error) return { ok: false, error: "Couldn't put that away just now — try again in a moment." };
  return { ok: true };
}
