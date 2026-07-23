"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { toE164 } from "@/lib/phone";
import { fleetJobCap, fleetMinuteBudget, fitsTimeBudget, jobMinutesOf } from "@/lib/fleet";
import { todayLakeDate } from "@/lib/booking";
import { sendSms } from "@/lib/sms";

export interface TruckResult {
  ok: boolean;
  error?: string;
}

/** Plenty for any real contractor fleet — keeps a fat-fingered flood of rows
 *  out of the nightly router. Mirrors the DB's own per-row capacity check
 *  (1..20) in spirit: a sane ceiling, not a real-world constraint. */
const MAX_ACTIVE_TRUCKS = 10;

/**
 * Confirm the signed-in user owns a vendors row. Identity is asserted with
 * the SESSION client (auth.getUser); the row is read with the SERVICE client
 * so RLS can't hide a still-onboarding record. Mirrors assertMyVendor in
 * rates-actions.ts / availability/actions.ts.
 */
async function assertMyVendor(): Promise<{ id: string; status: string; company: string | null; daily_capacity: number } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin.from("vendors").select("id, status, company, daily_capacity").eq("user_id", user.id).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, status: data.status as string, company: (data.company as string) ?? null, daily_capacity: Number(data.daily_capacity ?? 0) };
}

/**
 * The transition guard (review finding, 2026-07-23): the moment trucks exist
 * they REPLACE the legacy capacity, and the nightly self-heal enforces the
 * new numbers — so a fleet change that can't cover work ALREADY BOOKED would
 * silently strip scheduled jobs at midnight. Refuse it here instead, naming
 * the day that doesn't fit, and let the vendor size their trucks first.
 * `proposedUnits` = the ACTIVE fleet as it would look AFTER the change
 * (empty array = back to the legacy count, no time budget).
 */
async function forwardBookConflict(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
  legacyCapacity: number,
  proposedUnits: { capacity: number; workStart: number; workEnd: number }[],
): Promise<string | null> {
  const newCap = fleetJobCap(proposedUnits, legacyCapacity);
  const newBudget = fleetMinuteBudget(proposedUnits);
  const { data: booked } = await admin
    .from("jobs")
    .select("date, group_id, services(est_minutes), job_items(services(est_minutes))")
    .eq("vendor_id", vendorId)
    .gte("date", todayLakeDate())
    .in("status", ["scheduled", "in_progress"]);
  const byDate = new Map<string, { count: number; minutes: number }>();
  for (const j of booked ?? []) {
    const svc = (Array.isArray(j.services) ? j.services[0] : j.services) as { est_minutes?: number } | null;
    const legs = (j as { group_id?: string | null }).group_id
      ? ((j as { job_items?: Array<{ services?: unknown }> }).job_items ?? []).map((it) => {
          const s = (Array.isArray(it.services) ? it.services[0] : it.services) as { est_minutes?: number } | null;
          return s?.est_minutes ?? null;
        })
      : null;
    const d = byDate.get(j.date as string) ?? { count: 0, minutes: 0 };
    d.count += 1;
    d.minutes += jobMinutesOf(svc?.est_minutes, legs);
    byDate.set(j.date as string, d);
  }
  for (const [date, d] of byDate) {
    const countBust = newCap > 0 && d.count > newCap;
    const hoursBust = newBudget != null && !fitsTimeBudget(d.minutes, 0, newBudget);
    if (countBust || hoursBust) {
      const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const hrs = Math.round((d.minutes / 60) * 10) / 10;
      return `Your trucks have to cover work already on your calendar: ${pretty} has ${d.count} job${d.count === 1 ? "" : "s"} (~${hrs}h booked). Add capacity or hours, or adjust that day first.`;
    }
  }
  return null;
}

/** The vendor's active fleet as plain numbers (for the transition guard). */
async function activeFleet(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
): Promise<{ id: string; capacity: number; workStart: number; workEnd: number }[]> {
  const { data } = await admin
    .from("crew_units")
    .select("id, capacity, work_start, work_end")
    .eq("vendor_id", vendorId)
    .eq("active", true);
  return (data ?? []).map((u) => ({
    id: u.id as string,
    capacity: Number(u.capacity ?? 0),
    workStart: Number(u.work_start ?? 0),
    workEnd: Number(u.work_end ?? 0),
  }));
}

