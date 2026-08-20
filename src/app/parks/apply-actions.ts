"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import {
  isRealRange, lotFits, parkOpenFor, parseDaterange, quoteStay, toDaterange,
  type DateRange, type Lot, type RateCard, type Term, type UnitType,
} from "@/lib/parks";

/**
 * A renter applying for a lot. This is the ONLY renter-facing write in the
 * park module, and it deliberately creates nothing but an APPLICATION:
 * status 'applied' holds no dates, bills nothing, and commits nobody. The park
 * owner decides.
 *
 * No money moves here and no document is signed. Rent is a zero-margin
 * pass-through that must never enter the job/invoice pipeline — see the header
 * of migration 0052 for what breaks if it ever does.
 *
 * No screening, no score, no recommendation. Assembling a consumer report is
 * what makes a company a Consumer Reporting Agency under the FCRA, and we do
 * not do it.
 */

export interface ApplyResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

export interface ApplyInput {
  lotId: string;
  from: string;   // YYYY-MM-DD
  to: string;     // YYYY-MM-DD, exclusive (checkout morning)
  term: string;
  unitType: string;
  unitLengthFt: string;
  unitMake: string;
  unitModel: string;
  unitYear: string;
}

const UNIT_TYPES: UnitType[] = [
  "mobile_home", "park_model", "travel_trailer", "fifth_wheel", "motorhome", "rv",
];
const TERMS: Term[] = ["nightly", "weekly", "monthly", "seasonal", "annual"];

