import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { decryptGate } from "@/lib/gate";

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
  const { data } = await supabase
    .from("properties")
    .select("id, address, nickname, lakes(name)")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true });
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
  const { data } = await supabase.from("users").select("ics_token").eq("id", user.id).maybeSingle();
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
  boats: Array<{ type: string; length_ft: number }>;
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
export async function getFullProfile(propertyId?: string): Promise<FullProfile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const targetId = propertyId ?? (await getActivePropertyId());

  const { data: property } = targetId
    ? await supabase
        .from("properties")
        .select("id, address, place_id, sqft, beds, baths, gate_code_encrypted, lakes(name)")
        .eq("owner_id", user.id)
        .eq("id", targetId)
        .maybeSingle()
    : { data: null };

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

  const [{ data: profile }, { data: boats }, { data: toys }] = await Promise.all([
    supabase.from("property_profile").select("*").eq("property_id", property.id).maybeSingle(),
    supabase.from("boats").select("type, length_ft").eq("property_id", property.id),
    supabase.from("toys").select("name").eq("property_id", property.id),
  ]);

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
  }));

  return {
    hasProfile: true,
    propertyId: property.id,
    lake: lakeName ?? null,
    address: property.address,
    place_id: (property as { place_id?: string | null }).place_id ?? null,
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
  const { data: services } = await supabase
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, frequency_options, is_water_work")
    .eq("active", true);

  const pp = toPricingProfile(p);
  return (services ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    price: priceService(s as unknown as ServiceRule, pp),
    frequency_options: s.frequency_options ?? [],
    is_water_work: s.is_water_work ?? false,
  }));
}
