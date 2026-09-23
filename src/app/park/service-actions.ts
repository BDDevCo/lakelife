"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount, readFailedMessage } from "@/lib/must-read";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { assertMyPark } from "./data";
import { withParkRate, parkMayPrice } from "@/lib/park-rates";
import { loadParkRates } from "./rate-data";
import { loadPricingProfileById } from "@/app/book/dispatch";
import {
  buildParkBlockers, buildGroundsPropertyRow, canEnableParkServices, parkRateUnit,
  buildOwnedHomeRow, ownedHomeAddress,
  type ParkReadiness, type OwnedHomeInput,
} from "./service-helpers";

/**
 * THE PARK'S OWN SERVICE DESK.
 *
 * "Book services for the park" sat in ParkNav from the day it shipped until the
 * six-tab strip (it is now the Park services pill under On site), pointing at
 * /book — which tells a park owner with no property to "Set up your property
 * first" and hands him the lake-house wizard. This is the mechanism that button
 * always implied.
 *
 * THE PARK IS THE CUSTOMER. Not the renter: 0055 made a tenancy carry no user
 * at all, and nineteen of The Haven's twenty-one households will never have an
 * account. The park buys the work, the park is charged, and a job may name the
 * lot it is at so the crew goes to the right pad and the owner knows who is on
 * his land.
 */

const DENIED = "You don't manage that park.";
const ACTIVE_PROPERTY_COOKIE = "ll_active_property";

export interface ServiceDeskResult {
  ok: boolean;
  error?: string;
  signal?: string;
}

/** Everything the desk needs, in one read. */
export async function getParkServiceDesk(parkId: string): Promise<{
  propertyId: string | null;
  parkName: string;
  liveLots: number;
  blockers: string[];
  canEnable: boolean;
} | null> {
  const membership = await assertMyPark(parkId);
  if (!membership) return null;

  const admin = createServiceClient();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [parkRes, lotsRes, meRes, cardsRes] =
    await Promise.all([
      admin.from("parks")
        .select("name, address, lake_id, lat, lng, service_property_id")
        .eq("id", parkId).maybeSingle(),
      admin.from("park_lots")
        .select("id", { count: "exact", head: true })
        .eq("park_id", parkId).eq("lifecycle", "live"),
      admin.from("users").select("role").eq("id", user.id).maybeSingle(),
      admin.from("payment_methods")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id),
    ]);
  // EVERY ONE OF THESE BECOMES A BLOCKER SENTENCE. A failed count is not zero
  // lots and not "no card on file" — it is a screen telling a man to go and do
  // things he has already done, with no way to tell that it is wrong.
  const park = mustRead("your park", parkRes);
  const liveLots = mustCount("your live lots", lotsRes);
  const me = mustRead("your account", meRes);
  const cards = mustCount("your saved cards", cardsRes);
  if (!park) return null;

  const readiness: ParkReadiness = {
    parkName: (park.name as string) ?? null,
    lakeId: (park.lake_id as string) ?? null,
    address: (park.address as string) ?? null,
    liveLots,
    memberRole: membership.role,
    accountRole: (me?.role as string) ?? null,
    hasCard: cards > 0,
  };

  return {
    propertyId: (park.service_property_id as string) ?? null,
    parkName: (park.name as string) ?? "Your park",
    liveLots,
    blockers: buildParkBlockers(readiness),
    canEnable: canEnableParkServices(membership.role),
  };
}

/**
 * MINT THE PARK'S GROUNDS PROPERTY — the switch that opens the door.
 *
 * Idempotent: a park that already has one keeps it. Minting a second would
 * split the park's service history in half with no way to tell which is real,
 * and 0107's unique index refuses it anyway.
 */
