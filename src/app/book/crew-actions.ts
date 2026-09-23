"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { assertMyPark } from "@/app/park/data";
import { groundsFor } from "@/app/park/rate-data";
import { buildCrewOffers, type CrewOffersResult } from "./crew-offers";
import { createBooking, type BookingResult } from "./actions";

/**
 * THE ONLY DOOR TO THE OFFERS BUILDER — and the only place that asks who is
 * looking.
 *
 * `buildCrewOffers` reads with the service role and asks nothing about the
 * viewer, exactly like every other dispatch loader. That is safe only while
 * every caller proves ownership FIRST, so there is one caller and this is it.
 *
 * A PARK IS A CUSTOMER LIKE ANY OTHER (0176). The same screen serves a
 * homeowner and a park owner: a homeowner owns the property outright, a park
 * owner administers the park whose grounds that property IS. Two doorways, one
 * check — written here once rather than copied into the page and the action.
 */
async function mayUseProperty(propertyId: string): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const admin = createServiceClient();
  const propRes = await admin.from("properties").select("id, owner_id").eq("id", propertyId).maybeSingle();
  // A FAILED READ IS NOT "NOT YOURS". Unread, owner_id is null, the comparison
  // below fails, and somebody is told their own house isn't theirs.
  if (propRes.error) return { ok: false, error: readFailedMessage("your property", propRes.error) };
  if (!propRes.data) return { ok: false, error: "We couldn't find that property." };
  if (propRes.data.owner_id === user.id) return { ok: true, userId: user.id };

  // THE PARK DOOR. `groundsFor` throws on a failed read rather than answering
  // "not a park", so a dropped read cannot quietly refuse a park owner.
  let grounds: { parkId: string } | null = null;
  try {
    grounds = await groundsFor(propertyId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("whether that's your park's grounds", e) };
  }
  if (grounds && (await assertMyPark(grounds.parkId))) return { ok: true, userId: user.id };

  return { ok: false, error: "That property isn't yours." };
}

/**
 * EVERY OPTION, FOR THIS PROPERTY, THIS SERVICE, THIS DAY.
 *
 * Returns only what the screen draws per crew — name, the customer's price,
 * the days they work, standing (when he has switched it on), and whether this
 * is the crew the viewer brought. Never a crew's own quote, never the fee
 * split, never another crew's card.
 */
export async function loadCrewOffers(
  propertyId: string,
  serviceId: string,
  dateISO: string,
): Promise<CrewOffersResult> {
  const allowed = await mayUseProperty(propertyId);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO ?? "")) return { ok: false, error: "Pick a date first." };
  try {
    // THE VIEWER TRAVELS WITH THE REQUEST, for one reason: the builder refuses
    // to show crew prices to a crew. See the derivation note in crew-offers.ts
    // — a buyer who is also a contractor can recover a rival's whole rate card
    // from prices alone, because they own the inputs those prices are computed
    // from.
    return await buildCrewOffers({ propertyId, serviceId, dateISO, viewerUserId: allowed.userId });
  } catch (e) {
    // The loaders inside throw on a failed read ON PURPOSE (mustRead), because
    // an empty crew list renders as a confident "nobody can do this". Landing
    // it here keeps that promise and still gives the screen something to draw.
    return { ok: false, error: readFailedMessage("the crews who could take this", e) };
  }
}

/**
 * BOOK IT WITH THE CREW THEY PICKED.
 *
 * A thin wrapper over `createBooking` — the same validation, the same rule-5
 * gate, the same agreement gate, the same pricing — with the customer's choice
 * carried through to `jobs.chosen_vendor_id`, which the router then honours
 * (see decideDispatch, 0178). Re-implementing any part of booking here would
 * be a second doorway with its own idea of the rules, and this codebase has
 * paid for that shape repeatedly.
 *
 * THE PICK IS VALIDATED BY THE ENGINE, NOT HERE. If that crew's day filled
 * between the screen and the tap, dispatch answers `chosen_crew_unavailable`
 * and the booking is refused by name — never handed to a different crew at a
 * different price.
 */
/**
 * ASK FOR IT ANYWAY — the empty state's own door, not a link to somewhere else.
 *
 * "if any" is load-bearing on this screen: with nobody to choose between, the
 * honest thing is to take the dated request, and that request is how the
 * platform learns where to go recruiting. The screen used to point at
 * `/requests` for this, which is the VISITS LIST — it has no request door on
 * it at all, so the one call to action in the empty state was a dead end.
 *
 * The same wrapper shape as `bookWithChosenCrew` and for the same reason: one
 * booking doorway, one set of rules. With no crew found the job stays a
 * "Finding a crew" row, exactly as a request from the booking page does.
 */
export async function askForItAnyway(
  serviceId: string,
  dateISO: string,
  frequency: string,
  tosAccepted?: boolean,
): Promise<BookingResult> {
  return createBooking(serviceId, dateISO, frequency, undefined, tosAccepted, undefined, null);
}

export async function bookWithChosenCrew(
  serviceId: string,
  dateISO: string,
  frequency: string,
  vendorId: string,
  tosAccepted?: boolean,
): Promise<BookingResult> {
  if (!vendorId) return { ok: false, error: "Pick a crew first." };
  return createBooking(serviceId, dateISO, frequency, undefined, tosAccepted, undefined, vendorId);
}
