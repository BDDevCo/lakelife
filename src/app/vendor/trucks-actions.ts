"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { toE164 } from "@/lib/phone";
import { fleetJobCap, fleetMinuteBudget, fitsTimeBudget, jobMinutesOf } from "@/lib/fleet";
import { todayLakeDate } from "@/lib/booking";
import { notify } from "@/lib/notify";
import { getSellableDay } from "@/lib/settings";
import { sellableWindow } from "@/lib/duration";
import { readFailedMessage } from "@/lib/must-read";

export interface TruckResult {
  ok: boolean;
  error?: string;
}

/** Plenty for any real contractor fleet — keeps a fat-fingered flood of rows
 *  out of the nightly router. Mirrors the DB's own per-row capacity check
 *  (1..20) in spirit: a sane ceiling, not a real-world constraint. */
const MAX_ACTIVE_TRUCKS = 10;

/** Add days to an ISO date string (no TZ drift). Reimplemented locally —
 *  automation.ts's addDays is module-private. */
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type MyVendor = { id: string; status: string; company: string | null; daily_capacity: number };

/**
 * Confirm the signed-in user owns a vendors row. Identity is asserted with
 * the SESSION client (auth.getUser); the row is read with the SERVICE client
 * so RLS can't hide a still-onboarding record. Mirrors assertMyVendor in
 * rates-actions.ts / availability/actions.ts.
 *
 * Returns the READ FAILURE separately from the absence, because the three
 * callers turn `null` into "Your crew account isn't set up yet — call
 * dispatch", and a dropped connection has no business saying that to a
 * contractor with six trucks on the road. Actions RETURN here rather than
 * throw: a rejection out of a "use server" call is a blank failure on a phone.
 */
async function assertMyVendor(): Promise<{ vendor: MyVendor | null; readError?: unknown }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { vendor: null };
  const admin = createServiceClient();
  const res = await admin.from("vendors").select("id, status, company, daily_capacity").eq("user_id", user.id).maybeSingle();
  if (res.error) return { vendor: null, readError: res.error };
  const data = res.data;
  if (!data) return { vendor: null };
  return { vendor: { id: data.id as string, status: data.status as string, company: (data.company as string) ?? null, daily_capacity: Number(data.daily_capacity ?? 0) } };
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
  const bookedRes = await admin
    .from("jobs")
    .select("est_minutes, date, group_id, services(est_minutes), job_items(services(est_minutes))")
    .eq("vendor_id", vendorId)
    .gte("date", todayLakeDate())
    .in("status", ["scheduled", "in_progress"]);
  // THE GUARD PASSED BECAUSE IT COULDN'T RUN. `booked ?? []` is an empty
  // calendar, so every date check below was skipped and the fleet change went
  // through — and then the nightly self-heal quietly stripped the scheduled
  // jobs the shrunken fleet could no longer cover, which is the exact outcome
  // this function exists to prevent. A refusal is what every caller already
  // does with a returned string, so failure comes back as one; the writes are
  // all downstream of it.
  if (bookedRes.error) return readFailedMessage("the work already on your calendar", bookedRes.error);
  const booked = bookedRes.data;
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
    // 0083: the stamped figure wins. Toggling a truck off re-checks every
    // affected day against the smaller fleet — from the flat dial, that check
    // passed on days that genuinely bust.
    const stamped = Number((j as { est_minutes?: number | null }).est_minutes ?? 0);
    d.minutes += stamped > 0 ? stamped : jobMinutesOf(svc?.est_minutes, legs);
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

type FleetUnit = { id: string; capacity: number; workStart: number; workEnd: number };

/**
 * The vendor's active fleet as plain numbers (for the transition guard).
 *
 * A FAILED READ HERE IS NOT AN EMPTY FLEET, and an empty fleet is a load-bearing
 * value in three separate ways: the MAX_ACTIVE_TRUCKS cap can never be reached,
 * `isActive` says the truck being edited is switched off (skipping the
 * transition guard entirely), and `proposed` reverts the vendor to their legacy
 * capacity. So the failure is returned alongside, and the callers refuse.
 */
