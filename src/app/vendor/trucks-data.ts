import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getMyVendorId } from "./data";

/**
 * "My trucks" — the self-serve fleet list on the Availability tab
 * (docs/fleet-routing-design.md). A truck is a `crew_units` row: its own
 * phone (the morning route text lands there), a jobs-per-day capacity, and
 * working hours. Money/liability/standing never move here — that all stays
 * on the vendor.
 *
 * Load-bearing invariant: an empty list means the vendor is on the LEGACY
 * single-route path (planVendorDay, count-based capacity) — nothing else in
 * the app changes behavior until a crew_units row exists.
 */
import type { MyTruck } from "./trucks-types";
export type { MyTruck } from "./trucks-types";

/** The signed-in crew's own trucks, oldest first (stable order = stable route naming). */
export async function getMyTrucks(): Promise<MyTruck[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];

  const admin = createServiceClient();
  const { data } = await admin
    .from("crew_units")
    .select("id, name, phone, capacity, work_start, work_end, active")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string | null) ?? null,
    capacity: r.capacity as number,
    workStart: r.work_start as number,
    workEnd: r.work_end as number,
    active: r.active as boolean,
  }));
}