/**
 * Confirm unitId belongs to the signed-in vendor before any write — NEVER
 * trust a unitId sent from the browser, even though the form only ever shows
 * the vendor their own trucks.
 */
async function assertOwnUnit(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
  unitId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("crew_units")
    .select("id")
    .eq("id", unitId)
    .eq("vendor_id", vendorId)
    .maybeSingle();
  return !!data;
}

export interface TruckInput {
  name: string;
  phone: string; // "" = none
  capacity: number;
  workStart: number;
  workEnd: number;
}

interface TruckRow {
  name: string;
  phone: string | null;
  capacity: number;
  work_start: number;
  work_end: number;
}

function validName(raw: string): string | null {
  const name = (raw ?? "").trim();
  if (name.length < 1 || name.length > 60) return null;
  return name;
}

function validCapacity(raw: number): number | null {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 20) return null;
  return n;
}

function validHour(raw: number, min: number, max: number): number | null {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Optional phone, normalized to E.164 like the rest of the codebase (lib/phone.ts). */
function normalizedPhone(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, value: null };
  const e164 = toE164(trimmed);
  if (!e164) return { ok: false };
  return { ok: true, value: e164 };
}

/** Validate one truck's fields into a DB-ready row, or a friendly error. */
function buildRow(input: TruckInput): { row: TruckRow } | { error: string } {
  const name = validName(input?.name);
  if (!name) {
    return { error: "Give the truck a name, 1–60 characters — \"Truck 2 — Mike\" works great." };
  }

  const capacity = validCapacity(input?.capacity);
  if (capacity == null) {
    return { error: "Capacity should be a whole number of jobs, 1 to 20." };
  }

  const workStart = validHour(input?.workStart, 0, 23);
  const workEnd = validHour(input?.workEnd, 1, 24);
  if (workStart == null || workEnd == null || workEnd <= workStart) {
    return { error: "Work hours need to be whole hours, with the end later than the start — like 7 to 17." };
  }

  const phoneResult = normalizedPhone(input?.phone);
  if (!phoneResult.ok) {
    return { error: "That phone number doesn't look right — 10 digits, or include the +1." };
  }

  return { row: { name, phone: phoneResult.value, capacity, work_start: workStart, work_end: workEnd } };
}

/**
 * Add a new truck under the signed-in vendor. New trucks start active, so
 * the active cap is checked here too.
 */
export async function addTruck(input: TruckInput): Promise<TruckResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }

  const built = buildRow(input);
  if ("error" in built) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const fleet = await activeFleet(admin, vendor.id);
  if (fleet.length >= MAX_ACTIVE_TRUCKS) {
    return {
      ok: false,
      error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now. Turn one off before adding another.`,
    };
  }

  // Transition guard: the new fleet (this truck included) must cover every
  // day already booked — especially the FIRST truck, which replaces the
  // legacy capacity outright.
  const proposed = [...fleet, { capacity: built.row.capacity, workStart: built.row.work_start, workEnd: built.row.work_end }];
  const conflict = await forwardBookConflict(admin, vendor.id, vendor.daily_capacity, proposed);
  if (conflict) return { ok: false, error: conflict };

  const { error } = await admin.from("crew_units").insert({ vendor_id: vendor.id, ...built.row, active: true });
  if (error) return { ok: false, error: error.message };

  // Post-write cap recheck (check-then-insert race): if a parallel add
  // slipped past the read, flip THIS row off rather than run 11 trucks.
  const after = await activeFleet(admin, vendor.id);
  if (after.length > MAX_ACTIVE_TRUCKS) {
    const newest = after[after.length - 1];
    await admin.from("crew_units").update({ active: false }).eq("id", newest.id).eq("vendor_id", vendor.id);
    return { ok: false, error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now.` };
  }

  // A truck phone is a standing destination for route texts (they carry the
  // day's stop map) — the number hears about it the moment it's enrolled,
  // so a typo'd digit surfaces on day one, not silently every morning.
  if (built.row.phone) {
    void sendSms(built.row.phone, `LakeLife: this number now gets ${vendor.company ?? "your crew"}'s morning truck routes ("${built.row.name}"). Wrong number? Tell your crew office to fix it in the LakeLife app. 🌊`);
  }
  return { ok: true };
}

