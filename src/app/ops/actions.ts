"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { todayLakeDate } from "@/lib/booking";
import { planVendorDay, routeMapUrl, type StopIn } from "@/lib/router";
import { assertOps } from "./data";

export interface OpsResult {
  ok: boolean;
  error?: string;
}

const SLOTS = new Set(["8a", "10a", "1p", "3p"]);

function isISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Subtract days from an ISO date string, returning ISO (no TZ drift). */
function minusDays(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Assign a job to a vendor and schedule it (the core ops move). Sets the
 * vendor cost, derives margin = customer_price − vendor_cost, moves the job to
 * `scheduled`, and texts both crew and owner. Enforced server-side:
 *  - ops only,
 *  - vendor must be active with a valid (unexpired) COI — no COI, no jobs,
 *  - vendor_cost is bounded to [0, customer_price] so margin can't go negative
 *    or exceed the price,
 *  - the job must already carry a customer_price (priced at booking).
 */
export async function assignAndSchedule(
  jobId: string,
  input: { vendorId: string; vendorCost: number; date: string; slot: string },
): Promise<OpsResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, status, customer_price, property_id, service_id, services(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };
  if (!["requested", "scheduled"].includes(job.status as string)) {
    return { ok: false, error: `Can't reschedule a job that's ${job.status}.` };
  }
  if (job.customer_price == null) {
    return { ok: false, error: "This job has no customer price yet — it can't be costed." };
  }

  // Validate the schedule inputs.
  if (!isISODate(input.date)) return { ok: false, error: "Pick a valid date." };
  if (input.date < todayLakeDate()) return { ok: false, error: "That date is in the past." };
  if (!SLOTS.has(input.slot)) return { ok: false, error: "Pick a valid time slot." };

  // Validate the vendor: must be active with a valid COI (spec: no COI, no jobs).
  const { data: vendor } = await admin
    .from("vendors")
    .select("id, company, status, coi_expiry, user_id")
    .eq("id", input.vendorId)
    .maybeSingle();
  if (!vendor || vendor.status !== "active") return { ok: false, error: "That vendor isn't active." };
  if (vendor.coi_expiry == null || String(vendor.coi_expiry) < todayLakeDate()) {
    return { ok: false, error: "That vendor's insurance (COI) is missing or expired — can't route them." };
  }

  // Validate the cost / margin. Quantize the cost to whole cents BEFORE the
  // bound check and before deriving margin, so vendor_cost + margin always
  // reconciles exactly to customer_price (no fractional-cent drift).
  const price = Number(job.customer_price);
  const cost = Math.round(Number(input.vendorCost) * 100) / 100;
  if (!Number.isFinite(cost) || cost < 0 || cost > price) {
    return { ok: false, error: `Vendor cost must be between $0 and the $${price.toFixed(0)} customer price.` };
  }
  const margin = Math.round((price - cost) * 100) / 100;

  const { data: changed, error } = await admin
    .from("jobs")
    .update({
      vendor_id: vendor.id,
      vendor_cost: cost,
      margin,
      date: input.date,
      slot: input.slot,
      status: "scheduled",
    })
    .eq("id", jobId)
    .in("status", ["requested", "scheduled"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!changed || changed.length === 0) return { ok: false, error: "Job changed underneath you — reload." };

  // Best-effort notifications. Vendor crew + homeowner (no prices to the crew).
  const svcName = ((Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string } | null)?.name ?? "a service";
  const prettyDate = new Date(input.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const { data: vUser } = await admin.from("users").select("phone").eq("id", vendor.user_id).maybeSingle();
  if (vUser?.phone) {
    void sendSms(vUser.phone as string, `LakeLife: new job on your route — ${svcName}, ${prettyDate} (${input.slot}). Opens in your Today list. 🌊`);
  }
  const { data: prop } = await admin
    .from("properties")
    .select("address, users(phone)")
    .eq("id", job.property_id)
    .maybeSingle();
  const ownerPhone = ((Array.isArray(prop?.users) ? prop?.users[0] : prop?.users) as { phone?: string } | null)?.phone;
  if (ownerPhone) {
    void sendSms(ownerPhone, `LakeLife: your ${svcName} is booked for ${prettyDate}. We'll text you when the crew is done, with photos. 🌊`);
  }

  return { ok: true };
}

export interface BuildRoutesResult extends OpsResult {
  routes?: number;
  stops?: number;
  overflow?: number;
  texted?: number;
}

/**
 * Router v1 (ops only): take a day's scheduled jobs, cluster each vendor's
 * stops by lake, order them in drive direction, cap at daily capacity, write
 * `routes` + per-job sequence, and text each crew their map link. Deterministic
 * rebuild: running it again replaces that day's routes. The nightly 8pm cron
 * calls exactly this; the button just runs it early.
 */
export async function buildRoutesForDate(dateISO?: string): Promise<BuildRoutesResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const date = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : minusDays(todayLakeDate(), -1); // default tomorrow

  const admin = createServiceClient();
  const { data: jobs, error: loadErr } = await admin
    .from("jobs")
    .select("id, vendor_id, properties(lat, lng, lakes(name)), vendors(daily_capacity, company, user_id, status, coi_expiry)")
    .eq("date", date)
    .eq("status", "scheduled")
    .not("vendor_id", "is", null);
  if (loadErr) return { ok: false, error: loadErr.message };

  const one = <T>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

  // Group by vendor; skip crews whose COI lapsed since assignment (spec: router skips them).
  const byVendor = new Map<string, { capacity: number; company: string | null; user_id: string | null; stops: StopIn[] }>();
  for (const j of jobs ?? []) {
    const v = one(j.vendors) as { daily_capacity?: number; company?: string; user_id?: string; status?: string; coi_expiry?: string } | null;
    if (!v || v.status !== "active" || !v.coi_expiry || String(v.coi_expiry) < todayLakeDate()) continue;
    const p = one(j.properties) as { lat?: number; lng?: number; lakes?: unknown } | null;
    const lake = one(p?.lakes) as { name?: string } | null;
    const key = j.vendor_id as string;
    if (!byVendor.has(key)) byVendor.set(key, { capacity: Number(v.daily_capacity ?? 0), company: v.company ?? null, user_id: v.user_id ?? null, stops: [] });
    byVendor.get(key)!.stops.push({ id: j.id as string, lat: p?.lat ?? null, lng: p?.lng ?? null, lake_name: lake?.name ?? null });
  }

  // Deterministic rebuild: clear this date's routes + sequences first.
  await admin.from("routes").delete().eq("date", date);
  await admin.from("jobs").update({ route_id: null, sequence: null }).eq("date", date).eq("status", "scheduled");

  let routes = 0, stops = 0, overflow = 0, texted = 0;
  for (const [vendorId, v] of byVendor) {
    const plan = planVendorDay(v.stops, v.capacity);
    if (!plan.ordered.length) continue;
    const mapUrl = routeMapUrl(plan.ordered);
    const { data: routeRow, error: rErr } = await admin
      .from("routes")
      .insert({ vendor_id: vendorId, date, stops_order: plan.ordered.map((s) => s.id), drive_minutes: plan.driveMinutes, map_url: mapUrl })
      .select("id")
      .single();
    if (rErr) return { ok: false, error: rErr.message };
    for (let i = 0; i < plan.ordered.length; i++) {
      await admin.from("jobs").update({ sequence: i + 1, route_id: routeRow.id }).eq("id", plan.ordered[i].id);
    }
    routes++; stops += plan.ordered.length; overflow += plan.overflow.length;

    if (v.user_id) {
      const { data: u } = await admin.from("users").select("phone").eq("id", v.user_id).maybeSingle();
      if (u?.phone) {
        const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        void sendSms(u.phone as string, `LakeLife route for ${pretty}: ${plan.ordered.length} stops, ~${plan.driveMinutes} min drive.${mapUrl ? " Map: " + mapUrl : ""} Full details in your Today list. 🌊`);
        texted++;
      }
    }
  }

  return { ok: true, routes, stops, overflow, texted };
}

/**
 * Update a lake's season dates (ops only). The pull deadline is derived, not
 * entered: hard freeze − 8 days (rule 7). Saving reflows the customer booking
 * calendar, which already reads ice_out_actual + pull_deadline.
 */
export async function updateLakeConditions(
  lakeId: string,
  input: { iceOut: string | null; hardFreeze: string | null },
): Promise<OpsResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const iceOut = input.iceOut === "" ? null : input.iceOut;
  const hardFreeze = input.hardFreeze === "" ? null : input.hardFreeze;
  if (iceOut != null && !isISODate(iceOut)) return { ok: false, error: "Ice-out must be a valid date." };
  if (hardFreeze != null && !isISODate(hardFreeze)) return { ok: false, error: "Hard freeze must be a valid date." };

  const pullDeadline = hardFreeze != null ? minusDays(hardFreeze, 8) : null;

  const admin = createServiceClient();
  const { error } = await admin
    .from("lakes")
    .update({ ice_out_actual: iceOut, hard_freeze_est: hardFreeze, pull_deadline: pullDeadline })
    .eq("id", lakeId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