export async function enableParkServices(parkId: string): Promise<ServiceDeskResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  if (!canEnableParkServices(membership.role)) {
    return { ok: false, error: "Only the park's owner can turn this on." };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  // `getParkServiceDesk` is a loader and now THROWS on a failed read rather
  // than reporting a park with no lots and no card. This is an action, so it
  // catches and answers in the shape the button is awaiting.
  let desk: Awaited<ReturnType<typeof getParkServiceDesk>>;
  try {
    desk = await getParkServiceDesk(parkId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your park's set-up", e) };
  }
  if (!desk) return { ok: false, error: DENIED };
  if (desk.propertyId) {
    return { ok: true, signal: "Park services are already on." };
  }
  if (desk.blockers.length) {
    // The desk already prints these; refusing with the first one keeps the
    // toast honest rather than generic.
    return { ok: false, error: desk.blockers[0] };
  }

  const admin = createServiceClient();
  const parkRes = await admin
    .from("parks").select("name, address, lake_id, lat, lng").eq("id", parkId).maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park", parkRes.error) };
  }
  const park = parkRes.data;
  if (!park) return { ok: false, error: "That park is gone." };

  const { data: prop, error: propErr } = await admin
    .from("properties")
    .insert(buildGroundsPropertyRow({
      ownerId: user.id,
      parkId,
      parkName: (park.name as string) ?? "The park",
      lakeId: park.lake_id as string,
      address: park.address as string,
      lat: (park.lat as number) ?? null,
      lng: (park.lng as number) ?? null,
    }))
    .select("id")
    .single();
  if (propErr || !prop) {
    return { ok: false, error: `Couldn't set that up — ${propErr?.message ?? "try again"}.` };
  }

  const { error: linkErr } = await admin
    .from("parks")
    .update({ service_property_id: prop.id })
    .eq("id", parkId)
    .is("service_property_id", null);   // one mint wins a double-tap
  if (linkErr) {
    // Roll the orphan back rather than leave a property nothing points at —
    // it would show up in his property switcher as a second, nameless place.
    await admin.from("properties").delete().eq("id", prop.id);
    return { ok: false, error: `Couldn't set that up — ${linkErr.message}` };
  }

  revalidatePath("/park/services");
  revalidatePath("/park/visits");
  return { ok: true, signal: "Park services are on. Prices are worked out from your live lot count." };
}

/**
 * POINT THE BOOKING SCREEN AT THE PARK, not at his lake house.
 *
 * `getActivePropertyId` falls back to the OLDEST property, so a park owner who
 * also owns a lake home would land on /book about his dock. This sets the
 * switcher cookie the rest of the app already reads, so one door leads to one
 * obvious place.
 */
export async function focusParkProperty(parkId: string): Promise<ServiceDeskResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  // "Turn on park services first" is a lie to a park that already has, and it
  // sends him to a screen where the switch is already on.
  const parkRes = await admin
    .from("parks").select("service_property_id").eq("id", parkId).maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park", parkRes.error) };
  }
  const propertyId = (parkRes.data?.service_property_id as string) ?? null;
  if (!propertyId) return { ok: false, error: "Turn on park services first." };

  const jar = await cookies();
  jar.set(ACTIVE_PROPERTY_COOKIE, propertyId, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
  return { ok: true, signal: "Booking for the park." };
}

export interface ParkServiceRow {
  id: string;
  name: string;
  /** Null when THIS park has not set a rate. Never another park's number. */
  price: number | null;
  /** The two dials behind that price, so the editor shows what is there now. */
  base: number | null;
  unitRate: number | null;
  note: string | null;
  /**
   * THE RULE'S SHAPE, so the editor can preview with the SAME engine the
   * invoice uses. It previewed $277.50 for a rate that charged $278 — half a
   * dollar, and the whole point of showing the arithmetic is that the number on
   * screen is the number he pays. Carries no margin and no customer price.
   */
  pricingModel: string;
  bandPricing: Record<string, unknown> | null;
  frequencyOptions: string[];
  minPhotos: number;
  /**
   * WHAT THE PER-UNIT BOX IS FOR, at this park, in this park's own numbers.
   *
   * `unitNoun` is the word ("lot", "pier section"); `unitCount` is how many of
   * them the ENGINE will count at this grounds — asked of `priceService`
   * itself, not re-derived, so the preview and the invoice cannot drift. Both
   * null when the model never reads unit_rate (snow is `flat`), and the editor
   * then draws one box.
   */
  unitNoun: string | null;
  unitCount: number | null;
  /**
   * The pricing-profile key the engine multiplies by, so the live preview can
   * hand `priceService` a profile it recognises instead of a lot count it
   * doesn't use. Null exactly when `unitNoun` is.
   */
  countField: string | null;
  /**
   * False for a service the park can BOOK but LakeLife is not park-only about
   * — the dock. Only used to explain, never to price: both halves are priced
   * identically, by this park's own row or not at all.
   */
  parkOnly: boolean;
}

