import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";
import { todayLakeDate } from "@/lib/booking";
import { decideDispatch, isEligible, remainingCapacity, type CrewCandidate, type DispatchDecision, type DispatchInput } from "@/lib/dispatch";
import { getVendorScores } from "@/lib/scoring-data";
import { toISODate } from "@/lib/booking";
import { getPlatformSettings } from "@/lib/settings";

// The margin floor now lives in the DATABASE (platform_settings, rule 8) —
// read via getPlatformSettings(); owner-tunable from the ops dashboard.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayOf(dateISO: string): string {
  return WEEKDAYS[new Date(dateISO + "T12:00:00").getDay()];
}

/** Service-role pricing profile by property id (works with no signed-in user,
 *  so the nightly self-heal can re-price against any property). Exported for
 *  the claim board, which prices each open job at the viewing crew's OWN rate. */
export async function loadPricingProfileById(
  admin: ReturnType<typeof createServiceClient>,
  propertyId: string,
): Promise<PricingProfile | null> {
  const [{ data: prop }, { data: pp }, { data: boats }, { data: toys }] = await Promise.all([
    admin.from("properties").select("sqft, beds, baths").eq("id", propertyId).maybeSingle(),
    admin.from("property_profile").select("*").eq("property_id", propertyId).maybeSingle(),
    admin.from("boats").select("type, length_ft, engine_type, engine_hp, engines").eq("property_id", propertyId),
    admin.from("toys").select("name").eq("property_id", propertyId),
  ]);
  if (!prop) return null;
  return {
    sqft: Number(prop.sqft ?? 0),
    beds: Number(prop.beds ?? 0),
    baths: Number(prop.baths ?? 0),
    pier_sections: Number(pp?.pier_sections ?? 0),
    boat_lifts: Number(pp?.boat_lifts ?? 0),
    toy_lifts: Number(pp?.toy_lifts ?? 0),
    jet_skis: Number(pp?.jet_skis ?? 0),
    pwc_lifts: Number(pp?.pwc_lifts ?? 0),
    lawn_band: (pp?.lawn_band as PricingProfile["lawn_band"]) ?? "medium",
    boats: (boats ?? []).map((b) => ({ type: b.type ?? undefined, length_ft: Number(b.length_ft) || 0 })),
    toys: (toys ?? []).map((t) => ({ name: t.name ?? undefined })),
  };
}

/** Build every crew candidate for a service+date, with their private rate priced
 *  against this property. All reads are service-role (dispatch is ops-authority).
 *  Exported for the scarcity-offer computation on the owner's requests page. */
export async function buildCandidates(
  admin: ReturnType<typeof createServiceClient>,
  opts: { serviceId: string; serviceName: string; pricingModel: ServiceRule["pricing_model"]; dateISO: string; profile: PricingProfile },
): Promise<CrewCandidate[]> {
  const [{ data: vendors }, { data: rates }, { data: dayJobs }, { data: blocks }, scores] = await Promise.all([
    admin.from("vendors").select("id, status, coi_expiry, service_types, service_lakes, work_days, daily_capacity, base_lat, base_lng"),
    admin.from("vendor_rates").select("vendor_id, base, unit_rate, band_pricing").eq("service_id", opts.serviceId),
    admin.from("jobs").select("vendor_id").eq("date", opts.dateISO).in("status", ["scheduled", "in_progress"]).not("vendor_id", "is", null),
    admin.from("vendor_availability").select("vendor_id").eq("date", opts.dateISO).eq("status", "blocked"),
    getVendorScores(), // real quality score (on-time + flag accuracy + volume), not a raw count
  ]);

  const rateByVendor = new Map((rates ?? []).map((r) => [r.vendor_id as string, r]));
  const assigned = new Map<string, number>();
  for (const j of dayJobs ?? []) assigned.set(j.vendor_id as string, (assigned.get(j.vendor_id as string) ?? 0) + 1);
  const blocked = new Set((blocks ?? []).map((b) => b.vendor_id as string));

  return (vendors ?? []).map((v) => {
    const vr = rateByVendor.get(v.id as string);
    let crewRate: number | null = null;
    if (vr) {
      const rule: ServiceRule = {
        name: opts.serviceName,
        pricing_model: opts.pricingModel,
        base: Number(vr.base ?? 0),
        unit_rate: Number(vr.unit_rate ?? 0),
        band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
      };
      crewRate = priceService(rule, opts.profile);
    }
    return {
      vendorId: v.id as string,
      status: v.status as string,
      coiExpiry: (v.coi_expiry as string) ?? null,
      serviceTypes: (v.service_types as string[]) ?? [],
      serviceLakes: (v.service_lakes as string[]) ?? [],
      workDays: (v.work_days as string[]) ?? [],
      dailyCapacity: Number(v.daily_capacity ?? 0),
      assignedThatDay: assigned.get(v.id as string) ?? 0,
      blockedThatDay: blocked.has(v.id as string),
      crewRate,
      score: scores.get(v.id as string)?.score ?? 0,
      baseLat: v.base_lat != null ? Number(v.base_lat) : null,
      baseLng: v.base_lng != null ? Number(v.base_lng) : null,
    };
  });
}