async function activeFleet(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
): Promise<{ units: FleetUnit[]; readError?: unknown }> {
  const res = await admin
    .from("crew_units")
    .select("id, capacity, work_start, work_end")
    .eq("vendor_id", vendorId)
    .eq("active", true);
  if (res.error) return { units: [], readError: res.error };
  return {
    units: (res.data ?? []).map((u) => ({
      id: u.id as string,
      capacity: Number(u.capacity ?? 0),
      workStart: Number(u.work_start ?? 0),
      workEnd: Number(u.work_end ?? 0),
    })),
  };
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
): Promise<{ mine: boolean; readError?: unknown }> {
  const res = await admin
    .from("crew_units")
    .select("id")
    .eq("id", unitId)
    .eq("vendor_id", vendorId)
    .maybeSingle();
  // `false` from here means "that truck isn't yours", which is a refusal aimed
  // at a tampered unitId. A failed read said it to a vendor looking at their
  // own truck, so the failure is carried out separately.
  if (res.error) return { mine: false, readError: res.error };
  return { mine: !!res.data };
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

/**
 * Validate one truck's fields into a DB-ready row, or a friendly error.
 *
 * Async since 0083's cutoff became real: the sellable day is a dial in the
 * database, so clamping a crew's closing time needs a read.
 */
async function buildRow(input: TruckInput): Promise<{ row: TruckRow } | { error: string }> {
  const name = validName(input?.name);
  if (!name) {
    return { error: "Give the truck a name, 1–60 characters — \"Truck 2 — Mike\" works great." };
  }

  const capacity = validCapacity(input?.capacity);
  if (capacity == null) {
    return { error: "Capacity should be a whole number of jobs, 1 to 20." };
  }

  const workStart = validHour(input?.workStart, 0, 23);
  const workEndRaw = validHour(input?.workEnd, 1, 24);
  if (workStart == null || workEndRaw == null || workEndRaw <= workStart) {
    return { error: "Work hours need to be whole hours, with the end later than the start — like 7 to 4." };
  }

  // THE CUTOFF IS ENFORCED HERE, at the write, because this is the only place
  // a crew's sellable day is actually set. 0083 put 7am-4pm in platform_dials
  // and nothing read `sell_end_hour` — meanwhile the truck form pre-filled 17
  // and always wrote it explicitly, so the column default never fired and the
  // first truck anybody created was sold an hour past four.
  //
  // A crew may still close EARLIER; they may not push the close later. That is
  // exactly the comparison `sellableWindow` was written to perform, so it is
  // used rather than re-implemented.
  const day = await getSellableDay();
  const win = sellableWindow(day, { workStart, workEnd: workEndRaw });
  const workEnd = win.endHour;
  if (workEnd <= workStart) {
    const close = day.endHour > 12 ? `${day.endHour - 12}pm` : `${day.endHour}am`;
    return { error: `Work hours have to start before ${close}.` };
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
  const me = await assertMyVendor();
  if (me.readError) return { ok: false, error: readFailedMessage("your crew account", me.readError) };
  const vendor = me.vendor;
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };
  }

  const built = await buildRow(input);
  if ("error" in built) return { ok: false, error: built.error };

  const admin = createServiceClient();
  const fleetRes = await activeFleet(admin, vendor.id);
  if (fleetRes.readError) return { ok: false, error: readFailedMessage("your trucks", fleetRes.readError) };
  const fleet = fleetRes.units;
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
  const afterRes = await activeFleet(admin, vendor.id);
  // DELIBERATELY SWALLOWED, BUT NEVER SILENTLY. The insert has already landed,
  // so there is no refusal left to make here — and unwinding a truck the vendor
  // successfully added because a recheck couldn't run would be the worse trade.
  // The cap is a sanity ceiling, not a money rule; the nightly self-heal and the
  // next add both re-apply it.
  if (afterRes.readError) console.error("[read failed] the truck cap recheck after adding:", afterRes.readError);
  const after = afterRes.units;
  if (after.length > MAX_ACTIVE_TRUCKS) {
    const newest = after[after.length - 1];
    await admin.from("crew_units").update({ active: false }).eq("id", newest.id).eq("vendor_id", vendor.id);
    return { ok: false, error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now.` };
  }

  // A truck phone is a standing destination for route texts (they carry the
  // day's stop map) — the number hears about it the moment it's enrolled,
  // so a typo'd digit surfaces on day one, not silently every morning.
  // A TRUCK HAS NO INBOX. crew_units holds a phone and nothing else — this
  // number IS the recipient, a cab phone that may belong to whoever is driving
  // today, so there is no second door to open here. What notify adds is that
  // the enrolment failing to queue now says so in the log instead of nowhere.
  if (built.row.phone) {
    await notify(
      "the truck phone that it now gets this crew's morning routes",
      { phone: built.row.phone },
      {
        sms: `LakeLife: this number now gets ${vendor.company ?? "your crew"}'s morning truck routes ("${built.row.name}"). Wrong number? Tell your crew office to fix it in the LakeLife app. 🌊`,
        subject: `This number now gets ${vendor.company ?? "your crew"}'s morning truck routes`,
      },
    );
  }
  return { ok: true };
}

