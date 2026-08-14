"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { assertMyPark } from "./data";
import {
  buildParkBlockers, buildGroundsPropertyRow, canEnableParkServices,
  type ParkReadiness,
} from "./service-helpers";

/**
 * THE PARK'S OWN SERVICE DESK.
 *
 * "Book services for the park" has sat in ParkNav since it shipped, pointing at
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

  const [{ data: park }, { count: liveLots }, { data: me }, { count: cards }] =
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
  if (!park) return null;

  const readiness: ParkReadiness = {
    parkName: (park.name as string) ?? null,
    lakeId: (park.lake_id as string) ?? null,
    address: (park.address as string) ?? null,
    liveLots: liveLots ?? 0,
    memberRole: membership.role,
    accountRole: (me?.role as string) ?? null,
    hasCard: (cards ?? 0) > 0,
  };

  return {
    propertyId: (park.service_property_id as string) ?? null,
    parkName: (park.name as string) ?? "Your park",
    liveLots: liveLots ?? 0,
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

  const desk = await getParkServiceDesk(parkId);
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
  const { data: park } = await admin
    .from("parks").select("name, address, lake_id, lat, lng").eq("id", parkId).maybeSingle();
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
  const { data: park } = await admin
    .from("parks").select("service_property_id").eq("id", parkId).maybeSingle();
  const propertyId = (park?.service_property_id as string) ?? null;
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
  price: number;
  frequencyOptions: string[];
  minPhotos: number;
}

/** The grounds menu, priced off the live lot count. */
export async function getParkServiceMenu(parkId: string): Promise<ParkServiceRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const [{ count: lots }, { data: services }] = await Promise.all([
    admin.from("park_lots").select("id", { count: "exact", head: true })
      .eq("park_id", parkId).eq("lifecycle", "live"),
    admin.from("services")
      .select("id, name, pricing_model, base, unit_rate, band_pricing, frequency_options, min_photos")
      .eq("active", true).eq("park_only", true),
  ]);

  const { priceService } = await import("@/lib/pricing");
  const n = lots ?? 0;
  return (services ?? []).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    // The SAME engine the customer path uses. A second pricing path here is
    // how the number on the screen and the number on the invoice drift.
    price: priceService(
      s as unknown as Parameters<typeof priceService>[0],
      { lots: n } as unknown as Parameters<typeof priceService>[1],
    ),
    frequencyOptions: (s.frequency_options as string[]) ?? [],
    minPhotos: (s.min_photos as number) ?? 0,
  }));
}
