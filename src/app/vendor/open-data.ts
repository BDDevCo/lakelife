import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { todayLakeDate, lakeDateOf } from "@/lib/booking";
import { canClaim, milesBetween, gapTakeHome, gapOfferFor, gapJitter, type ClaimBlocker, type CrewCandidate } from "@/lib/dispatch";
import { isCoolingDown } from "@/lib/lake-standing";
import { fillInRate, rushWindowOpen } from "@/lib/rush";
import { loadPricingProfileById } from "@/app/book/dispatch";
import { getPlatformSettings } from "@/lib/settings";
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
  rush: boolean; // ⚡ same-day fill-in — takeHome already reflects the discount
  /** Fill-in offer (margin-gap design): takeHome IS the posted offer. */
  gap: boolean;
}

/**
 * The anti-harvest anchor: the crew's trailing-90-day LOWEST card for this
 * service, priced against THIS property. A card hike never raises a fill-in
 * offer because the anchor remembers the old card (vendor_rate_history).
 * All inputs are the crew's own numbers — rule-1 safe.
 */
export async function loadGapAnchor(
  admin: ReturnType<typeof createServiceClient>,
  vendorId: string,
  serviceId: string,
  serviceName: string,
  pricingModel: ServiceRule["pricing_model"],
  profile: NonNullable<Awaited<ReturnType<typeof loadPricingProfileById>>>,
  currentPriced: number | null,
): Promise<number | null> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  // OLDEST-first, wide limit: the pre-hike low card sits at the FRONT of the
  // window, so no amount of rapid rate-editing (spam rows are newest) can
  // flush it out of the sample and raise the anchor. It only ages out at the
  // designed 90-day decay. 500 edits/90d is far beyond honest use.
  const { data: hist } = await admin
    .from("vendor_rate_history")
    .select("base, unit_rate, band_pricing")
    .eq("vendor_id", vendorId)
    .eq("service_id", serviceId)
    .gte("changed_at", since)
    .order("changed_at", { ascending: true })
    .limit(500);
  let low = currentPriced != null && currentPriced > 0 ? currentPriced : null;
  for (const h of hist ?? []) {
    const priced = priceService({
      name: serviceName, pricing_model: pricingModel,
      base: Number(h.base ?? 0), unit_rate: Number(h.unit_rate ?? 0),
      band_pricing: (h.band_pricing as ServiceRule["band_pricing"]) ?? null,
    }, profile);
    if (priced > 0 && (low == null || priced < low)) low = priced;
  }
  return low;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BOARD_CAP = 30; // soonest-first; plenty for the board's purpose

/** Current lake-time hour — rush rows show only inside the rush window. */
function lakeHour(): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Indiana/Indianapolis", hour12: false, hour: "2-digit" }).format(new Date());
  return Number(h) % 24;
}