/** Edit an existing truck's name/phone/capacity/hours. Active state is a separate toggle (setTruckActive). */
export async function updateTruck(unitId: string, input: TruckInput): Promise<TruckResult> {
  const me = await assertMyVendor();
  if (me.readError) return { ok: false, error: readFailedMessage("your crew account", me.readError) };
  const vendor = me.vendor;
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };
  }
  if (typeof unitId !== "string" || !unitId) return { ok: false, error: "Unknown truck." };

  const admin = createServiceClient();
  const own = await assertOwnUnit(admin, vendor.id, unitId);
  if (own.readError) return { ok: false, error: readFailedMessage("your trucks", own.readError) };
  if (!own.mine) return { ok: false, error: "Unknown truck." };

  const built = await buildRow(input);
  if ("error" in built) return { ok: false, error: built.error };

  // Transition guard: shrinking an ACTIVE truck's capacity or hours must
  // still cover the booked calendar (inactive trucks don't change the fleet).
  const fleetRes = await activeFleet(admin, vendor.id);
  // An unread fleet is an empty one, and an empty one makes `isActive` false —
  // which skips the transition guard below altogether, letting a vendor shrink
  // a working truck below the calendar it already has to cover.
  if (fleetRes.readError) return { ok: false, error: readFailedMessage("your trucks", fleetRes.readError) };
  const fleet = fleetRes.units;
  const isActive = fleet.some((u) => u.id === unitId);
  if (isActive) {
    const proposed = fleet.map((u) =>
      u.id === unitId ? { capacity: built.row.capacity, workStart: built.row.work_start, workEnd: built.row.work_end } : u,
    );
    const conflict = await forwardBookConflict(admin, vendor.id, vendor.daily_capacity, proposed);
    if (conflict) return { ok: false, error: conflict };
  }

  const prevRes = await admin.from("crew_units").select("phone").eq("id", unitId).maybeSingle();
  // This read is the only thing that knows whether the number actually CHANGED,
  // and the enrolment text below is conditioned on it. Failed, it read as "no
  // number before", so an unchanged truck phone was re-texted every save.
  // Nothing is written at this point.
  if (prevRes.error) return { ok: false, error: readFailedMessage("this truck's current details", prevRes.error) };
  const prev = prevRes.data;
  const { error } = await admin.from("crew_units").update(built.row).eq("id", unitId).eq("vendor_id", vendor.id);
  if (error) return { ok: false, error: error.message };
  // Same as addTruck: the truck phone is the whole recipient, so this one has
  // only the door it was born with. notify is here for the log line.
  if (built.row.phone && built.row.phone !== ((prev?.phone as string) ?? null)) {
    await notify(
      "the truck phone that it now gets this crew's morning routes",
      { phone: built.row.phone },
      {
        sms: `LakeLife: this number now gets ${vendor.company ?? "your crew"}'s morning truck routes ("${built.row.name}"). Wrong number? Tell your crew office to fix it in the LakeLife app. 🌊`,
        subject: `This number now gets ${vendor.company ?? "your crew"}'s morning truck routes`,
      },
    );
  }
  return { ok: true };
}

