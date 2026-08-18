"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage } from "@/lib/must-read";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

/**
 * A LOT BECOMES A PLACE THE RESIDENT CAN BOOK FOR.
 *
 * "I dont want a lot renter to have to go to or set up 2 different portals."
 * So there is no wizard: one tap on their own screen mints the property, and
 * the next screen is the ordinary booking page with their lot already
 * selected. They never see a form asking how many pier sections their mobile
 * home has.
 *
 * IT IS THEIR HOME, NOT THE LOT'S FIXTURE. The property belongs to the
 * RESIDENT, not the park and not the lot. If they move the trailer to another
 * park the address changes and their service history, boats and toys go with
 * them — which is the portability rule the module has followed throughout:
 * records fan OUT to the renter, and nothing the park authored fans in. It
 * also means the next resident of Lot 7 never inherits a stranger's property.
 *
 * WHY THE RESIDENT MINTS IT AND NOT THE PARK OWNER. Setting properties.park_id
 * is what puts a visit on the owner's board (0085, widened to the lot in
 * 0107). 0085's rule is that it is "self-declared, never inferred — nobody is
 * enrolled in being visible", so the park owner must never mint this on
 * somebody's behalf. The button says what it does before it does it.
 */

const NO_TENANCY = "We can't find a lot on your account.";
const ACTIVE_PROPERTY_COOKIE = "ll_active_property";

export interface BookingSetupResult {
  ok: boolean;
  error?: string;
  signal?: string;
  propertyId?: string;
}

