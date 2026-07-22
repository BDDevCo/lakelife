import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { todayLakeDate } from "@/lib/booking";
import { canClaim, milesBetween, type ClaimBlocker, type CrewCandidate } from "@/lib/dispatch";
import { loadPricingProfileById, MARGIN_FLOOR } from "@/app/book/dispatch";
import type { MyVendor } from "./data";

/**
 * CLAIM BOARD data (Phase D) — the crew-facing list of open jobs no crew holds
 * yet. RULE 1: a crew sees the service, lake, date, distance from their base,
 * and THEIR OWN take-home (their rate card priced against the property) — never
 * the customer price, the margin, or (pre-claim) the street address. The margin
 * floor is checked server-side against the hidden customer price; the crew only
 * ever learns "this one doesn't clear at your current rate."
 */

export interface OpenJob {
  id: string;
  serviceName: string;
  lakeName: string;
  date: string; // YYYY-MM-DD
  onMyLake: boolean; // job is on a lake this crew already services
  milesAway: number | null; // from crew base (null = crew has no base set)
  takeHome: number | null; // crew's own rate priced for this property (null = no rate set)
  claimable: boolean;
  blocker: ClaimBlocker | null; // why not, when not claimable
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BOARD_CAP = 30; // soonest-first; plenty for the board's purpose

export async function getOpenJobs(vendor: MyVendor): Promise<OpenJob[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();

  const { data: jobs } = await admin
    .from("jobs")
    .select("id, date, customer_price, service_id, property_id, services(name, pricing_model), properties(lake_id, lat, lng, lakes(name))")
    .eq("status", "requested")
    .is("vendor_id", null)
    .gte("date", today)
    .order("date", { ascending: true })
    .limit(BOARD_CAP);
  if (!jobs || jobs.length === 0) return [];

  const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

  // Only services this crew does belong on their board at all.
  const doable = jobs.filter((j) => {
    const svc = one(j.services) as { name?: string } | null;
    return !!svc?.name && vendor.service_types.includes(svc.name);
  });
  if (doable.length === 0) return [];

  // One shot each: my rates, my assigned counts per date, my blocked dates.
  const dates = [...new Set(doable.map((j) => j.date as string))];
  const [{ data: rates }, { data: myJobs }, { data: myBlocks }] = await Promise.all([
    admin.from("vendor_rates").select("service_id, base, unit_rate, band_pricing").eq("vendor_id", vendor.id),
    admin.from("jobs").select("date").eq("vendor_id", vendor.id).in("status", ["scheduled", "in_progress"]).in("date", dates),
    admin.from("vendor_availability").select("date").eq("vendor_id", vendor.id).eq("status", "blocked").in("date", dates),
  ]);
  const rateBySvc = new Map((rates ?? []).map((r) => [r.service_id as string, r]));
  const assignedByDate = new Map<string, number>();
  for (const j of myJobs ?? []) assignedByDate.set(j.date as string, (assignedByDate.get(j.date as string) ?? 0) + 1);
  const blockedDates = new Set((myBlocks ?? []).map((b) => b.date as string));

  const out: OpenJob[] = [];
  for (const j of doable) {
    const svc = one(j.services) as { name?: string; pricing_model?: string } | null;
    const prop = one(j.properties) as { lake_id?: string; lat?: number; lng?: number; lakes?: unknown } | null;
    const lakeName = (one(prop?.lakes) as { name?: string } | null)?.name ?? "a nearby lake";

    // Price this job at the crew's OWN rate (their info — rule-1 safe).
    let takeHome: number | null = null;
    const vr = rateBySvc.get(j.service_id as string);
    if (vr && svc?.name) {
      const rule: ServiceRule = {
        name: svc.name,
        pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
        base: Number(vr.base ?? 0),
        unit_rate: Number(vr.unit_rate ?? 0),
        band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
      };
      const profile = await loadPricingProfileById(admin, j.property_id as string);
      if (profile) takeHome = priceService(rule, profile);
    }

    const candidate: CrewCandidate = {
      vendorId: vendor.id,
      status: vendor.status,
      coiExpiry: vendor.coi_expiry,
      serviceTypes: vendor.service_types,
      serviceLakes: vendor.service_lakes,
      workDays: vendor.work_days,
      dailyCapacity: vendor.daily_capacity,
      assignedThatDay: assignedByDate.get(j.date as string) ?? 0,
      blockedThatDay: blockedDates.has(j.date as string),
      crewRate: takeHome != null && takeHome > 0 ? takeHome : null,
      score: 0,
      baseLat: vendor.base_lat,
      baseLng: vendor.base_lng,
    };
    const verdict = canClaim(candidate, {
      serviceName: svc?.name ?? "",
      weekday: WEEKDAYS[new Date((j.date as string) + "T12:00:00").getDay()],
      todayISO: today,
      menuPrice: Number(j.customer_price ?? 0), // server-side only — never returned
      marginFloor: MARGIN_FLOOR,
    });

    const miles = milesBetween(prop?.lat ?? null, prop?.lng ?? null, vendor.base_lat, vendor.base_lng);
    out.push({
      id: j.id as string,
      serviceName: svc?.name ?? "Service",
      lakeName,
      date: j.date as string,
      onMyLake: !!prop?.lake_id && vendor.service_lakes.includes(prop.lake_id as string),
      milesAway: Number.isFinite(miles) ? Math.round(miles) : null,
      takeHome,
      claimable: verdict.ok,
      blocker: verdict.blocker ?? null,
    });
  }

  // Own lakes first, then nearest, then soonest — the crew's natural priority.
  out.sort((a, b) => {
    if (a.onMyLake !== b.onMyLake) return a.onMyLake ? -1 : 1;
    const da = a.milesAway ?? Infinity, db = b.milesAway ?? Infinity;
    if (da !== db) return da - db;
    return a.date < b.date ? -1 : 1;
  });
  return out;
}