/** Deactivate (or reactivate) a truck. Reactivating re-checks the active cap. */
export async function setTruckActive(unitId: string, active: boolean): Promise<TruckResult> {
  const me = await assertMyVendor();
  if (me.readError) return { ok: false, error: readFailedMessage("your crew account", me.readError) };
  const vendor = me.vendor;
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — email hello@lakelife.ai and we'll sort it." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — email hello@lakelife.ai and we'll sort it." };
  }
  if (typeof unitId !== "string" || !unitId) return { ok: false, error: "Unknown truck." };

  const admin = createServiceClient();
  const own = await assertOwnUnit(admin, vendor.id, unitId);
  if (own.readError) return { ok: false, error: readFailedMessage("your trucks", own.readError) };
  if (!own.mine) return { ok: false, error: "Unknown truck." };

  const fleetRes = await activeFleet(admin, vendor.id);
  if (fleetRes.readError) return { ok: false, error: readFailedMessage("your trucks", fleetRes.readError) };
  const fleet = fleetRes.units;
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
    const rowRes = await admin
      .from("crew_units").select("capacity, work_start, work_end").eq("id", unitId).maybeSingle();
    // The `?? 0` fallbacks below turn a failed read into a truck with no
    // capacity and no hours — a fleet the transition guard then measures the
    // booked calendar against, refusing days that in fact fit fine. Nothing is
    // written at this point.
    if (rowRes.error) return { ok: false, error: readFailedMessage("this truck's details", rowRes.error) };
    const row = rowRes.data;
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

  // TRUCK-DOWN SELF-HEAL (zero-ops mid-day recovery): a truck going down
  // mid-shift leaves its stops stranded on a route plan built for a fleet
  // that no longer exists — rebuild THIS VENDOR's routes for TODAY and
  // TOMORROW right away instead of waiting for the 8pm cron. AWAITED, not
  // fire-and-forget: serverless freezes detached promises the moment the
  // response ships, so a void'd rebuild silently never runs in production
  // (review finding, 2026-07-23). Scoped to this vendor so a toggle never
  // re-texts every crew on the platform. Failures degrade to the nightly
  // rebuild — the toggle itself must still succeed.
  if (!active) {
    try {
      const { runRouteBuild } = await import("@/lib/automation");
      const today = todayLakeDate();
      await runRouteBuild(today, vendor.id);
      await runRouteBuild(addDays(today, 1), vendor.id);
    } catch {
      /* nightly rebuild is the backstop */
    }
  }

  // Post-write cap recheck (check-then-write race), same rail as addTruck.
  if (active) {
    const afterRes = await activeFleet(admin, vendor.id);
    // Swallowed for the same reason as addTruck's recheck — the toggle has
    // already landed and turning the vendor's truck back off because a recheck
    // couldn't run is the worse outcome — but logged, never silent.
    if (afterRes.readError) console.error("[read failed] the truck cap recheck after toggling on:", afterRes.readError);
    const after = afterRes.units;
    if (after.length > MAX_ACTIVE_TRUCKS) {
      await admin.from("crew_units").update({ active: false }).eq("id", unitId).eq("vendor_id", vendor.id);
      return { ok: false, error: `You're at ${MAX_ACTIVE_TRUCKS} active trucks — that's the cap for now.` };
    }
  }
  return { ok: true };
}