export async function applyForLot(input: ApplyInput): Promise<ApplyResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const range: DateRange = { start: input.from, end: input.to };
  if (!isRealRange(range)) {
    return { ok: false, error: "Check those dates — the leave date has to be after the arrival date." };
  }
  if (range.start < todayLakeDate()) {
    return { ok: false, error: "Pick an arrival date that hasn't already passed." };
  }
  if (!TERMS.includes(input.term as Term)) {
    return { ok: false, error: "Pick how you'd like to rent — by the night, week, month, season or year." };
  }
  if (!UNIT_TYPES.includes(input.unitType as UnitType)) {
    return { ok: false, error: "Tell us what you're bringing." };
  }

  const admin = createServiceClient();

  // --- the lot, its park, and whether either is even open to the public ---
  const lotRes = await admin
    .from("park_lots")
    .select("id, park_id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, active, lifecycle")
    .eq("id", input.lotId)
    .maybeSingle();
  // A READ THAT FAILED IS NOT A LOT THAT IS GONE. "That lot isn't available"
  // below is written for a retired lot, and it sends somebody looking for a
  // different site when the truth is that we could not look at all.
  if (lotRes.error) {
    return { ok: false, error: readFailedMessage("that lot", lotRes.error) };
  }
  const lotRow = lotRes.data;
  // Checked here as well as in the listing, because a lot can be retired
  // between the page loading and the form being sent — and because a link to a
  // lot can be kept, shared, or bookmarked. 0065's trigger would refuse this
  // at approval time with a raw database error; refusing it now costs the
  // renter a sentence instead of an application.
  if (!lotRow || !lotRow.active || (lotRow.lifecycle as string) !== "live") {
    return { ok: false, error: "That lot isn't available." };
  }

  const parkRes = await admin
    .from("parks")
    .select("id, slug, name, active, season_open_month, season_open_day, season_close_month, season_close_day")
    .eq("id", lotRow.park_id)
    .maybeSingle();
  // Same again: "isn't taking applications right now" is a statement about the
  // park, and a failed read knows nothing about the park.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("that park", parkRes.error) };
  }
  const park = parkRes.data;
  // An unpublished park must not take applications through a guessed lot id.
  if (!park || !park.active) return { ok: false, error: "That park isn't taking applications right now." };

  if (!parkOpenFor(
    {
      openMonth: (park.season_open_month as number | null) ?? null,
      openDay: (park.season_open_day as number | null) ?? null,
      closeMonth: (park.season_close_month as number | null) ?? null,
      closeDay: (park.season_close_day as number | null) ?? null,
    },
    range,
  )) {
    return { ok: false, error: "The park is closed for part of those dates." };
  }

  // --- the money is the PARK OWNER'S, read from their card ---
  const rateRes = await admin
    .from("lot_rates").select("term, amount").eq("park_lot_id", input.lotId);
  // No rates read means no card read. Falling through with an empty card makes
  // `quoteStay` return null, and the renter is told this lot isn't rented by
  // the term they picked — which may be exactly how it IS rented.
  if (rateRes.error) {
    return { ok: false, error: readFailedMessage("this lot's rates", rateRes.error) };
  }
  const rateRows = rateRes.data;
  const rates: RateCard[] = (rateRows ?? []).map((r) => ({ term: r.term as Term, amount: Number(r.amount) }));
  // WHAT THE APPLICANT IS QUOTED vs WHAT THE LEDGER BILLS ARE DIFFERENT NUMBERS.
  //
  // `quoteStay` is a STAY TOTAL — parks.ts multiplies the card rate by the
  // number of whole periods, and its own test asserts a $900/month card over
  // 2½ months quotes 2700. That is right for the applicant, who wants to know
  // what the stay costs.
  //
  // `lot_reservations.quoted_amount` is NOT that. Every other writer puts a
  // per-period RATE in it — the importer writes the monthly figure off the
  // rent roll — and `buildStatement` bills it as "Lot rent … for the month",
  // prorating by days in the month. Storing the stay total here billed that
  // three-month applicant $2,700 EVERY MONTH, and the charge run bills
  // 'approved' rows, so approving the application was enough to start it.
  // quoteStay is kept as the VALIDITY check — it returns null both when the
  // park does not sell this term and when the range is not a real one. Its
  // number is deliberately not stored; naming it `sellable` so nobody wires
  // the stay total back into quoted_amount by reaching for the nearest
  // variable.
  const sellable = quoteStay(rates, input.term as Term, range);
  const card = rates.find((r) => r.term === (input.term as Term));
  if (sellable == null || !card) {
    return { ok: false, error: "This lot isn't rented by that term. Pick another option." };
  }

  // --- is it actually free? The database is the real guard when the owner
  //     approves; this is so a renter doesn't apply for nights already sold ---
  const heldRes = await admin
    .from("lot_reservations")
    .select("during, status")
    .eq("park_lot_id", input.lotId)
    .in("status", ["approved", "active"]);
  // FAILS OPEN IF LEFT BARE. `null` here is an empty list of holds, so the
  // loop below never runs and the clash check PASSES without having looked —
  // the renter applies for nights that are already sold, and finds out when
  // the owner's approval is refused by the database.
  if (heldRes.error) {
    return { ok: false, error: readFailedMessage("what's already booked on this lot", heldRes.error) };
  }
  const heldRows = heldRes.data;
  for (const h of heldRows ?? []) {
    const other = parseDaterange(h.during as string);
    if (other && other.start < range.end && range.start < other.end) {
      return { ok: false, error: "Those nights are already taken on this lot." };
    }
  }

  // --- the rig. Fit is a WARNING to the renter, never a block: the park owner
  //     decides who goes on their lot, and a length we were told wrong should
  //     not silently refuse a real customer ---
  const lengthFt = input.unitLengthFt.trim() ? Number(input.unitLengthFt) : null;
  if (lengthFt != null && (!Number.isInteger(lengthFt) || lengthFt <= 0 || lengthFt > 120)) {
    return { ok: false, error: "Length should be a whole number of feet." };
  }
  const year = input.unitYear.trim() ? Number(input.unitYear) : null;
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
    return { ok: false, error: "Check the year on your unit." };
  }

  const lot: Lot = {
    id: lotRow.id as string,
    lotNumber: lotRow.lot_number as string,
    siteType: lotRow.site_type as Lot["siteType"],
    maxLengthFt: (lotRow.max_length_ft as number | null) ?? null,
    amperage: (lotRow.amperage as number | null) ?? null,
    hasWater: !!lotRow.has_water,
    hasSewer: !!lotRow.has_sewer,
    slipIncluded: !!lotRow.slip_included,
    active: !!lotRow.active,
    lifecycle: (lotRow.lifecycle as string) ?? "live",
  };
  const fit = lotFits(lot, { unitType: input.unitType as UnitType, lengthFt, needsAmps: null });

  // --- the park's FILE on this person ---
  // A tenancy hangs off park_renters, never off the account (migration 0055).
  // Someone applying through the website has an account, so their file is
  // created already claimed — but it is still a FILE, so it survives them
  // deleting that account later, and it sits alongside the files the park
  // owner typed in for tenants who never signed up.
  let renterId: string | null = null;
  const existingRes = await admin
    .from("park_renters")
    .select("id")
    .eq("park_id", park.id)
    .eq("user_id", user.id)
    .maybeSingle();
  // FAILS OPEN IF LEFT BARE. `null` reads as "no file here yet" and the branch
  // below opens a SECOND file for somebody the park already has one for —
  // splitting one tenancy across two records, or failing on the unique index
  // with a sentence about saving their unit.
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("your file at this park", existingRes.error) };
  }
  const existing = existingRes.data;

  if (existing) {
    renterId = existing.id as string;
  } else {
    const { data: created, error: renterErr } = await admin
      .from("park_renters")
      .insert({
        park_id: park.id,
        user_id: user.id,
        display_name: (user.user_metadata?.name as string | undefined)?.trim()
          || user.email?.split("@")[0]
          || "Renter",
        email: user.email ?? null,
        // They came in through the website, so the sensible default channel is
        // the one they already used to reach us — not paper.
        contact_pref: "email",
        source: "self_signup",
        claimed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (renterErr || !created) {
      return { ok: false, error: "Couldn't start your application — try again." };
    }
    renterId = created.id as string;
  }

  // --- record the rig, then the application ---
  const { data: unit, error: unitErr } = await admin
    .from("renter_units")
    .insert({
      renter_id: renterId,
      unit_type: input.unitType,
      make: input.unitMake.trim() || null,
      model: input.unitModel.trim() || null,
      year,
      length_ft: lengthFt,
    })
    .select("id")
    .single();
  if (unitErr || !unit) return { ok: false, error: "Couldn't save your unit — try again." };

  const { error: resErr } = await admin.from("lot_reservations").insert({
    park_lot_id: input.lotId,
    renter_id: renterId,
    renter_unit_id: unit.id,
    during: toDaterange(range),
    term: input.term,
    // The RATE, not the stay total — see the note above `quoteStay` here.
    quoted_amount: card.amount,
    status: "applied",
  });
  if (resErr) {
    // Don't leave an orphan rig behind on a failed application.
    await admin.from("renter_units").delete().eq("id", unit.id);
    return { ok: false, error: "Couldn't send your application — try again." };
  }

  revalidatePath(`/parks/${park.slug}`);
  revalidatePath("/park");

  return {
    ok: true,
    signal: fit.fits
      ? `Sent to ${park.name}. They'll get back to you — nothing is charged.`
      : `Sent to ${park.name}. Heads up: this lot may be a tight fit for your unit, so they may follow up.`,
  };
}