/** The grounds menu, priced off what is actually AT the grounds. */
export async function getParkServiceMenu(parkId: string): Promise<ParkServiceRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const [parkRes, lotsRes, servicesRes, rates] = await Promise.all([
    admin.from("parks").select("service_property_id").eq("id", parkId).maybeSingle(),
    admin.from("park_lots").select("id", { count: "exact", head: true })
      .eq("park_id", parkId).eq("lifecycle", "live"),
    admin.from("services")
      .select("id, name, pricing_model, base, unit_rate, band_pricing, frequency_options, min_photos, park_only, park_bookable")
      // THE DESK SHOWS WHATEVER THE PARK CAN BUY — both halves, the same two
      // flags `getPricedServices` selects the booking menu with. It was
      // `.eq("park_only", true)` while /book already offered the dock, so The
      // Haven could BOOK a $1,564 pier and had no box anywhere to put Josh's
      // $840 in. A price screen that cannot reach a bookable service is the
      // rate in one doorway of two.
      .eq("active", true).or("park_only.eq.true,park_bookable.eq.true"),
    loadParkRates(parkId),
  ]);
  // The lot count is a MULTIPLIER on every price below it, so a dropped count
  // read as 0 shows him his base rate and calls it the price of a mow.
  const lots = mustCount("your live lots", lotsRes);
  const services = mustRead("the grounds menu", servicesRes);
  const park = mustRead("your park", parkRes);
  const propertyId = (park?.service_property_id as string | null) ?? null;

  // THIS PARK'S OWN NUMBERS, or none at all.
  //
  // 0115 zeroed the global price on every park_only service precisely so a
  // missing rate cannot quietly become somebody else's. A service with no row
  // here comes back priced `null`, and the screen asks for a number instead of
  // showing a confident wrong one.
  const { priceService, serviceApplies } = await import("@/lib/pricing");

  // THE GROUNDS' REAL PROFILE, not a lot count in a trenchcoat.
  //
  // This was `{ lots }`, which is every input a park_only service has — and
  // exactly none of the inputs the dock has. Josh's $30 a section previewed as
  // "$0.00 a visit" against it, because `per_section` counts `pier_sections`
  // and that key was not in the object. The same loader dispatch, autopilot and
  // the nightly price through is the only one that can be right here.
  const profile = propertyId
    ? await loadPricingProfileById(admin, propertyId)
    // No grounds property minted yet: the blockers list already says so, and
    // the lot count is genuinely all we know. Nothing here is bookable anyway.
    : ({ lots } as unknown as Parameters<typeof priceService>[1]);
  const pp = (profile ?? ({ lots } as unknown as Parameters<typeof priceService>[1]));

  return (services ?? [])
    // WORK THE GROUNDS CAN ACTUALLY TAKE. park_only services stay listed
    // unconditionally — they are this park's own four and a price is wanted for
    // each. The half 0143 opened is filtered by the honest test /book uses:
    // `serviceApplies` counts the equipment, not the money. A park with no boat
    // lift is not asked to price a boat-lift pull it could never book.
    .filter((s) => s.park_only === true
      || serviceApplies(s as unknown as Parameters<typeof priceService>[0], pp))
    .map((s) => {
    const own = rates.get(s.id as string);
    const shape = s as unknown as Parameters<typeof priceService>[0] & { id: string };
    const unit = parkRateUnit(s.pricing_model as string, s.band_pricing as Record<string, unknown> | null);
    // HOW MANY OF THEM, ASKED OF THE ENGINE. One dollar of unit rate, and see
    // what the engine does with it — which is the multiplier it will use on the
    // invoice, by construction, whatever the model does. Re-deriving it from
    // `band_pricing` here would be a second pricing path, and a second pricing
    // path is how the screen and the bill stop agreeing.
    const unitCount = unit
      ? priceService({ ...shape, base: 0, unit_rate: 1 }, pp)
        - priceService({ ...shape, base: 0, unit_rate: 0 }, pp)
      : null;
    return {
      id: s.id as string,
      name: s.name as string,
      price: own
        // The SAME engine the customer path uses, with this park's numbers
        // overlaid onto the service's shape. A second pricing path here is how
        // the screen and the invoice drift apart.
        ? priceService(withParkRate(shape, rates), pp)
        : null,
      pricingModel: s.pricing_model as string,
      bandPricing: (s.band_pricing as Record<string, unknown> | null) ?? null,
      base: own?.base ?? null,
      unitRate: own?.unit_rate ?? null,
      note: own?.note ?? null,
      frequencyOptions: (s.frequency_options as string[]) ?? [],
      minPhotos: (s.min_photos as number) ?? 0,
      // A UNIT NOBODY COUNTS IS NOT A UNIT. `per_section` on a grounds with no
      // dock multiplies by zero; offering the box there is the snow bug wearing
      // a different hat, so the noun goes away with the count.
      unitNoun: unit && unitCount ? unit.noun : null,
      unitCount: unit && unitCount ? unitCount : null,
      countField: unit && unitCount ? unit.countField : null,
      parkOnly: s.park_only === true,
    };
  });
}

