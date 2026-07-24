import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";
import { todayLakeDate } from "@/lib/booking";
import { decideDispatch, isEligible, remainingCapacity, type CrewCandidate, type DispatchDecision, type DispatchInput } from "@/lib/dispatch";
import { fleetJobCap, fleetMinuteBudget, fitsTimeBudget, jobMinutesOf, DEFAULT_JOB_MINUTES } from "@/lib/fleet";
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
export interface VisitComponent {
  serviceId: string;
  serviceName: string;
  pricingModel: ServiceRule["pricing_model"];
  /** services.est_minutes for the leg — feeds the fleet time budget. */
  estMinutes?: number;
}

export async function buildCandidates(
  admin: ReturnType<typeof createServiceClient>,
  opts: {
    serviceId: string; serviceName: string; pricingModel: ServiceRule["pricing_model"];
    dateISO: string; profile: PricingProfile;
    /** Package visits (S2): price the crew across EVERY leg — a missing
     *  component rate means no rate at all (legs are capabilities). */
    components?: VisitComponent[];
    /** Present when the visit stores the boat — loads the feet ledger. */
    storage?: { tier: "outdoor" | "indoor"; boatFeet: number } | null;
    /** Re-dispatch: this group's OWN reserved stay must not count against
     *  the incumbent barn (the committed feet ARE this boat). */
    excludeGroupId?: string | null;
  },
): Promise<CrewCandidate[]> {
  const comps: VisitComponent[] = opts.components?.length
    ? opts.components
    : [{ serviceId: opts.serviceId, serviceName: opts.serviceName, pricingModel: opts.pricingModel }];
  const [{ data: vendors }, { data: rates }, { data: dayJobs }, { data: blocks }, scores, { data: stays }, { data: units }] = await Promise.all([
    admin.from("vendors").select("id, status, coi_expiry, service_types, service_lakes, work_days, daily_capacity, base_lat, base_lng, storage_capacity_feet, storage_types, garagekeepers_expiry"),
    admin.from("vendor_rates").select("vendor_id, service_id, base, unit_rate, band_pricing").in("service_id", comps.map((c) => c.serviceId)),
    admin.from("jobs").select("vendor_id, group_id, services(est_minutes), job_items(services(est_minutes))").eq("date", opts.dateISO).in("status", ["scheduled", "in_progress"]).not("vendor_id", "is", null),
    admin.from("vendor_availability").select("vendor_id").eq("date", opts.dateISO).eq("status", "blocked"),
    getVendorScores(), // real quality score (on-time + flag accuracy + volume), not a raw count
    opts.storage
      ? admin.from("storage_stays").select("vendor_id, boat_feet, group_id").in("status", ["reserved", "in_storage"])
      : Promise.resolve({ data: null as Array<{ vendor_id: string; boat_feet: number; group_id: string }> | null }),
    admin.from("crew_units").select("vendor_id, capacity, work_start, work_end").eq("active", true),
  ]);

  const rateByKey = new Map((rates ?? []).map((r) => [`${r.vendor_id}|${r.service_id}`, r]));
  const assigned = new Map<string, number>();
  const assignedMin = new Map<string, number>();
  for (const j of dayJobs ?? []) {
    const vid = j.vendor_id as string;
    assigned.set(vid, (assigned.get(vid) ?? 0) + 1);
    // Package visits cost the SUM of their legs — the same number their
    // admission was charged (jobMinutesOf; review finding).
    const svc = (Array.isArray(j.services) ? j.services[0] : j.services) as { est_minutes?: number } | null;
    const legs = (j as { group_id?: string | null }).group_id
      ? ((j as { job_items?: Array<{ services?: unknown }> }).job_items ?? []).map((it) => {
          const s = (Array.isArray(it.services) ? it.services[0] : it.services) as { est_minutes?: number } | null;
          return s?.est_minutes ?? null;
        })
      : null;
    assignedMin.set(vid, (assignedMin.get(vid) ?? 0) + jobMinutesOf(svc?.est_minutes, legs));
  }
  const blocked = new Set((blocks ?? []).map((b) => b.vendor_id as string));
  // Fleet layer (docs/fleet-routing-design.md): with trucks, the cap is the
  // fleet's sum and a minute budget activates; without, both fall back to
  // the legacy vendor numbers (budget null = gate off) — the invariant.
  const unitsByVendor = new Map<string, { capacity: number; workStart: number; workEnd: number }[]>();
  for (const u of units ?? []) {
    const list = unitsByVendor.get(u.vendor_id as string) ?? [];
    list.push({ capacity: Number(u.capacity ?? 0), workStart: Number(u.work_start ?? 0), workEnd: Number(u.work_end ?? 0) });
    unitsByVendor.set(u.vendor_id as string, list);
  }
  const committed = new Map<string, number>();
  for (const st of stays ?? []) {
    if (opts.excludeGroupId && (st as { group_id?: string }).group_id === opts.excludeGroupId) continue;
    committed.set(st.vendor_id as string, (committed.get(st.vendor_id as string) ?? 0) + Number(st.boat_feet ?? 0));
  }

  // Capability-by-rate (review fix): component legs never appear in the
  // service-type picker (they're not menu tiles), so a crew's capability
  // for a leg IS their rate card — "no rate means the machine never sends
  // you that work", exactly as the rates page promises. Synthesize the
  // names so the pure engine's coverage check stays a set test.
  const rateNamesByVendor = new Map<string, string[]>();
  if (opts.components?.length) {
    const nameById = new Map(comps.map((c) => [c.serviceId, c.serviceName]));
    for (const r of rates ?? []) {
      const nm = nameById.get(r.service_id as string);
      if (!nm) continue;
      const list = rateNamesByVendor.get(r.vendor_id as string) ?? [];
      list.push(nm);
      rateNamesByVendor.set(r.vendor_id as string, list);
    }
  }

  return (vendors ?? []).map((v) => {
    // Sum this crew's private rate across every leg of the visit. Any leg
    // without a rate row ⇒ no rate at all — the crew can't take the visit.
    let crewRate: number | null = 0;
    for (const comp of comps) {
      const vr = rateByKey.get(`${v.id}|${comp.serviceId}`);
      if (!vr) { crewRate = null; break; }
      const rule: ServiceRule = {
        name: comp.serviceName,
        pricing_model: comp.pricingModel,
        base: Number(vr.base ?? 0),
        unit_rate: Number(vr.unit_rate ?? 0),
        band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
      };
      crewRate += priceService(rule, opts.profile);
    }
    return {
      vendorId: v.id as string,
      status: v.status as string,
      coiExpiry: (v.coi_expiry as string) ?? null,
      serviceTypes: [
        ...(((v.service_types as string[]) ?? [])),
        ...(rateNamesByVendor.get(v.id as string) ?? []),
      ],
      serviceLakes: (v.service_lakes as string[]) ?? [],
      workDays: (v.work_days as string[]) ?? [],
      dailyCapacity: fleetJobCap(unitsByVendor.get(v.id as string) ?? [], Number(v.daily_capacity ?? 0)),
      assignedThatDay: assigned.get(v.id as string) ?? 0,
      blockedThatDay: blocked.has(v.id as string),
      minuteBudget: fleetMinuteBudget(unitsByVendor.get(v.id as string) ?? []),
      assignedMinutes: assignedMin.get(v.id as string) ?? 0,
      crewRate,
      score: scores.get(v.id as string)?.score ?? 0,
      baseLat: v.base_lat != null ? Number(v.base_lat) : null,
      baseLng: v.base_lng != null ? Number(v.base_lng) : null,
      storageCapacityFeet: Number(v.storage_capacity_feet ?? 0),
      storageCommittedFeet: committed.get(v.id as string) ?? 0,
      storageTypes: (v.storage_types as string[]) ?? [],
      garagekeepersExpiry: (v.garagekeepers_expiry as string) ?? null,
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

  const [{ data: vendors }, { data: blocks }, { data: dayJobs }, { data: units }] = await Promise.all([
    admin.from("vendors").select("id, status, coi_expiry, service_types, service_lakes, work_days, daily_capacity"),
    admin.from("vendor_availability").select("vendor_id, date").eq("status", "blocked").gte("date", from).lte("date", to),
    admin.from("jobs").select("vendor_id, date").in("status", ["scheduled", "in_progress"]).not("vendor_id", "is", null).gte("date", from).lte("date", to),
    admin.from("crew_units").select("vendor_id, capacity").eq("active", true),
  ]);
  // Fleet cap: trucks sum where they exist, legacy number otherwise. The
  // calendar stays count-based on purpose — the time budget is enforced at
  // dispatch/claim, where the actual job's duration is known.
  const unitCapByVendor = new Map<string, { capacity: number }[]>();
  for (const u of units ?? []) {
    const list = unitCapByVendor.get(u.vendor_id as string) ?? [];
    list.push({ capacity: Number(u.capacity ?? 0) });
    unitCapByVendor.set(u.vendor_id as string, list);
  }

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
  const maxDailyCap = pool.reduce((m, v) => m + Math.max(0, fleetJobCap(unitCapByVendor.get(v.id as string) ?? [], Number(v.daily_capacity ?? 0))), 0);

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
      dailyCapacity: fleetJobCap(unitCapByVendor.get(v.id as string) ?? [], Number(v.daily_capacity ?? 0)),
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
    .select("id, property_id, service_id, date, status, customer_price, vendor_id, group_id, services(name, pricing_model, est_minutes)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !job.service_id || !job.date) {
    return { assigned: false, decision: { ok: false, reasonNoFit: "no_crew_for_service" } };
  }
  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string; pricing_model?: string; est_minutes?: number } | null;
  const profile = await loadPricingProfileById(admin, job.property_id as string);
  if (!svc?.name || !profile) return { assigned: false, decision: { ok: false, reasonNoFit: "no_crew_for_service" } };

  // Package visits (S2): the job's line items are its legs. Every leg is a
  // capability the crew must cover; a storage leg brings the custody gates.
  let components: VisitComponent[] | undefined;
  let storage: { tier: "outdoor" | "indoor"; boatFeet: number } | null = null;
  if (job.group_id) {
    const { data: items } = await admin
      .from("job_items")
      .select("service_id, services(name, pricing_model, est_minutes)")
      .eq("job_id", jobId);
    if (!items || items.length === 0) {
      // Booking is mid-flight (items land right after the job row) — do not
      // price a bundle as its anchor leg alone. The next sweep gets it.
      return { assigned: false, decision: { ok: false, reasonNoFit: "no_crew_for_service" } };
    }
    {
      components = items.map((it) => {
        const isvc = (Array.isArray(it.services) ? it.services[0] : it.services) as { name?: string; pricing_model?: string; est_minutes?: number } | null;
        return {
          serviceId: it.service_id as string,
          serviceName: isvc?.name ?? "",
          pricingModel: (isvc?.pricing_model ?? "flat") as ServiceRule["pricing_model"],
          estMinutes: Number(isvc?.est_minutes ?? 0),
        };
      }).filter((c) => c.serviceName);
      const tierComp = components.find((c) => c.pricingModel === "seasonal_plus_perdiem");
      if (tierComp) {
        // Tier comes from DATA (band_pricing.storage_type) so a rule-8
        // rename can never silently downgrade the custody gate; the name
        // is only the legacy fallback.
        const { data: tierSvc } = await admin
          .from("services").select("band_pricing").eq("id", tierComp.serviceId).maybeSingle();
        const declared = (tierSvc?.band_pricing as { storage_type?: string } | null)?.storage_type;
        storage = {
          tier: declared === "indoor" || declared === "outdoor"
            ? declared
            : tierComp.serviceName.toLowerCase().includes("indoor") ? "indoor" : "outdoor",
          boatFeet: profile.boats.reduce((sum, b) => sum + (Number(b.length_ft) || 0), 0),
        };
      }
    }
  }

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
    components,
    storage,
    excludeGroupId: (job.group_id as string) ?? null,
  });

  // Visit duration for the fleet time budget: the one service's dial, or a
  // package's legs summed (each missing dial contributes the engine default).
  const jobMinutes = components?.length
    ? components.reduce((s, c) => s + ((c.estMinutes ?? 0) > 0 ? (c.estMinutes as number) : DEFAULT_JOB_MINUTES), 0)
    : Number(svc.est_minutes ?? 0) > 0 ? Number(svc.est_minutes) : DEFAULT_JOB_MINUTES;

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
    componentNames: components?.map((c) => c.serviceName),
    jobMinutes,
    storage,
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
    const winner = crews.find((c) => c.vendorId === winnerId);
    const cap = winner?.dailyCapacity ?? 0;
    const { data: dayNow } = await admin
      .from("jobs")
      .select("id, group_id, services(est_minutes), job_items(services(est_minutes))")
      .eq("vendor_id", winnerId)
      .eq("date", job.date as string)
      .in("status", ["scheduled", "in_progress"]);
    const count = (dayNow ?? []).length;
    // Fleet mirror of the count backstop: two concurrent long jobs can each
    // pass the pre-write time gate — re-sum the day's minutes AFTER the
    // write and release if the fleet's hours busted (review finding).
    const minutesNow = (dayNow ?? []).reduce((s, r) => {
      const svcEm = (Array.isArray(r.services) ? r.services[0] : r.services) as { est_minutes?: number } | null;
      const legs = (r as { group_id?: string | null }).group_id
        ? ((r as { job_items?: Array<{ services?: unknown }> }).job_items ?? []).map((it) => {
            const s = (Array.isArray(it.services) ? it.services[0] : it.services) as { est_minutes?: number } | null;
            return s?.est_minutes ?? null;
          })
        : null;
      return s + jobMinutesOf(svcEm?.est_minutes, legs);
    }, 0);
    const budget = winner?.minuteBudget ?? null;
    const busted = (cap > 0 && count > cap) || (budget != null && !fitsTimeBudget(minutesNow, 0, budget));
    if (busted) {
      await admin
        .from("jobs")
        .update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested" })
        .eq("id", jobId);
      applied = false;
    }
  }

  // Package bookkeeping (S2), only once the assignment stuck: stamp each
  // line item with THIS crew's per-leg rate (ops-only economics per leg),
  // pin the storing vendor on the season envelope, and hold their feet.
  if (applied && job.group_id && components?.length) {
    try {
      let custodyOk = true;
      const { data: rateRows } = await admin
        .from("vendor_rates")
        .select("service_id, base, unit_rate, band_pricing")
        .eq("vendor_id", winnerId)
        .in("service_id", components.map((c) => c.serviceId));
      const byService = new Map((rateRows ?? []).map((r) => [r.service_id as string, r]));
      for (const comp of components) {
        const vr = byService.get(comp.serviceId);
        if (!vr) continue;
        const cost = priceService({
          name: comp.serviceName, pricing_model: comp.pricingModel,
          base: Number(vr.base ?? 0), unit_rate: Number(vr.unit_rate ?? 0),
          band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
        }, profile);
        await admin.from("job_items").update({ vendor_cost: cost }).eq("job_id", jobId).eq("service_id", comp.serviceId);
      }
      if (storage) {
        await admin.from("job_groups").update({ storing_vendor: winnerId }).eq("id", job.group_id as string);
        const { data: stay } = await admin
          .from("storage_stays").select("id, status").eq("group_id", job.group_id as string).maybeSingle();
        if (!stay) {
          // Boat label (polish item 3): storage_stays carries its own label so
          // ops/crew custody views read the boat without a price-bearing join
          // back to the profile. Mirrors the exact display format used in the
          // wizard/profile/storage pages (e.g. "22' Tritoon · 150hp outboard").
          const { data: boatRows } = await admin
            .from("boats")
            .select("type, length_ft, engine_type, engine_hp, engines")
            .eq("property_id", job.property_id as string);
          const boatLabel = (boatRows ?? [])
            .map((b) => {
              const eng = b.engine_type && b.engine_type !== "none"
                ? ` · ${(Number(b.engines) || 1) > 1 ? "twin " : ""}${b.engine_hp ? `${b.engine_hp}hp ` : ""}${b.engine_type}`
                : "";
              return `${b.length_ft}' ${b.type}${eng}`;
            })
            .join(" + ") || null;
          const { error: stayErr } = await admin.from("storage_stays").insert({
            group_id: job.group_id, vendor_id: winnerId, boat_feet: storage.boatFeet, boat_label: boatLabel, status: "reserved",
          });
          if (stayErr) custodyOk = false; // no stay = no custody assignment, period
        } else if (stay.status === "reserved") {
          // Pre-intake re-dispatch may move the reservation; an in_storage
          // stay never moves — the boat is physically in that barn.
          const { error: stayErr } = await admin
            .from("storage_stays").update({ vendor_id: winnerId, boat_feet: storage.boatFeet }).eq("id", stay.id as string);
          if (stayErr) custodyOk = false;
        }

        // FEET BACKSTOP (mirror of the daily-cap backstop): two concurrent
        // bookings can both read the pool pre-insert and both pass. Re-sum
        // AFTER the write; if this barn is now over capacity, release THIS
        // job (and its stay) back to the pool instead of overcommitting a
        // physical building for six months.
        if (custodyOk) {
          const [{ data: allStays }, { data: vRow }] = await Promise.all([
            admin.from("storage_stays").select("boat_feet, group_id").eq("vendor_id", winnerId).in("status", ["reserved", "in_storage"]),
            admin.from("vendors").select("storage_capacity_feet").eq("id", winnerId).maybeSingle(),
          ]);
          const total = (allStays ?? []).reduce((sum, st) => sum + Number(st.boat_feet ?? 0), 0);
          if (total > Number(vRow?.storage_capacity_feet ?? 0)) custodyOk = false;
        }

        if (!custodyOk) {
          await admin.from("storage_stays").delete().eq("group_id", job.group_id as string).eq("status", "reserved");
          await admin.from("job_groups").update({ storing_vendor: null }).eq("id", job.group_id as string);
          await admin.from("jobs")
            .update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested" })
            .eq("id", jobId);
          applied = false;
        }
      }
    } catch (e) {
      console.error("package bookkeeping failed; releasing assignment", jobId, e);
      await admin.from("storage_stays").delete().eq("group_id", job.group_id as string).eq("status", "reserved");
      await admin.from("job_groups").update({ storing_vendor: null }).eq("id", job.group_id as string);
      await admin.from("jobs")
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
    .select("id, property_id, service_id, date, status, vendor_id, customer_price, group_id, services(name, pricing_model, est_minutes), properties(lake_id)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || !job.service_id || !job.date) return { rehomed: false, nowAssigned: false };

  // A requested job just needs assignment.
  if (job.status === "requested" || !job.vendor_id) {
    const r = await autoAssignJob(jobId);
    return { rehomed: false, nowAssigned: r.assigned };
  }
  if (job.status !== "scheduled") return { rehomed: false, nowAssigned: true };

  // Package visits are never silently rehomed once scheduled (same hazard
  // class as same-day revalidation: multi-leg custody work needs a human-
  // visible change, not a midnight swap). Unassigned ones still flow through
  // autoAssignJob above, which is fully component-aware.
  if ((job as { group_id?: string | null }).group_id) return { rehomed: false, nowAssigned: true };

  const svc = (Array.isArray(job.services) ? job.services[0] : job.services) as { name?: string; pricing_model?: string; est_minutes?: number } | null;
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
  const ownMinutes = Number(svc.est_minutes ?? 0) > 0 ? Number(svc.est_minutes) : DEFAULT_JOB_MINUTES;
  const input = {
    date: job.date as string,
    weekday: weekdayOf(job.date as string),
    serviceName: svc.name,
    todayISO: todayLakeDate(),
    lakeId: (jobLake?.lake_id as string) ?? null,
    jobMinutes: ownMinutes,
  } as DispatchInput;

  const current = crews.find((c) => c.vendorId === job.vendor_id);
  // The current crew's own slot counts as theirs — exclude it from "full"
  // math, BOTH the job count and this job's own minutes (a fleet vendor's
  // job must not double-count against its own time budget every night).
  if (current) {
    const adjusted = {
      ...current,
      assignedThatDay: Math.max(0, current.assignedThatDay - 1),
      assignedMinutes: Math.max(0, (current.assignedMinutes ?? 0) - ownMinutes),
    };
    if (isEligible(adjusted, input)) return { rehomed: false, nowAssigned: true };
  }

  // Assigned crew is no longer valid → release and re-dispatch.
  await admin.from("jobs").update({ vendor_id: null, vendor_cost: null, margin: null, status: "requested", route_id: null, sequence: null }).eq("id", jobId);
  const r = await autoAssignJob(jobId);
  return { rehomed: true, nowAssigned: r.assigned };
}