/**
 * Capacity-aware calendar availability for a service in a month. A date is
 * "full" when NO eligible crew has an open slot that day (real per-crew
 * capacity, not the old service-level number). If nobody does the service at
 * all, every date is full. Rate/floor is intentionally NOT checked here — a day
 * with capacity but no affordable crew still shows bookable and escalates to ops
 * at assignment time (per the dispatch design).
 */
export async function getServiceAvailability(
  serviceName: string,
  year: number,
  month: number, // 0-indexed
  lakeId: string | null = null, // when set, only crews servicing this lake count
): Promise<{ fullDates: string[]; capacity: number; findingCrew: boolean }> {
  const admin = createServiceClient();
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const to = toISODate(new Date(year, month + 1, 0));
  const today = todayLakeDate();

  const [{ data: vendors }, { data: blocks }, { data: dayJobs }] = await Promise.all([
    admin.from("vendors").select("id, status, coi_expiry, service_types, service_lakes, work_days, daily_capacity"),
    admin.from("vendor_availability").select("vendor_id, date").eq("status", "blocked").gte("date", from).lte("date", to),
    admin.from("jobs").select("vendor_id, date").in("status", ["scheduled", "in_progress"]).not("vendor_id", "is", null).gte("date", from).lte("date", to),
  ]);

  // Only crews that do this service — and, when a lake is given, service that
  // lake — can ever contribute capacity to this property's calendar.
  const pool = (vendors ?? []).filter(
    (v) =>
      ((v.service_types as string[]) ?? []).includes(serviceName) &&
      (!lakeId || ((v.service_lakes as string[]) ?? []).includes(lakeId)),
  );

  // COLD START (waitlist rung): when NO active crew serves this lake+service
  // at all, a wall of "full" dates would be a lie — nothing is full, there's
  // simply no crew YET. Keep every date open and flag it: the booking becomes
  // a "Finding a crew" waitlist row, which is itself the recruiting signal.
  if (!pool.some((v) => v.status === "active")) {
    return { fullDates: [], capacity: 0, findingCrew: true };
  }
  const maxDailyCap = pool.reduce((m, v) => m + Math.max(0, Number(v.daily_capacity ?? 0)), 0);

  const blockedByDate = new Map<string, Set<string>>();
  for (const b of blocks ?? []) {
    const s = blockedByDate.get(b.date as string) ?? new Set<string>();
    s.add(b.vendor_id as string);
    blockedByDate.set(b.date as string, s);
  }
  const assignedByKey = new Map<string, number>();
  for (const j of dayJobs ?? []) {
    const k = `${j.vendor_id}|${j.date}`;
    assignedByKey.set(k, (assignedByKey.get(k) ?? 0) + 1);
  }

  const fullDates: string[] = [];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso < today) continue; // past days are handled by the calendar's own status
    const weekday = weekdayOf(iso);
    const blockedSet = blockedByDate.get(iso) ?? new Set<string>();
    const crews: CrewCandidate[] = pool.map((v) => ({
      vendorId: v.id as string,
      status: v.status as string,
      coiExpiry: (v.coi_expiry as string) ?? null,
      serviceTypes: (v.service_types as string[]) ?? [],
      serviceLakes: (v.service_lakes as string[]) ?? [],
      workDays: (v.work_days as string[]) ?? [],
      dailyCapacity: Number(v.daily_capacity ?? 0),
      assignedThatDay: assignedByKey.get(`${v.id}|${iso}`) ?? 0,
      blockedThatDay: blockedSet.has(v.id as string),
      crewRate: null,
      score: 0,
      baseLat: null,
      baseLng: null,
    }));
    const remaining = remainingCapacity({ date: iso, weekday, serviceName, todayISO: today, crews } as unknown as Parameters<typeof remainingCapacity>[0]);
    if (remaining <= 0) fullDates.push(iso);
  }

  return { fullDates, capacity: maxDailyCap, findingCrew: false };
}

export interface AssignOutcome {
  assigned: boolean;
  vendorId?: string;
  decision: DispatchDecision;
}

/**
 * Auto-assign (or re-assign) ONE job. Loads the job, builds candidates, runs the
 * pure engine, and applies the winner: vendor_id + vendor_cost (crew's rate) +
 * margin (menu − rate) + status 'scheduled'. If no crew fits, the job is LEFT
 * as-is (requested) — that's the ops "needs attention" bucket. Idempotent-safe:
 * only assigns jobs still awaiting a crew.
 */