/** Set what THIS park pays for one of its grounds services. */
export async function setParkServiceRate(
  parkId: string,
  serviceId: string,
  base: number,
  unitRate: number,
): Promise<ServiceDeskResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  if (!canEnableParkServices(membership.role)) {
    return { ok: false, error: "Only the park's owner can set prices." };
  }
  if (!(base >= 0) || !(unitRate >= 0)) {
    return { ok: false, error: "A price can't be negative." };
  }
  if (base === 0 && unitRate === 0) {
    return { ok: false, error: "That prices to nothing — give it a base, a per-lot rate, or both." };
  }

  const admin = createServiceClient();

  // WHICH SERVICE — the guards above answer WHO, and nothing answered WHAT.
  //
  // `serviceId` arrives from a browser and was written straight into
  // park_service_rates. `createBooking` overlays this park's whole rate map
  // onto WHATEVER service is being booked whenever the active property is the
  // grounds, so a park owner could have set a rate of $1 against "Fall
  // winterization" and then booked a $485 lake-house service for a dollar.
  // That is LakeLife's price list, not his.
  // A failed read must not be the answer to "is this one of yours" — the
  // question this paragraph exists to ask.
  const svcRes = await admin
    .from("services")
    .select("id, name, park_only, park_bookable, active, pricing_model, band_pricing")
    .eq("id", serviceId)
    .maybeSingle();
  if (svcRes.error) {
    return { ok: false, error: readFailedMessage("that service", svcRes.error) };
  }
  const svc = svcRes.data;
  if (!svc) return { ok: false, error: "That service isn't there any more." };
  // WIDENED 28 AUG 2026 — "every park carries its own number".
  //
  // It was `svc.park_only !== true`, which refused the dock. 0143 had already
  // let a park BOOK general work and said out loud that whether a park gets its
  // own number on it was "a business decision, not a schema one, and it is not
  // made here". It is made now, and the answer is yes: a park's number comes
  // from that park's own costs or from a crew onboarded to it, never from
  // LakeLife's retail card and never from another park.
  //
  // The refusal below is still true and still useful for what it now refuses —
  // lake-house work a park cannot buy at all. Pricing something you cannot book
  // is a number with no reader.
  if (!parkMayPrice(svc)) {
    return { ok: false, error: `${svc.name} isn't on your park's menu — it's lake-house work, so there's nothing here for you to price.` };
  }
  if (svc.active === false) {
    return { ok: false, error: `${svc.name} isn't offered at the moment, so there's nothing to price.` };
  }
  // A UNIT RATE THE ENGINE WILL NEVER READ IS A NUMBER THAT LIES ON THE CARD.
  //
  // Snow clearing is priced `flat`, and priceService returns `rule.base` —
  // unit_rate is not looked at. Stored anyway it shows back on the services
  // list, reads as part of the price, and is worth nothing at booking. The
  // editor no longer offers the box; this is the same rule on the server,
  // where the numbers actually arrive from a browser.
  //
  // IT ASKS FOR THE UNIT, NOT FOR LOTS. The narrower "does this move with the
  // lot count?" test that used to stand here answers FALSE for the dock —
  // per_section counting `pier_sections` — so Josh's "$30 a section" would have
  // been refused with "put the whole amount in the per-visit box", and $30 flat
  // is not $840. (That predicate is gone; `parkRateUnit` is the only one left.)
  const unit = parkRateUnit(svc.pricing_model as string, svc.band_pricing as Record<string, unknown> | null);
  if (unitRate > 0 && !unit) {
    return {
      ok: false,
      error: `${svc.name} is priced once per visit — put the whole amount in the per-visit box.`,
    };
  }

  // AND THE UNIT HAS TO BE THERE TO COUNT.
  //
  // `per_section` with nothing to count multiplies by zero in silence: the
  // rate saves, the card shows "$30 a pier section", and every booking prices
  // at the base. That is the snow bug with a different counter, and the fix is
  // a different sentence — not "use the other box" but "your grounds has none
  // of these on file".
  if (unitRate > 0 && unit) {
    const propRes = await admin
      .from("parks").select("service_property_id").eq("id", parkId).maybeSingle();
    if (propRes.error) {
      return { ok: false, error: readFailedMessage("your park's grounds", propRes.error) };
    }
    const propertyId = (propRes.data?.service_property_id as string | null) ?? null;
    const profile = propertyId ? await loadPricingProfileById(admin, propertyId) : null;
    const { priceService } = await import("@/lib/pricing");
    const shape = { ...svc, base: 0 } as unknown as Parameters<typeof priceService>[0];
    // Asked of the engine, one dollar at a time — the same question the desk
    // asks, so the box he was offered and the number we accept agree.
    const count = profile
      ? priceService({ ...shape, unit_rate: 1 }, profile) - priceService({ ...shape, unit_rate: 0 }, profile)
      : 0;
    if (!(count > 0)) {
      return {
        ok: false,
        error: `${svc.name} is charged per ${unit.noun}, and your grounds has none on file — put the whole amount in the per-visit box, or add them to the property first.`,
      };
    }
  }
  const { error } = await admin
    .from("park_service_rates")
    .upsert({ park_id: parkId, service_id: serviceId, base, unit_rate: unitRate,
              // CLEARED ON EVERY EDIT. PostgREST only SETs the columns in the
              // payload, so the seeded note — "From the seller: $100/week for
              // the park (21 lots)" — survived a rate change and sat under a
              // different number, asserting a provenance that had stopped
              // being true. A note explains a price; change the price and the
              // explanation is gone until somebody writes a new one.
              note: null,
              updated_at: new Date().toISOString() },
            { onConflict: "park_id,service_id" });
  if (error) return { ok: false, error: `Couldn't save that — ${error.message}` };

  revalidatePath("/park/services");
  // THE BOOKING SCREEN IS THE OTHER READER. Until this rate existed the service
  // priced to $0 and /book's `price > 0` filter dropped the tile entirely — so
  // without this the owner saves his price and the dock is still not there.
  revalidatePath("/book");
  return { ok: true, signal: "Saved. That's this park's price." };
}