export async function getOpenJobs(vendor: MyVendor): Promise<OpenJob[]> {
  const admin = createServiceClient();
  const today = todayLakeDate();
  const settings = await getPlatformSettings();

  const { data: jobs } = await admin
    .from("jobs")
    .select("id, date, customer_price, service_id, property_id, is_rush, created_at, services(name, pricing_model), properties(lake_id, lat, lng, lakes(name))")
    .eq("status", "requested")
    .is("vendor_id", null)
    .is("group_id", null) // package visits are routed, never cold-claimed — a claim can't price multi-leg work, and custody is never a first-tap prize
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

  // One shot each: my rates, my assigned counts per date, my blocked dates,
  // and any lakes I'm paused on (Phase E cooldowns).
  const dates = [...new Set(doable.map((j) => j.date as string))];
  const [{ data: rates }, { data: myJobs }, { data: myBlocks }, { data: myPauses }] = await Promise.all([
    admin.from("vendor_rates").select("service_id, base, unit_rate, band_pricing").eq("vendor_id", vendor.id),
    admin.from("jobs").select("date").eq("vendor_id", vendor.id).in("status", ["scheduled", "in_progress"]).in("date", dates),
    admin.from("vendor_availability").select("date").eq("vendor_id", vendor.id).eq("status", "blocked").in("date", dates),
    admin.from("vendor_lake_demotions").select("lake_id, demoted_at").eq("vendor_id", vendor.id),
  ]);
  const pausedLakes = new Set(
    (myPauses ?? [])
      .filter((p) => isCoolingDown(p.demoted_at as string, settings.lakeDemotionCooldownDays, Date.now()))
      .map((p) => p.lake_id as string),
  );
  const rateBySvc = new Map((rates ?? []).map((r) => [r.service_id as string, r]));
  const assignedByDate = new Map<string, number>();
  for (const j of myJobs ?? []) assignedByDate.set(j.date as string, (assignedByDate.get(j.date as string) ?? 0) + 1);
  const blockedDates = new Set((myBlocks ?? []).map((b) => b.date as string));

  const rushOpen = rushWindowOpen(lakeHour(), settings.sameDayCutoffHour);
  const out: OpenJob[] = [];
  for (const j of doable) {
    // Rush rows are TODAY-only prizes: hidden once the window closes (the
    // cutoff rung rolls or cancels them), and a stale rush row on a past
    // date never renders.
    const isRushRow = !!(j as { is_rush?: boolean }).is_rush;
    if (isRushRow && (!rushOpen || (j.date as string) !== today)) continue;
    const svc = one(j.services) as { name?: string; pricing_model?: string } | null;
    const prop = one(j.properties) as { lake_id?: string; lat?: number; lng?: number; lakes?: unknown } | null;
    const lakeName = (one(prop?.lakes) as { name?: string } | null)?.name ?? "a nearby lake";

    // Price this job at the crew's OWN rate (their info — rule-1 safe).
    let takeHome: number | null = null;
    let cardPriced: number | null = null; // UNdiscounted card vs this property — the anchor input
    let profile: Awaited<ReturnType<typeof loadPricingProfileById>> = null;
    const vr = rateBySvc.get(j.service_id as string);
    if (vr && svc?.name) {
      const rule: ServiceRule = {
        name: svc.name,
        pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
        base: Number(vr.base ?? 0),
        unit_rate: Number(vr.unit_rate ?? 0),
        band_pricing: (vr.band_pricing as ServiceRule["band_pricing"]) ?? null,
      };
      profile = await loadPricingProfileById(admin, j.property_id as string);
      if (profile) cardPriced = priceService(rule, profile);
      takeHome = cardPriced;
      // Same-day fill-in: the board shows the DISCOUNTED take-home — tapping
      // Claim is accepting it (the discount is a dial, not a negotiation).
      if (takeHome != null && isRushRow) takeHome = fillInRate(takeHome, settings.sameDayFillDiscountPct);
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
    let verdict = canClaim(candidate, {
      serviceName: svc?.name ?? "",
      weekday: WEEKDAYS[new Date((j.date as string) + "T12:00:00").getDay()],
      todayISO: today,
      menuPrice: Number(j.customer_price ?? 0), // server-side only — never returned
      marginFloor: settings.marginFloor,
    });
    // Phase E: a cooling-down lake overrides everything else — be upfront.
    if (prop?.lake_id && pausedLakes.has(prop.lake_id as string)) {
      verdict = { ok: false, blocker: "lake_paused" };
    }

    // FILL-IN OFFER (margin-gap design): a job blocked ONLY on rate becomes a
    // posted-price offer once it has survived a full dispatch cycle (the age
    // gate kills hike-and-harvest plays; rush rows are exempt — their premium
    // already funds the gap). The offer is the crew's own anchor with a
    // haircut, clipped at the fuzzed floor-clearing ceiling — never more.
    // Age gate in LAKE time, failing CLOSED on a missing created_at — this is
    // a money control, so an unreadable birthdate means "not aged", never
    // "aged". Rush rows are exempt (their premium funds the gap).
    const createdLakeDate = j.created_at ? lakeDateOf(String(j.created_at)) : null;
    let isGap = false;
    if (
      verdict.blocker === "rate_too_high" &&
      (isRushRow || (createdLakeDate != null && createdLakeDate < today))
    ) {
      const tStar = gapTakeHome(Number(j.customer_price ?? 0), settings.marginFloor, gapJitter(j.id as string), settings.gapMinOffer);
      if (tStar != null && profile && svc?.name) {
        // Anchor on the UNdiscounted card — the rush discount never stacks
        // onto a fill-in offer (one haircut, never two), and the board must
        // post the same number the claim will write.
        const anchor = await loadGapAnchor(
          admin, vendor.id, j.service_id as string, svc.name,
          svc.pricing_model as ServiceRule["pricing_model"], profile,
          cardPriced,
        );
        const offer = gapOfferFor(tStar, anchor, settings.gapAnchorPct, settings.gapMinOffer);
        if (offer != null) {
          takeHome = offer;
          verdict = { ok: true };
          isGap = true;
        }
      }
    }

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
      rush: isRushRow,
      gap: isGap,
    });
  }

  // Rush first (it expires at the cutoff), then own lakes, then nearest,
  // then soonest — the crew's natural priority.
  out.sort((a, b) => {
    if (a.rush !== b.rush) return a.rush ? -1 : 1;
    if (a.onMyLake !== b.onMyLake) return a.onMyLake ? -1 : 1;
    const da = a.milesAway ?? Infinity, db = b.milesAway ?? Infinity;
    if (da !== db) return da - db;
    return a.date < b.date ? -1 : 1;
  });
  return out;
}