export async function autoAssignJob(jobId: string): Promise<AssignOutcome> {
  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, property_id, service_id, date, status, customer_price, vendor_id, services(name, pricing_model)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !job.service_id || !job.date) {
    return { assigned: false, decision: { ok: false, reasonNoFit: "no_crew_for_service" } };
  }
  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string; pricing_model?: string } | null;
  const profile = await loadPricingProfileById(admin, job.property_id as string);
  if (!svc?.name || !profile) return { assigned: false, decision: { ok: false, reasonNoFit: "no_crew_for_service" } };

  const [{ data: prop }, settings] = await Promise.all([
    admin.from("properties").select("preferred_vendor, lake_id, lat, lng").eq("id", job.property_id as string).maybeSingle(),
    getPlatformSettings(),
  ]);

  const crews = await buildCandidates(admin, {
    serviceId: job.service_id as string,
    serviceName: svc.name,
    pricingModel: svc.pricing_model as ServiceRule["pricing_model"],
    dateISO: job.date as string,
    profile,
  });

  const decision = decideDispatch({
    date: job.date as string,
    weekday: weekdayOf(job.date as string),
    serviceName: svc.name,
    menuPrice: Number(job.customer_price ?? 0),
    todayISO: todayLakeDate(),
    marginFloor: settings.marginFloor,
    preferredVendorId: (prop?.preferred_vendor as string) ?? null,
    lakeId: (prop?.lake_id as string) ?? null,
    jobLat: prop?.lat != null ? Number(prop.lat) : null,
    jobLng: prop?.lng != null ? Number(prop.lng) : null,
    crews,
  });

  if (!decision.ok || !decision.result) return { assigned: false, decision };
  const winnerId = decision.result.vendorId;

  // Apply — but only to a job that still needs a crew (no double-assign races).
  const { data: changed } = await admin
    .from("jobs")
    .update({
      vendor_id: winnerId,
      vendor_cost: decision.result.crewRate,
      margin: decision.result.margin,
      status: "scheduled",
    })
    .eq("id", jobId)
    .in("status", ["requested"])
    .is("vendor_id", null)
    .select("id");

  let applied = !!changed && changed.length > 0;

  // Capacity backstop for the concurrent case: two bookings can both read the
  // crew at the same pre-assignment count and both assign. Re-count AFTER the
  // write; if we pushed the winner over their daily cap, release THIS job back
  // to 'requested' so it re-dispatches instead of overbooking the crew.
  if (applied) {
    const cap = crews.find((c) => c.vendorId === winnerId)?.dailyCapacity ?? 0;
    const { count } = await admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("vendor_id", winnerId)
      .eq("date", job.date as string)
      .in("status", ["scheduled", "in_progress"]);
    if (cap > 0 && (count ?? 0) > cap) {
      await admin
        .from("jobs")
        .update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested" })
        .eq("id", jobId);
      applied = false;
    }
  }

  return { assigned: applied, vendorId: applied ? winnerId : undefined, decision };
}

export interface RevalidateOutcome {
  rehomed: boolean; // the assigned crew became ineligible and we re-dispatched
  nowAssigned: boolean; // after re-dispatch, a crew holds it
}

/**
 * Self-heal ONE scheduled job: if its assigned crew is no longer eligible for
 * that date (suspended, COI lapsed, blocked the day, dropped the service, over
 * capacity), unassign it and waterfall to the next eligible crew. Silent — the
 * only visible effect is the route the crew sees. Unassigned 'requested' jobs
 * are simply (re)assigned.
 */
export async function revalidateJob(jobId: string): Promise<RevalidateOutcome> {
  const admin = createServiceClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id, property_id, service_id, date, status, vendor_id, customer_price, services(name, pricing_model), properties(lake_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !job.service_id || !job.date) return { rehomed: false, nowAssigned: false };

  // A requested job just needs assignment.
  if (job.status === "requested" || !job.vendor_id) {
    const r = await autoAssignJob(jobId);
    return { rehomed: false, nowAssigned: r.assigned };
  }
  if (job.status !== "scheduled") return { rehomed: false, nowAssigned: true };

  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string; pricing_model?: string } | null;
  const profile = await loadPricingProfileById(admin, job.property_id as string);
  if (!svc?.name || !profile) return { rehomed: false, nowAssigned: true };

  const crews = await buildCandidates(admin, {
    serviceId: job.service_id as string,
    serviceName: svc.name,
    pricingModel: svc.pricing_model as ServiceRule["pricing_model"],
    dateISO: job.date as string,
    profile,
  });
  const jobLake = (Array.isArray(job.properties) ? job.properties[0] : job.properties) as { lake_id?: string } | null;
  const input = {
    date: job.date as string,
    weekday: weekdayOf(job.date as string),
    serviceName: svc.name,
    todayISO: todayLakeDate(),
    lakeId: (jobLake?.lake_id as string) ?? null,
  } as DispatchInput;

  const current = crews.find((c) => c.vendorId === job.vendor_id);
  // The current crew's own slot counts as theirs — exclude it from "full" math.
  if (current) {
    const adjusted = { ...current, assignedThatDay: Math.max(0, current.assignedThatDay - 1) };
    if (isEligible(adjusted, input)) return { rehomed: false, nowAssigned: true };
  }

  // Assigned crew is no longer valid → release and re-dispatch.
  await admin.from("jobs").update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested", route_id: null, sequence: null }).eq("id", jobId);
  const r = await autoAssignJob(jobId);
  return { rehomed: true, nowAssigned: r.assigned };
}