// ------------------------------------------------- homes the park owns ----

/**
 * A HOME THE PARK OWNS IS STILL A HOME.
 *
 * The Haven's Lot 11 is a 28x60 the park owns and rents out. It needs cleaning
 * between tenants and winterizing in October — ordinary house work, from the
 * ordinary menu, at ordinary prices. It could not be booked because it was not
 * a PROPERTY, only a boolean on a lot.
 *
 * Nothing about the `park_only` fence changes. Once the home has a property of
 * its own, `getPricedServices` already gives it the whole house menu, because
 * its `groundsForParkId` is null — it is not the common ground, it is a house.
 */
export interface OwnedHomeRow {
  lotId: string;
  lotNumber: string;
  propertyId: string | null;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  /** Somebody is living in it right now — interior work needs arranging. */
  occupied: boolean;
}

export async function getOwnedHomes(parkId: string): Promise<OwnedHomeRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const lots = mustRead("the homes you own", await admin
    .from("park_lots")
    .select("id, lot_number, service_property_id")
    .eq("park_id", parkId)
    .eq("park_owned_home", true)
    .eq("lifecycle", "live"));
  if (!lots?.length) return [];

  const propIds = lots.map((l) => l.service_property_id as string).filter(Boolean);
  const lotIds = lots.map((l) => l.id as string);

  const [propsRes, staysRes] = await Promise.all([
    propIds.length
      ? admin.from("properties").select("id, sqft, beds, baths").in("id", propIds)
      : Promise.resolve({ data: [] as Array<{ id: string; sqft: number | null; beds: number | null; baths: number | null }>, error: null }),
    admin.from("lot_reservations")
      .select("park_lot_id").in("park_lot_id", lotIds).in("status", ["approved", "active"]),
  ]);
  // `occupied` decides whether the screen says interior work needs arranging;
  // an empty read says every one of his homes is standing empty.
  const props = mustRead("those homes' details", propsRes);
  const stays = mustRead("who is living in them", staysRes);

  const propById = new Map((props ?? []).map((p) => [p.id as string, p]));
  const occupied = new Set((stays ?? []).map((s) => s.park_lot_id as string));

  return lots
    .map((l): OwnedHomeRow => {
      const p = l.service_property_id ? propById.get(l.service_property_id as string) : null;
      return {
        lotId: l.id as string,
        lotNumber: l.lot_number as string,
        propertyId: (l.service_property_id as string) ?? null,
        sqft: p?.sqft ?? null,
        beds: p?.beds ?? null,
        baths: p?.baths ?? null,
        occupied: occupied.has(l.id as string),
      };
    })
    .sort((a, b) => a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true }));
}

