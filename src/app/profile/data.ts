import "server-only";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount } from "@/lib/must-read";
import { decryptGate } from "@/lib/gate";
import { withParkRate, type ParkRates } from "@/lib/park-rates";
import { loadParkRates } from "@/app/park/rate-data";


const ACTIVE_PROPERTY_COOKIE = "ll_active_property";

export interface PropertySummary {
  id: string;
  address: string | null;
  lake: string | null;
  nickname: string | null;
}

/** All of the signed-in owner's properties (for the switcher). */
export async function listProperties(): Promise<PropertySummary[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  // A failed read here would read as "you own nothing" — and getActivePropertyId
  // below turns that into no active property for the whole portal.
  const data = mustRead(
    "your properties",
    await supabase
      .from("properties")
      .select("id, address, nickname, lakes(name)")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true }),
  );
  return (data ?? []).map((p) => {
    const lk = Array.isArray(p.lakes) ? p.lakes[0] : p.lakes;
    return {
      id: p.id as string,
      address: (p.address as string) ?? null,
      lake: (lk as { name?: string } | null)?.name ?? null,
      nickname: ((p as { nickname?: string | null }).nickname as string) ?? null,
    };
  });
}

/** The signed-in user's personal calendar-feed URL (unguessable token). */
export async function getMyCalendarUrl(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const data = mustRead(
    "your calendar link",
    await supabase.from("users").select("ics_token").eq("id", user.id).maybeSingle(),
  );
  if (!data?.ics_token) return null;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${site}/api/ics/${data.ics_token}`;
}

/** The property the portal is currently focused on (cookie, else the first). */
export async function getActivePropertyId(): Promise<string | null> {
  const props = await listProperties();
  if (props.length === 0) return null;
  const cookieStore = await cookies();
  const chosen = cookieStore.get(ACTIVE_PROPERTY_COOKIE)?.value;
  if (chosen && props.some((p) => p.id === chosen)) return chosen;
  return props[0].id;
}
import {
  priceService,
  boatFeet,
  type ServiceRule,
  type PricingProfile,
} from "@/lib/pricing";

export interface FullProfile {
  hasProfile: boolean;
  propertyId?: string;
  lake?: string | null;
  address?: string | null;
  place_id?: string | null;
  /** Self-declared park (0085). Read back so an edit cannot silently erase it. */
  park_id?: string | null;
  /**
   * A PARK'S LIVE LOT COUNT — set only when this property IS a park's grounds
   * (parks.service_property_id points at it). Undefined everywhere else, which
   * is what prices every park service at $0 for an ordinary property.
   */
  lots?: number;
  /** The park whose grounds this property is, when it is one. Drives the menu. */
  groundsForParkId?: string | null;
  gate?: string | null;
  sqft: number;
  beds: number;
  baths: number;
  pier_sections: number;
  ladder: boolean;
  bumpers: boolean;
  boat_lifts: number;
  canopy: boolean;
  toy_lifts: number;
  jet_skis: number;
  pwc_lifts: number;
  lawn_band: "small" | "medium" | "large";
  boats: Array<{ type: string; length_ft: number; engine_type?: string | null; engine_hp?: number | null; engines?: number | null }>;
  toys: Array<{ name: string }>;
  wanted_services: string[];
  boatFeet: number;
}

export interface PricedService {
  id: string;
  name: string;
  price: number;
  frequency_options: string[];
  is_water_work: boolean;
}

/**
 * Load one of the owner's property profiles. Pass a propertyId to target a
 * specific home; otherwise the active (switcher) property is used.
 */
export async function getFullProfile(
  propertyId?: string,
  /**
   * READ A PROPERTY THE CALLER DOES NOT OWN.
   *
   * The default path is owner-scoped: a session client plus
   * `.eq("owner_id", user.id)`. That is right for every screen — and wrong for
   * the one server path that needs a profile on somebody else's behalf.
   *
   * `submitFlag` calls this to price a crew's correction for the HOMEOWNER'S
   * message. The caller there is the crew, so the owner filter matched nothing
   * and it returned `{hasProfile:false}` — a TRUTHY object, so the surrounding
   * try/catch never fired and nothing was logged. Every owner got the generic
   * "found something that doesn't match your profile" instead of "8 → 12,
   * $796 instead of $604, about an hour and a quarter longer", and approved a
   * reprice having never seen a number.
   *
   * Rule 1 is not implicated: the priced string is composed server-side and
   * sent to the OWNER. It is never returned to the crew's browser.
   */
  opts?: { asService?: boolean },
): Promise<FullProfile | null> {
  const supabase = opts?.asService ? createServiceClient() : await createClient();

  let ownerId: string | null = null;
  if (!opts?.asService) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    ownerId = user.id;
  }

  // The service path must be given its target — there is no "active property"
  // without a session to own one.
  const targetId = propertyId ?? (opts?.asService ? null : await getActivePropertyId());

  const base = targetId
    ? supabase
        .from("properties")
        .select("id, address, place_id, park_id, sqft, beds, baths, gate_code_encrypted, lakes(name)")
        .eq("id", targetId)
    : null;

  // A failed read must not become `hasProfile: false` — that sends an owner who
  // has a property to "Set up your place to see prices".
  const propertyRes = base
    ? await (ownerId ? base.eq("owner_id", ownerId) : base).maybeSingle()
    : null;
  const property = propertyRes ? mustRead("your property", propertyRes) : null;

  if (!property) {
    return {
      hasProfile: false,
      sqft: 0,
      beds: 0,
      baths: 0,
      pier_sections: 0,
      ladder: false,
      bumpers: false,
      boat_lifts: 0,
      canopy: false,
      toy_lifts: 0,
      jet_skis: 0,
      pwc_lifts: 0,
      lawn_band: "medium",
      boats: [],
      toys: [],
      wanted_services: [],
      boatFeet: 0,
    };
  }

  // IS THIS PROPERTY A PARK'S GROUNDS? Asked of `parks`, not of `properties`,
  // because the park is what owns the relationship — properties.park_id is the
  // renter-facing "I live in this park" flag from 0085 and means something
  // else entirely. Service-role: a park owner reading his own park is fine,
  // but the answer must not depend on which client is asking.
  const admin = createServiceClient();
  const groundsQ = admin
    .from("parks")
    .select("id, service_property_id")
    .eq("service_property_id", property.id)
    .maybeSingle();

  const [profileRes, boatsRes, toysRes, groundsRes] = await Promise.all([
    supabase.from("property_profile").select("*").eq("property_id", property.id).maybeSingle(),
    supabase.from("boats").select("type, length_ft, engine_type, engine_hp, engines").eq("property_id", property.id),
    supabase.from("toys").select("name").eq("property_id", property.id),
    groundsQ,
  ]);
  // Every one of these is a price input. A failed read would quietly zero the
  // pier sections / lifts / boats and quote a number for a different house.
  const profile = mustRead("your property profile", profileRes);
  const boats = mustRead("your boats", boatsRes);
  const toys = mustRead("your toys", toysRes);
  const grounds = mustRead("the park this property belongs to", groundsRes);

  // The live lot count is the price of every park service, so it is read here
  // rather than passed in — a stale count is a wrong invoice.
  let lots: number | undefined;
  if (grounds?.id) {
    lots = mustCount(
      "the park's lot count",
      await admin
        .from("park_lots")
        .select("id", { count: "exact", head: true })
        .eq("park_id", grounds.id as string)
        .eq("lifecycle", "live"),
    );
  }

  let gate: string | null = null;
  try {
    gate = decryptGate(property.gate_code_encrypted as unknown as string);
  } catch {
    gate = null; // never let a decrypt hiccup break the page
  }

  const lakeName = Array.isArray(property.lakes)
    ? (property.lakes[0] as { name?: string } | undefined)?.name
    : (property.lakes as { name?: string } | null)?.name;

  const boatList = (boats ?? []).map((b) => ({
    type: b.type ?? "Boat",
    length_ft: Number(b.length_ft) || 0,
    engine_type: (b.engine_type as string | null) ?? null,
    engine_hp: b.engine_hp != null ? Number(b.engine_hp) : null,
    engines: b.engines != null ? Number(b.engines) : 1,
  }));

  return {
    hasProfile: true,
    propertyId: property.id,
    lake: lakeName ?? null,
    address: property.address,
    place_id: (property as { place_id?: string | null }).place_id ?? null,
    park_id: (property as { park_id?: string | null }).park_id ?? null,
    lots,
    groundsForParkId: (grounds?.id as string | undefined) ?? null,
    gate,
    sqft: property.sqft ?? 0,
    beds: property.beds ?? 0,
    baths: Number(property.baths) || 0,
    pier_sections: profile?.pier_sections ?? 0,
    ladder: profile?.ladder ?? false,
    bumpers: profile?.bumpers ?? false,
    boat_lifts: profile?.boat_lifts ?? 0,
    canopy: profile?.canopy ?? false,
    toy_lifts: profile?.toy_lifts ?? 0,
    jet_skis: profile?.jet_skis ?? 0,
    pwc_lifts: profile?.pwc_lifts ?? 0,
    lawn_band: (profile?.lawn_band as FullProfile["lawn_band"]) ?? "medium",
    boats: boatList,
    toys: (toys ?? []).map((t) => ({ name: t.name ?? "" })),
    wanted_services: (profile?.wanted_services as string[] | null) ?? [],
    boatFeet: boatFeet({ boats: boatList }),
  };
}

/** Turn a FullProfile into the shape the pricing engine expects. */
export function toPricingProfile(p: FullProfile): PricingProfile {
  return {
    // Undefined on every ordinary property, which is what keeps park services
    // priced at $0 — and therefore unbookable — for a lake house.
    lots: p.lots,
    sqft: p.sqft,
    beds: p.beds,
    baths: p.baths,
    pier_sections: p.pier_sections,
    boat_lifts: p.boat_lifts,
    toy_lifts: p.toy_lifts,
    jet_skis: p.jet_skis,
    pwc_lifts: p.pwc_lifts,
    lawn_band: p.lawn_band,
    boats: p.boats,
    toys: p.toys,
  };
}

/** Load all active services and price each one against a profile. */
export async function getPricedServices(p: FullProfile): Promise<PricedService[]> {
  const supabase = await createClient();
  // THE FENCE RUNS ONE WAY (0143).
  //
  // A LAKE HOUSE still sees only `park_only = false`, and that half must never
  // move: nobody buying a lake house should be offered a 21-lot mow.
  //
  // A GROUNDS PROPERTY used to be the mirror of that — `park_only = true` and
  // nothing else — which meant a park's entire menu was three rows and the
  // park could not book its own dock. The Haven has a 28-section pier it pays
  // to put in and pull every year, and the software could not see the service.
  //
  // Pricing alone cannot open that direction safely, which is why the fence
  // exists at all: park services count `lots`, so they price to $0 on a lake
  // house and vanish on their own — but `serviceApplies` returns TRUE for any
  // rule that counts nothing, so flat lake-house work like "Fall winterization"
  // ($485) would leak onto a park's menu at a lake-house price. So the opening
  // is NAMED, service by service, in `park_bookable`.
  const isGrounds = p.groundsForParkId != null;
  const menuQuery = supabase
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, frequency_options, is_water_work, park_only")
    .eq("active", true)
    .eq("kind", "standalone"); // components/add-ons price inside packages, never as menu tiles
  const services = mustRead(
    "the service menu",
    isGrounds
      // Its own grounds services, PLUS the general work a park has been let
      // buy. Each of those is gated a second time by `serviceApplies`, so a
      // park with no dock still sees no pier.
      ? await menuQuery.or("park_only.eq.true,park_bookable.eq.true")
      : await menuQuery.eq("park_only", false),
  );

  // A PARK SERVICE IS PRICED BY THE PARK THAT BUYS IT (0115).
  //
  // The global rows carry base 0 / unit_rate 0 on purpose, so a park with no
  // rate of its own prices to $0 and /book's `price > 0` filter drops it —
  // rather than quoting this owner the rate another owner negotiated in a
  // different county. /park/services is where he sets the number, and it says
  // so out loud.
  const rates = isGrounds
    ? await loadParkRates(p.groundsForParkId as string)
    : (new Map() as ParkRates);

  const pp = toPricingProfile(p);
  return (services ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    price: priceService(withParkRate(s, rates) as unknown as ServiceRule, pp),
    frequency_options: s.frequency_options ?? [],
    is_water_work: s.is_water_work ?? false,
  }));
}

/** The signed-in user's shareable referral link (roadmap §8 rails). */
export async function getMyReferralLink(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const data = mustRead(
    "your referral link",
    await supabase.from("users").select("referral_code").eq("id", user.id).maybeSingle(),
  );
  if (!data?.referral_code) return null;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${site}/?ref=${data.referral_code}`;
}