export async function enableBookingForMyLot(): Promise<BookingSetupResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again." };

  const admin = createServiceClient();

  // Same gate the portal uses: a CLAIMED file, then a live tenancy.
  //
  // A FAILED READ IS NOT AN EMPTY ROLL. Every `return NO_TENANCY` below used to
  // be reachable by a dropped connection, and it asserts a fact about somebody's
  // household — "we can't find a lot on your account" to a resident who has paid
  // rent for years. We only get to say that when we actually looked.
  const filesRes = await admin
    .from("park_renters").select("id, park_id").eq("user_id", user.id);
  if (filesRes.error) return { ok: false, error: readFailedMessage("your lot", filesRes.error) };
  const files = filesRes.data;
  if (!files?.length) return { ok: false, error: NO_TENANCY };

  const staysRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id")
    .in("renter_id", files.map((f) => f.id as string))
    .in("status", ["approved", "active"])
    .order("created_at", { ascending: false });
  if (staysRes.error) return { ok: false, error: readFailedMessage("your stay", staysRes.error) };
  const stay = staysRes.data?.[0];
  if (!stay) return { ok: false, error: NO_TENANCY };

  // IDEMPOTENT. A second tap must not mint a second address — that would
  // split their service history in half with no way to tell which is real.
  const lotRes = await admin
    .from("park_lots")
    .select("lot_number, park_id")
    .eq("id", stay.park_lot_id as string)
    .maybeSingle();
  if (lotRes.error) return { ok: false, error: readFailedMessage("your lot", lotRes.error) };
  const lot = lotRes.data;
  if (!lot) return { ok: false, error: NO_TENANCY };

  const parkRes = await admin
    .from("parks")
    .select("name, address, lake_id, lat, lng")
    .eq("id", lot.park_id as string)
    .maybeSingle();
  // Told apart from the genuine "no lake set" case below: that one sends them
  // to the office, which is wasted advice when the truth is a dropped read.
  if (parkRes.error) return { ok: false, error: readFailedMessage("your park", parkRes.error) };
  const park = parkRes.data;
  if (!park?.lake_id) {
    return { ok: false, error: "Your park isn't set up for services yet — ring the office." };
  }

  const address = `Lot ${lot.lot_number}, ${park.name}, ${park.address ?? ""}`.replace(/,\s*$/, "");

  const alreadyRes = await admin
    .from("properties")
    .select("id")
    .eq("owner_id", user.id)
    .eq("park_id", lot.park_id as string)
    .eq("address", address)
    .maybeSingle();
  // FAILS OPEN IF LEFT ALONE. This IS the idempotency check, and a failed read
  // looks exactly like "no such property" — so a dropped connection here mints
  // a SECOND address and splits their service history in half, which is the one
  // outcome the comment above says must never happen. Refuse instead.
  if (alreadyRes.error) return { ok: false, error: readFailedMessage("your lot's address", alreadyRes.error) };
  const already = alreadyRes.data;
  if (already) {
    await point(already.id as string);
    return { ok: true, propertyId: already.id as string, signal: "Your lot is ready to book for." };
  }

  const { data: prop, error } = await admin
    .from("properties")
    .insert({
      owner_id: user.id,
      lake_id: park.lake_id,
      address,
      // 0085's self-declared park flag — declared HERE by the resident about
      // their own home, which is the only way it may ever be set.
      park_id: lot.park_id,
      // The park's pin. A crew needs to find the park; the lot number in the
      // address gets them the rest of the way.
      lat: (park.lat as number) ?? null,
      lng: (park.lng as number) ?? null,
      nickname: `Lot ${lot.lot_number}`,
      // NO place_id: 0006 puts a global unique index on it, and a lot inside a
      // park has no Google address of its own anyway.
    })
    .select("id")
    .single();
  if (error || !prop) {
    return { ok: false, error: `Couldn't set that up — ${error?.message ?? "try again"}.` };
  }

  // THE PROFILE, WITHOUT INVENTING A HOUSE.
  //
  // sqft is left unset, which puts housekeeping in its smallest tier — the
  // honest answer for a single-wide, and not a measurement anybody made up.
  // lawn_band is 'small' because a pad's yard is small by definition of a pad;
  // it is the CHEAPER band, so erring here never overcharges, and the resident
  // can change it. Everything water-related stays zero, which is what keeps
  // piers and boat lifts off their menu entirely (serviceApplies).
  await admin.from("property_profile").insert({
    property_id: prop.id,
    lawn_band: "small",
    pier_sections: 0,
    boat_lifts: 0,
    toy_lifts: 0,
    jet_skis: 0,
    pwc_lifts: 0,
    // WHAT A LOT RESIDENT IS ACTUALLY OFFERED.
    //
    // Brendon's list, and the reasoning behind each exclusion matters more
    // than the list itself:
    //
    //   PIER IS THE PARK'S. Not a pricing question — an ownership one. A
    //   resident cannot buy work on somebody else's structure. (It was already
    //   unbookable at $0 with no pier sections; this says why.)
    //
    //   THE SEASONS ARE THE MOBILE HOME'S, NOT A LAKE HOUSE'S. 0110 added the
    //   smaller job. The $485/$430 lake-house pair stays off this list —
    //   pricing cannot exclude them because they count nothing, so this list
    //   is the only fence there is.
    //
    //   THE BOATS ARE THEIRS. These are lake parks; a resident on a lot may
    //   well own a boat. Boat work prices per FOOT off `boats`, so it costs
    //   the right thing for whoever has one and prices to $0 — vanishing from
    //   the menu — for whoever does not. No special casing needed.
    //
    // A STARTING LIST, NOT A CAGE: they can add any active service from their
    // property profile.
    //
    // Two of these are switched OFF platform-wide today ("Spring de-winterize
    // & test run", "Winter storage"). Naming them here is harmless — an
    // inactive service never renders — and they appear the day they are
    // switched on, rather than needing this list edited again.
    wanted_services: [
      "Mobile home winterization",
      "Mobile home de-winterization",
      "Housekeeping",
      "Boat storage & winterize",
      "Boat winterization (shop)",
      "Spring de-winterize & test run",
      "Winter storage — indoor",
      "Winter storage — outdoor",
    ],
  });

  // NOTHING POINTS BACK FROM THE TENANCY, deliberately. 0107 dropped
  // lot_reservations.service_property_id and the reason still holds: 0062
  // makes a tenancy a CHAIN, so a pointer there would need re-making on every
  // renewal and would be stale the moment one lapsed. The property is found
  // by its owner, which is a fact that survives renewals, moves and the
  // tenancy ending.
  await point(prop.id as string);
  revalidatePath("/parks/my");
  return { ok: true, propertyId: prop.id as string, signal: "Your lot is ready — pick a service." };
}

/**
 * Point the booking screen at their lot.
 *
 * `getActivePropertyId` otherwise falls back to the OLDEST property, so a
 * resident who also owns a lake house would land on /book about their dock.
 */
async function point(propertyId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_PROPERTY_COOKIE, propertyId, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
}