/** Edit an existing truck's name/phone/capacity/hours. Active state is a separate toggle (setTruckActive). */
export async function updateTruck(unitId: string, input: TruckInput): Promise<TruckResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }
  if (typeof unitId !== "string" || !unitId) return { ok: false, error: "Unknown truck." };

  const admin = createServiceClient();
  if (!(await assertOwnUnit(admin, vendor.id, unitId))) return { ok: false, error: "Unknown truck." };

  const built = buildRow(input);
  if ("error" in built) return { ok: false, error: built.error };

  // Transition guard: shrinking an ACTIVE truck's capacity or hours must
  // still cover the booked calendar (inactive trucks don't change the fleet).
  const fleet = await activeFleet(admin, vendor.id);
  const isActive = fleet.some((u) => u.id === unitId);
  if (isActive) {
    const proposed = fleet.map((u) =>
      u.id === unitId ? { capacity: built.row.capacity, workStart: built.row.work_start, workEnd: built.row.work_end } : u,
    );
    const conflict = await forwardBookConflict(admin, vendor.id, vendor.daily_capacity, proposed);
    if (conflict) return { ok: false, error: conflict };
  }

  const { data: prev } = await admin.from("crew_units").select("phone").eq("id", unitId).maybeSingle();
  const { error } = await admin.from("crew_units").update(built.row).eq("id", unitId).eq("vendor_id", vendor.id);
  if (error) return { ok: false, error: error.message };
  if (built.row.phone && built.row.phone !== ((prev?.phone as string) ?? null)) {
    void sendSms(built.row.phone, `LakeLife: this number now gets ${vendor.company ?? "your crew"}'s morning truck routes ("${built.row.name}"). Wrong number? Tell your crew office to fix it in the LakeLife app. 🌊`);
  }
  return { ok: true };
}

/** Deactivate (or reactivate) a truck. Reactivating re-checks the active cap. */
export async function setTruckActive(unitId: string, active: boolean): Promise<TruckResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }
  if (typeof unitId !== "string" || !unitId) return { ok: false, error: "Unknown truck." };

  const admin = createServiceClient();
  if (!(await assertOwnUnit(admin, vendor.id, unitId))) return { ok: false, error: "Unknown truck." };

  const fleet = await activeFleet(admin, vendor.id);
  if (active && fleet.length >= MAX_ACTIVE_TRUCKS) {
    return {
      ok: false,
      error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now. Turn another off first.`,
    };
  }

  // Transition guard both ways: turning a truck OFF shrinks the fleet (or
  // reverts to the legacy count when it's the last one); turning one ON with
  // an empty fleet REPLACES the legacy capacity. Either move must still
  // cover the booked calendar.
  let proposed = fleet.filter((u) => u.id !== unitId);
  if (active) {
    const { data: row } = await admin
      .from("crew_units").select("capacity, work_start, work_end").eq("id", unitId).maybeSingle();
    proposed = [...proposed, {
      id: unitId,
      capacity: Number(row?.capacity ?? 0),
      workStart: Number(row?.work_start ?? 0),
      workEnd: Number(row?.work_end ?? 0),
    }];
  }
  const conflict = await forwardBookConflict(admin, vendor.id, vendor.daily_capacity, proposed);
  if (conflict) return { ok: false, error: conflict };

  const { error } = await admin.from("crew_units").update({ active }).eq("id", unitId).eq("vendor_id", vendor.id);
  if (error) return { ok: false, error: error.message };

  // Post-write cap recheck (check-then-write race), same rail as addTruck.
  if (active) {
    const after = await activeFleet(admin, vendor.id);
    if (after.length > MAX_ACTIVE_TRUCKS) {
      await admin.from("crew_units").update({ active: false }).eq("id", unitId).eq("vendor_id", vendor.id);
      return { ok: false, error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now.` };
    }
  }
  return { ok: true };
}