export async function enableHomeServices(
  parkId: string, lotId: string, input: OwnedHomeInput,
): Promise<ServiceDeskResult> {
  const membership = await assertMyPark(parkId);
  if (!membership) return { ok: false, error: DENIED };
  if (!canEnableParkServices(membership.role)) {
    return { ok: false, error: "Only the park's owner can set a home up for service." };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  // HOW BIG IT IS, BEFORE ANYTHING IS MINTED. Housekeeping is priced by square
  // footage in bands, and an unset size lands in the SMALLEST band — the same
  // $80 a real 1,680 sq ft double-wide costs. The right answer and the wrong
  // one are the same number, so nothing downstream could ever catch it.
  const built = buildOwnedHomeRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };

  const admin = createServiceClient();
  // Not DENIED on a failed read — that sentence tells the owner the lot isn't
  // his, which is both false and the one thing he cannot check from here.
  const lotRes = await admin
    .from("park_lots")
    .select("id, lot_number, park_id, park_owned_home, service_property_id")
    .eq("id", lotId).eq("park_id", parkId).maybeSingle();
  if (lotRes.error) {
    return { ok: false, error: readFailedMessage("that lot", lotRes.error) };
  }
  const lot = lotRes.data;
  if (!lot) return { ok: false, error: DENIED };
  if (lot.park_owned_home !== true) {
    return { ok: false, error: "That lot's home isn't yours — their house is their business." };
  }
  if (lot.service_property_id) {
    return { ok: true, signal: `Lot ${lot.lot_number} is already set up.` };
  }

  const parkRes = await admin
    .from("parks").select("name, address, lake_id, lat, lng").eq("id", parkId).maybeSingle();
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park", parkRes.error) };
  }
  const park = parkRes.data;
  if (!park) return { ok: false, error: "That park is gone." };

  const { data: prop, error: propErr } = await admin
    .from("properties")
    .insert({
      owner_id: user.id,
      lake_id: park.lake_id,
      address: ownedHomeAddress(lot.lot_number as string, park.name as string, park.address as string),
      park_id: parkId,
      lat: park.lat ?? null,
      lng: park.lng ?? null,
      nickname: `Lot ${lot.lot_number} — yours`,
      ...built.row,
    })
    .select("id")
    .single();
  if (propErr || !prop) {
    return { ok: false, error: `Couldn't set that up — ${propErr?.message ?? "try again"}.` };
  }

  // WHAT A HOME LIKE THIS IS ACTUALLY OFFERED — and this list is the ONLY
  // fence there is.
  //
  // "Fall winterization" is flat $485 and counts nothing, so it applies to
  // everything, including a mobile home on a pad. 0110 added the $185 job that
  // is actually right for one. Pricing cannot tell them apart, because a flat
  // service has no profile field to be wrong about, so `wanted_services` is
  // what keeps a lake-house price off a mobile home's menu — the same
  // reasoning the lot-resident path already carries.
  //
  // A STARTING LIST, NOT A CAGE: he can add any active service from the
  // property profile. Water work stays off by arithmetic rather than by this
  // list — no pier sections and no boats means `serviceApplies` refuses it.
  await admin.from("property_profile").insert({
    property_id: prop.id,
    // A pad's yard is small by definition of a pad, and the park already mows
    // the common ground around it. Cheaper band, so erring here never
    // overcharges him.
    lawn_band: "small",
    pier_sections: 0,
    boat_lifts: 0,
    toy_lifts: 0,
    jet_skis: 0,
    pwc_lifts: 0,
    wanted_services: [
      "Housekeeping",
      "Mobile home winterization",
      "Mobile home de-winterization",
    ],
  });

  const { error: linkErr } = await admin
    .from("park_lots")
    .update({ service_property_id: prop.id })
    .eq("id", lotId)
    .is("service_property_id", null);   // one mint wins a double-tap
  if (linkErr) {
    // Roll the orphan back rather than leave a property nothing points at — it
    // would sit in his switcher as a second, nameless place.
    await admin.from("property_profile").delete().eq("property_id", prop.id);
    await admin.from("properties").delete().eq("id", prop.id);
    return { ok: false, error: `Couldn't set that up — ${linkErr.message}` };
  }

  revalidatePath("/park/services");
  revalidatePath("/park/lots");
  return {
    ok: true,
    signal: `Lot ${lot.lot_number} is set up — ${built.row.sqft.toLocaleString()} sq ft. It's in your property list now.`,
  };
}

/** Point the booking screen at one of his own homes. */
export async function focusOwnedHome(parkId: string, lotId: string): Promise<ServiceDeskResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const lotRes = await admin
    .from("park_lots").select("service_property_id, lot_number")
    .eq("id", lotId).eq("park_id", parkId).maybeSingle();
  if (lotRes.error) {
    return { ok: false, error: readFailedMessage("that home", lotRes.error) };
  }
  const lot = lotRes.data;
  const propertyId = (lot?.service_property_id as string) ?? null;
  if (!propertyId) return { ok: false, error: "Set that home up for service first." };

  const jar = await cookies();
  jar.set(ACTIVE_PROPERTY_COOKIE, propertyId, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
  return { ok: true, signal: `Booking for Lot ${lot?.lot_number}.` };
}
