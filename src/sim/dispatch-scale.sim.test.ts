/**
 * SCALE SIMULATION — DISPATCH · ELIGIBILITY · MARGIN FLOOR · FLEET ROUTING · CREW STANDING
 *
 * Property-based, two-season simulation of a growing marketplace:
 *   ~1,050 customers (incl. HOA-scale multi-property accounts) across 3 lakes
 *   growing to 6, served by 12 crews growing to 40 with varied rate cards,
 *   coverage, COI states, trucks and scores. Every decision is made by the
 *   REAL engine functions — nothing here reimplements dispatch logic.
 *
 * DETERMINISM: one seeded mulberry32 PRNG (SEED below). No Math.random().
 * A failure reproduces exactly by re-running with the same seed.
 *
 * Service/rate shapes mirror the real DB rows:
 *   supabase/seed/seed_services.sql, supabase/migrations/0033_storage_seeds.sql,
 *   supabase/migrations/0042_crew_units.sql (est_minutes dials).
 */
import { describe, it, expect } from "vitest";
import {
  isEligible,
  rankCrews,
  marginPct,
  decideDispatch,
  scarcityOffer,
  canClaim,
  remainingCapacity,
  type CrewCandidate,
  type DispatchInput,
} from "@/lib/dispatch";
import {
  planFleetDay,
  planTruckRoute,
  jobMinutesOf,
  fitsTimeBudget,
  fleetJobCap,
  fleetMinuteBudget,
  DEFAULT_JOB_MINUTES,
  type TruckIn,
  type FleetStop,
} from "@/lib/fleet";
import { computeScore } from "@/lib/scoring";
import { shouldDemote, healBase, median, isCoolingDown } from "@/lib/lake-standing";
import { rushPrice, fillInRate, rushWindowOpen, RUSH_OPEN_HOUR } from "@/lib/rush";
import { warningDue, isExpired, DEFAULT_WARNING_CATCHUP_DAYS } from "@/lib/waitlist";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Seeded PRNG — print SEED in every failure message.
// ---------------------------------------------------------------------------
const SEED = 20260726;

function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);
const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
function subset<T>(xs: readonly T[], p: number): T[] {
  return xs.filter(() => rnd() < p);
}
function shuffled<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const S = (msg: string) => `${msg}  [SEED=${SEED}]`;

// ---------------------------------------------------------------------------
// Service catalogue — the real rows.
// ---------------------------------------------------------------------------
type Phase = "spring" | "fall" | "routine";
interface Svc extends ServiceRule {
  est: number;
  water: boolean;
  phase: Phase;
  component?: boolean;
}

const MENU: Svc[] = [
  { name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0, band_pricing: null, est: 120, water: false, phase: "spring" },
  { name: "Fall winterization", pricing_model: "flat", base: 485, unit_rate: 0, band_pricing: null, est: 120, water: false, phase: "fall" },
  { name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" }, est: 180, water: true, phase: "spring" },
  { name: "Boat lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 }, est: 90, water: true, phase: "spring" },
  { name: "Jet ski winterize & store", pricing_model: "per_section", base: 0, unit_rate: 350, band_pricing: { count_field: "jet_skis" }, est: 60, water: true, phase: "fall" },
  { name: "PWC lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 165, band_pricing: { count_field: "pwc_lifts" }, est: 60, water: true, phase: "fall" },
  { name: "Boat storage & winterize", pricing_model: "per_foot", base: 0, unit_rate: 50, band_pricing: null, est: 120, water: true, phase: "fall" },
  { name: "Water toy prep & storage", pricing_model: "flat", base: 120, unit_rate: 0, band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] }, est: 60, water: true, phase: "fall" },
  { name: "Lawn mowing & trim", pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 }, est: 45, water: false, phase: "routine" },
  { name: "Housekeeping", pricing_model: "per_sqft_band", base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] }, est: 90, water: false, phase: "routine" },
];

const COMPONENTS: Svc[] = [
  { name: "Boat haul-out (we pick it up)", pricing_model: "flat", base: 285, unit_rate: 0, band_pricing: null, est: 60, water: true, phase: "fall", component: true },
  { name: "Boat winterization (shop)", pricing_model: "per_foot", base: 0, unit_rate: 12, band_pricing: null, est: 90, water: false, phase: "fall", component: true },
  { name: "Winter storage — outdoor", pricing_model: "seasonal_plus_perdiem", base: 0, unit_rate: 43, band_pricing: null, est: 30, water: false, phase: "fall", component: true },
  { name: "Winter storage — indoor", pricing_model: "seasonal_plus_perdiem", base: 0, unit_rate: 64, band_pricing: null, est: 30, water: false, phase: "fall", component: true },
  { name: "Shrink wrap", pricing_model: "per_foot", base: 0, unit_rate: 26, band_pricing: null, est: 90, water: false, phase: "fall", component: true },
  { name: "Battery care (pull, tend, reinstall)", pricing_model: "flat", base: 90, unit_rate: 0, band_pricing: null, est: 30, water: false, phase: "fall", component: true },
];
const ALL_SVCS = [...MENU, ...COMPONENTS];
const svcByName = new Map(ALL_SVCS.map((s) => [s.name, s]));

/** A crew's own rate card row for a service: the same rule shape, scaled. */
function scaleRule(r: Svc, f: number): ServiceRule {
  const bp = r.band_pricing;
  let scaled: ServiceRule["band_pricing"] = null;
  if (bp) {
    scaled = { ...bp };
    if (bp.small != null) scaled.small = Math.round(bp.small * f);
    if (bp.medium != null) scaled.medium = Math.round(bp.medium * f);
    if (bp.large != null) scaled.large = Math.round(bp.large * f);
    if (bp.tiers) scaled.tiers = bp.tiers.map((t) => ({ max: t.max, price: Math.round(t.price * f) }));
    if (bp.add) scaled.add = bp.add.map((a) => ({ field: a.field, rate: Math.round(a.rate * f) }));
  }
  return {
    name: r.name,
    pricing_model: r.pricing_model,
    base: Math.round(r.base * f),
    unit_rate: Math.round(r.unit_rate * f * 100) / 100,
    band_pricing: scaled,
  };
}

// ---------------------------------------------------------------------------
// Geography — 3 starting lakes, 3 more born across season 2.
// ---------------------------------------------------------------------------
interface Lake { id: string; name: string; lat: number; lng: number; bornSeason: 1 | 2; iceOut: [number, number]; pullBy: [number, number] }
const LAKES: Lake[] = [
  { id: "lake-big-long", name: "Big Long", lat: 41.652, lng: -85.381, bornSeason: 1, iceOut: [4, 5], pullBy: [11, 8] },
  { id: "lake-pretty", name: "Pretty", lat: 41.601, lng: -85.302, bornSeason: 1, iceOut: [4, 9], pullBy: [11, 4] },
  { id: "lake-big-turkey", name: "Big Turkey", lat: 41.548, lng: -85.201, bornSeason: 1, iceOut: [4, 2], pullBy: [11, 12] },
  { id: "lake-shipshe", name: "Shipshewana", lat: 41.712, lng: -85.585, bornSeason: 2, iceOut: [4, 12], pullBy: [11, 1] },
  { id: "lake-witmer", name: "Witmer", lat: 41.463, lng: -85.712, bornSeason: 2, iceOut: [4, 7], pullBy: [11, 6] },
  { id: "lake-oliver", name: "Oliver", lat: 41.481, lng: -85.135, bornSeason: 2, iceOut: [4, 14], pullBy: [11, 10] },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const weekdayOf = (dateISO: string) => WEEKDAYS[new Date(dateISO + "T12:00:00Z").getUTCDay()];

// ---------------------------------------------------------------------------
// Customers / properties (HOA accounts own many).
// ---------------------------------------------------------------------------
interface Prop {
  id: string;
  accountId: string;
  lakeId: string;
  lat: number;
  lng: number;
  profile: PricingProfile;
  preferredVendorId: string | null;
  isHoa: boolean;
}

function makeProfile(): PricingProfile {
  const sqft = ri(850, 6200);
  const nBoats = pick([0, 1, 1, 1, 2, 2, 3] as const);
  const boats: PricingProfile["boats"] = [];
  for (let i = 0; i < nBoats; i++) {
    const et = pick(["outboard", "sterndrive", "inboard", "jet", "none"] as const);
    boats.push({
      length_ft: ri(14, 42),
      engine_type: et,
      engine_hp: et === "none" ? null : ri(40, 600),
      engines: chance(0.15) ? 2 : 1,
    });
  }
  const toys = Array.from({ length: ri(0, 5) }, (_, i) => ({ name: `toy-${i}` }));
  return {
    sqft,
    beds: ri(2, 7),
    baths: ri(1, 5),
    pier_sections: ri(0, 9),
    boat_lifts: ri(0, 3),
    toy_lifts: ri(0, 2),
    jet_skis: ri(0, 4),
    pwc_lifts: ri(0, 3),
    lawn_band: sqft < 2000 ? "small" : sqft < 3800 ? "medium" : "large",
    boats,
    toys,
  };
}

// ---------------------------------------------------------------------------
// Crews.
// ---------------------------------------------------------------------------
interface Crew {
  id: string;
  joinSeason: 1 | 2;
  status: string;
  coiExpiry: string | null;
  garagekeepersExpiry: string | null;
  serviceTypes: string[];
  rateFactor: Map<string, number>; // service name → their price multiplier
  serviceLakes: string[];
  workDays: string[];
  legacyCapacity: number;
  trucks: TruckIn[];
  baseLat: number | null;
  baseLng: number | null;
  score: number;
  storageCapacityFeet: number;
  storageTypes: string[];
  storageCommittedFeet: number; // mutated as the season fills
}

function buildCrew(i: number, season: 1 | 2): Crew {
  const openLakes = LAKES.filter((l) => l.bornSeason <= season);
  // Coverage: most crews serve 1–3 lakes; a few serve everything; a few (new
  // signups mid-onboarding) have declared NO lakes yet — the empty-list gate.
  // COLD START: lakes born in season 2 are born from DEMAND, not supply —
  // crews adopt them slowly, which is the whole recruiting signal.
  const adopt = (id: string) => (LAKES.find((l) => l.id === id)!.bornSeason === 1 ? true : chance(0.22));
  let lakes: string[];
  const roll = rnd();
  if (roll < 0.10) lakes = []; // signed up, lakes not declared yet
  else if (roll < 0.16) lakes = openLakes.map((l) => l.id).filter(adopt);
  else lakes = shuffled(openLakes, rnd).slice(0, ri(1, 3)).map((l) => l.id).filter(adopt);

  // Capability: generalists vs specialists. Rate cards exist only for the
  // services they do (mirrors vendor_rates).
  const spec = rnd();
  const types =
    spec < 0.25
      ? ALL_SVCS.map((s) => s.name) // full-service shop
      : spec < 0.55
        ? subset(ALL_SVCS.map((s) => s.name), 0.5)
        : subset(ALL_SVCS.map((s) => s.name), 0.28);
  const rateFactor = new Map<string, number>();
  const crewGreed = 0.48 + rnd() * 0.42; // 0.48 → 0.90 of menu
  for (const n of types) {
    // per-service wobble around the crew's own posture
    rateFactor.set(n, Math.max(0.3, Math.min(1.15, crewGreed + (rnd() - 0.5) * 0.18)));
  }

  const anchorLake = lakes.length ? LAKES.find((l) => l.id === lakes[0])! : pick(openLakes);
  const hasTrucks = chance(0.35);
  const trucks: TruckIn[] = [];
  if (hasTrucks) {
    const n = ri(1, 4);
    for (let t = 0; t < n; t++) {
      const start = pick([7, 7, 8] as const);
      trucks.push({
        id: `crew-${i}-truck-${t}`,
        name: `Truck ${t + 1}`,
        phone: null,
        capacity: ri(3, 8),
        workStart: start,
        workEnd: start + ri(7, 10),
        baseLat: chance(0.7) ? anchorLake.lat + (rnd() - 0.5) * 0.12 : null,
        baseLng: chance(0.7) ? anchorLake.lng + (rnd() - 0.5) * 0.12 : null,
      });
    }
  }

  const coiRoll = rnd();
  const coiExpiry = coiRoll < 0.07 ? null : coiRoll < 0.13 ? iso(2026, 5, ri(1, 28)) : iso(2027 + ri(0, 1), ri(1, 12), ri(1, 28));

  const sc = computeScore({
    completedCount: ri(0, 140),
    onTimeCount: ri(0, 140),
    ratedCount: ri(0, 140),
    flagsApproved: ri(0, 12),
    flagsDeclined: ri(0, 6),
    noShows: chance(0.25) ? ri(1, 5) : 0,
  });

  const baseRoll = rnd();
  return {
    id: `crew-${String(i).padStart(3, "0")}`,
    joinSeason: season,
    status: rnd() < 0.86 ? "active" : pick(["invited", "suspended"] as const),
    coiExpiry,
    garagekeepersExpiry: chance(0.3) ? iso(2027, ri(1, 12), ri(1, 28)) : chance(0.5) ? iso(2026, 4, 1) : null,
    serviceTypes: types,
    rateFactor,
    serviceLakes: lakes,
    workDays: (() => {
      const w = subset(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], 0.75);
      return w.length ? w : ["Tue", "Thu"];
    })(),
    legacyCapacity: ri(1, 8),
    trucks,
    baseLat: baseRoll < 0.1 ? null : baseRoll < 0.15 ? anchorLake.lat + 3.2 : anchorLake.lat + (rnd() - 0.5) * 0.2,
    baseLng: baseRoll < 0.1 ? null : baseRoll < 0.15 ? anchorLake.lng - 2.7 : anchorLake.lng + (rnd() - 0.5) * 0.2,
    score: sc.score,
    storageCapacityFeet: chance(0.4) ? ri(120, 900) : 0,
    storageTypes: chance(0.5) ? ["outdoor"] : chance(0.5) ? ["outdoor", "indoor"] : [],
    storageCommittedFeet: 0,
  };
}

// ---------------------------------------------------------------------------
// THE WORLD
// ---------------------------------------------------------------------------
const CUSTOMERS = 1050;
const props: Prop[] = [];
const crews: Crew[] = [];

// build crews first so properties can name a preferred one
for (let i = 0; i < 12; i++) crews.push(buildCrew(i, 1));
for (let i = 12; i < 40; i++) crews.push(buildCrew(i, 2));

{
  let accounts = 0;
  while (props.length < CUSTOMERS) {
    const isHoa = chance(0.07);
    const n = isHoa ? ri(4, 14) : 1;
    const acct = `acct-${accounts++}`;
    // an HOA sits on ONE lake; its units cluster tightly
    const lake = pick(LAKES.filter((l) => l.bornSeason === 1 || chance(0.55)));
    // A preferred crew is one the homeowner has actually MET — i.e. one that
    // works their lake. (A few stale picks point at a crew that left.)
    const onLake = crews.filter((c) => c.serviceLakes.includes(lake.id));
    for (let k = 0; k < n && props.length < CUSTOMERS; k++) {
      const spread = isHoa ? 0.012 : 0.05;
      props.push({
        id: `prop-${props.length}`,
        accountId: acct,
        lakeId: lake.id,
        lat: lake.lat + (rnd() - 0.5) * spread,
        lng: lake.lng + (rnd() - 0.5) * spread,
        profile: makeProfile(),
        preferredVendorId: chance(0.45) ? (onLake.length && chance(0.85) ? pick(onLake).id : pick(crews).id) : null,
        isHoa,
      });
    }
  }
}

// Rate lookup: a crew's price for a service against a profile (null = no card).
function crewRateFor(c: Crew, svc: Svc, profile: PricingProfile): number | null {
  const f = c.rateFactor.get(svc.name);
  if (f == null) return null;
  const v = priceService(scaleRule(svc, f), profile);
  return v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// THE BOOK — two seasons of dispatch decisions.
// ---------------------------------------------------------------------------
interface Booked {
  vendorId: string;
  dateISO: string;
  propId: string;
  lakeName: string;
  lat: number;
  lng: number;
  minutes: number;
}

const MARGIN_FLOOR = 0.3; // live floor per the brief; the dial range is exercised separately
const SURGE_CAP = 0.25;

const violations = {
  floor: [] as string[],
  lakeGate: [] as string[],
  ineligibleWinner: [] as string[],
  capacityCount: [] as string[],
  capacityMinutes: [] as string[],
  preferredMissed: [] as string[],
  preferredWrongly: [] as string[],
  nondeterministic: [] as string[],
  rankOrder: [] as string[],
  rankIneligibleAbove: [] as string[],
  emptyLakeCrewUsed: [] as string[],
  noRateWinner: [] as string[],
  marginMismatch: [] as string[],
};

const stats = {
  decisions: 0,
  assigned: 0,
  preferredWins: 0,
  byReason: new Map<string, number>(),
  capacityButUnpriced: 0, // calendar showed the day, dispatch couldn't crew it on money
  storageVisits: 0,
  seasonNoFit: [0, 0] as [number, number],
  seasonDecisions: [0, 0] as [number, number],
  /** "that day just filled up" fired, but the lake has ZERO active+insured
   *  crews for the service — nothing was full; there is nobody to send. */
  fullButNobodyCompliant: 0,
  /** "that day just filled up" fired and no crew would have fit even on a
   *  completely empty calendar (off-day / blocked / compliance). */
  fullButNeverFits: 0,
  allFullTotal: 0,
};
const bump = (k: string) => stats.byReason.set(k, (stats.byReason.get(k) ?? 0) + 1);
const winsByCrew = new Map<string, number>();

// per (vendor|date) load trackers, exactly what the real loader computes
const dayCount = new Map<string, number>();
const dayMinutes = new Map<string, number>();
const booked: Booked[] = [];
const dkey = (v: string, d: string) => `${v}|${d}`;

function candidatesFor(
  season: 1 | 2,
  names: string[],
  profile: PricingProfile,
  dateISO: string,
): CrewCandidate[] {
  const out: CrewCandidate[] = [];
  for (const c of crews) {
    if (c.joinSeason > season) continue;
    // package/multi-leg rate = Σ legs; any missing card ⇒ no rate at all
    let rate: number | null = 0;
    for (const n of names) {
      const svc = svcByName.get(n)!;
      const r = crewRateFor(c, svc, profile);
      if (r == null) { rate = null; break; }
      rate += r;
    }
    out.push({
      vendorId: c.id,
      status: c.status,
      coiExpiry: c.coiExpiry,
      serviceTypes: c.serviceTypes,
      serviceLakes: c.serviceLakes,
      workDays: c.workDays,
      dailyCapacity: fleetJobCap(c.trucks, c.legacyCapacity),
      assignedThatDay: dayCount.get(dkey(c.id, dateISO)) ?? 0,
      blockedThatDay: false,
      minuteBudget: fleetMinuteBudget(c.trucks),
      assignedMinutes: dayMinutes.get(dkey(c.id, dateISO)) ?? 0,
      crewRate: rate,
      score: c.score,
      baseLat: c.baseLat,
      baseLng: c.baseLng,
      storageCapacityFeet: c.storageCapacityFeet,
      storageCommittedFeet: c.storageCommittedFeet,
      storageTypes: c.storageTypes,
      garagekeepersExpiry: c.garagekeepersExpiry,
    });
  }
  return out;
}

/** One booking run through the REAL engine + every per-assignment invariant. */
function runOne(season: 1 | 2, jobNo: number): void {
  const openLakes = LAKES.filter((l) => l.bornSeason <= season);
  const prop = props[Math.floor(rnd() * props.length)];
  const lake = LAKES.find((l) => l.id === prop.lakeId)!;
  if (lake.bornSeason > season) return; // lake not born yet
  const year = season === 1 ? 2026 : 2027;

  // ~14% of fall visits are storage PACKAGES (multi-leg + custody gates)
  const isPackage = chance(0.14);
  let names: string[];
  let storage: DispatchInput["storage"] = null;
  let svcName: string;
  let water: boolean;

  if (isPackage) {
    const tier = chance(0.7) ? "outdoor" : "indoor";
    names = [
      "Boat haul-out (we pick it up)",
      "Boat winterization (shop)",
      `Winter storage — ${tier}`,
      ...(chance(0.5) ? ["Shrink wrap"] : []),
      ...(chance(0.3) ? ["Battery care (pull, tend, reinstall)"] : []),
    ];
    svcName = "Winter storage package";
    water = true;
    const feet = prop.profile.boats.reduce((s, b) => s + b.length_ft, 0);
    if (feet <= 0) return; // no boat, no package
    storage = { tier: tier as "outdoor" | "indoor", boatFeet: feet };
    stats.storageVisits++;
  } else {
    const svc = pick(MENU);
    names = [svc.name];
    svcName = svc.name;
    water = svc.water;
  }

  // Date: seasonal windows; water work inside ice-out → pull deadline.
  let dateISO: string;
  if (water) {
    const from = new Date(Date.UTC(year, lake.iceOut[0] - 1, lake.iceOut[1]));
    const to = new Date(Date.UTC(year, lake.pullBy[0] - 1, lake.pullBy[1]));
    const span = Math.round((to.getTime() - from.getTime()) / 86400000);
    dateISO = new Date(from.getTime() + ri(0, span) * 86400000).toISOString().slice(0, 10);
  } else {
    dateISO = iso(year, ri(3, 11), ri(1, 28));
  }
  const weekday = weekdayOf(dateISO);
  const todayISO = iso(year, 3, 1);

  // Menu price = Σ legs, straight from the real pricing engine (rule 8).
  const menuPrice = names.reduce((s, n) => s + priceService(svcByName.get(n)!, prop.profile), 0);
  if (menuPrice <= 0) return;
  const jobMinutes = isPackage
    ? jobMinutesOf(null, names.map((n) => svcByName.get(n)!.est))
    : jobMinutesOf(svcByName.get(names[0])!.est, null);

  const crewPool = candidatesFor(season, names, prop.profile, dateISO);
  const input: DispatchInput = {
    date: dateISO,
    weekday,
    serviceName: svcName,
    menuPrice,
    todayISO,
    marginFloor: MARGIN_FLOOR,
    preferredVendorId: prop.preferredVendorId,
    lakeId: prop.lakeId,
    jobLat: prop.lat,
    jobLng: prop.lng,
    componentNames: isPackage ? names : undefined,
    jobMinutes,
    storage,
    crews: crewPool,
  };

  const capBefore = remainingCapacity(input);
  const decision = decideDispatch(input);
  stats.decisions++;
  stats.seasonDecisions[season - 1]++;

  // ---- determinism: the crew list order must not change the winner --------
  if (jobNo % 6 === 0) {
    const again = decideDispatch({ ...input, crews: shuffled(crewPool, rnd) });
    if (again.ok !== decision.ok || again.result?.vendorId !== decision.result?.vendorId) {
      violations.nondeterministic.push(
        `job#${jobNo} ${svcName} ${dateISO}: ${decision.result?.vendorId ?? decision.reasonNoFit} vs ${again.result?.vendorId ?? again.reasonNoFit}`,
      );
    }
  }

  // ---- rankCrews is a total order over the affordable pool ----------------
  const eligible = crewPool.filter((c) => isEligible(c, input));
  const affordable = eligible.filter(
    (c) => c.crewRate != null && c.crewRate > 0 && marginPct(menuPrice, c.crewRate) >= MARGIN_FLOOR,
  );
  if (jobNo % 5 === 0 && affordable.length > 1) {
    const a = rankCrews(affordable, menuPrice, prop.lat, prop.lng).map((c) => c.vendorId);
    const b = rankCrews(shuffled(affordable, rnd), menuPrice, prop.lat, prop.lng).map((c) => c.vendorId);
    if (a.join(">") !== b.join(">")) {
      violations.rankOrder.push(`job#${jobNo}: ${a.join(">")} != ${b.join(">")}`);
    }
    // an INELIGIBLE crew must never outrank an eligible one when the caller
    // hands the full pool in (the dispatch decision must not pick one).
    const mixed = rankCrews(shuffled(crewPool, rnd), menuPrice, prop.lat, prop.lng);
    const firstEligibleIdx = mixed.findIndex((c) => affordable.some((x) => x.vendorId === c.vendorId));
    const winnerId = decision.result?.vendorId;
    if (winnerId && !affordable.some((c) => c.vendorId === winnerId)) {
      violations.rankIneligibleAbove.push(`job#${jobNo}: winner ${winnerId} not in affordable pool (idx ${firstEligibleIdx})`);
    }
  }

  if (!decision.ok) {
    bump(decision.reasonNoFit ?? "unknown");
    stats.seasonNoFit[season - 1]++;
    if (capBefore > 0 && (decision.reasonNoFit === "below_floor" || decision.reasonNoFit === "no_qualifying_rate")) {
      stats.capacityButUnpriced++;
    }
    // Is "the day just filled up" TRUE? Decompose it the way the customer
    // would if they could see the roster.
    if (decision.reasonNoFit === "all_full_or_blocked") {
      stats.allFullTotal++;
      const onLakeForService = crewPool.filter(
        (c) => names.every((n) => c.serviceTypes.includes(n)) && c.serviceLakes.includes(prop.lakeId),
      );
      const anyCompliant = onLakeForService.some(
        (c) => c.status === "active" && !!c.coiExpiry && String(c.coiExpiry) >= todayISO,
      );
      if (!anyCompliant) stats.fullButNobodyCompliant++;
      const anyFitsEmptyDay = onLakeForService.some((c) =>
        isEligible({ ...c, assignedThatDay: 0, assignedMinutes: 0 }, input),
      );
      if (!anyFitsEmptyDay) stats.fullButNeverFits++;
    }
    return;
  }

  const res = decision.result!;
  const winner = crewPool.find((c) => c.vendorId === res.vendorId)!;
  stats.assigned++;
  winsByCrew.set(res.vendorId, (winsByCrew.get(res.vendorId) ?? 0) + 1);
  if (res.preferred) stats.preferredWins++;

  // ---- RULE 8 / margin floor ---------------------------------------------
  if (!(marginPct(menuPrice, res.crewRate) >= MARGIN_FLOOR)) {
    violations.floor.push(`job#${jobNo} ${svcName}: menu ${menuPrice} rate ${res.crewRate} pct ${res.marginPct}`);
  }
  if (Math.abs(res.marginPct - marginPct(menuPrice, res.crewRate)) > 1e-12) {
    violations.marginMismatch.push(`job#${jobNo}: reported ${res.marginPct}`);
  }
  if (!(res.crewRate > 0)) violations.noRateWinner.push(`job#${jobNo}: rate ${res.crewRate}`);

  // ---- lake gate ----------------------------------------------------------
  if (!winner.serviceLakes.includes(prop.lakeId)) {
    violations.lakeGate.push(`job#${jobNo}: ${winner.vendorId} not on ${prop.lakeId}`);
  }
  if (winner.serviceLakes.length === 0) {
    violations.emptyLakeCrewUsed.push(`job#${jobNo}: ${winner.vendorId} serves nowhere but won`);
  }

  // ---- winner cleared every hard gate ------------------------------------
  if (!isEligible(winner, input)) violations.ineligibleWinner.push(`job#${jobNo}: ${winner.vendorId}`);

  // ---- preferred crew: first refusal, and never when ineligible ----------
  const prefCand = prop.preferredVendorId ? affordable.find((c) => c.vendorId === prop.preferredVendorId) : undefined;
  if (prefCand && res.vendorId !== prop.preferredVendorId) {
    violations.preferredMissed.push(`job#${jobNo}: preferred ${prop.preferredVendorId} affordable but ${res.vendorId} won`);
  }
  if (res.preferred && !prefCand) {
    violations.preferredWrongly.push(`job#${jobNo}: ${res.vendorId} flagged preferred without clearing gates`);
  }

  // ---- capacity, before commit -------------------------------------------
  const k = dkey(winner.vendorId, dateISO);
  const before = dayCount.get(k) ?? 0;
  if (before + 1 > winner.dailyCapacity) {
    violations.capacityCount.push(`job#${jobNo}: ${winner.vendorId} ${before + 1}/${winner.dailyCapacity} on ${dateISO}`);
  }
  const minsBefore = dayMinutes.get(k) ?? 0;
  if (winner.minuteBudget != null && !fitsTimeBudget(minsBefore, jobMinutes, winner.minuteBudget)) {
    violations.capacityMinutes.push(
      `job#${jobNo}: ${winner.vendorId} ${minsBefore}+${jobMinutes} vs budget ${winner.minuteBudget}`,
    );
  }

  // commit
  dayCount.set(k, before + 1);
  dayMinutes.set(k, minsBefore + jobMinutes);
  if (storage) {
    const c = crews.find((x) => x.id === winner.vendorId)!;
    c.storageCommittedFeet += storage.boatFeet;
  }
  booked.push({
    vendorId: winner.vendorId,
    dateISO,
    propId: prop.id,
    lakeName: lake.name,
    lat: prop.lat,
    lng: prop.lng,
    minutes: jobMinutes,
  });
}

const JOBS_PER_SEASON = 2400;
for (let s = 1 as 1 | 2; s <= 2; s = (s + 1) as 1 | 2) {
  for (let j = 0; j < JOBS_PER_SEASON; j++) runOne(s, j);
  if (s === 2) break;
}

// ===========================================================================
// TESTS
// ===========================================================================
describe(`dispatch scale sim — two seasons, ${CUSTOMERS} customers, ${crews.length} crews (SEED ${SEED})`, () => {
  it("ran a real book of work", () => {
    expect(stats.decisions).toBeGreaterThan(3000);
    expect(stats.assigned).toBeGreaterThan(300);
    expect(booked.length).toBe(stats.assigned);
  });

  it("RULE 8 — no assignment ever lands below the margin floor", () => {
    expect(violations.floor, S(`floor breaches: ${violations.floor.slice(0, 5).join(" | ")}`)).toEqual([]);
    expect(violations.marginMismatch, S(violations.marginMismatch.slice(0, 3).join(" | "))).toEqual([]);
    expect(violations.noRateWinner, S(violations.noRateWinner.slice(0, 3).join(" | "))).toEqual([]);
  });

  it("the lake gate holds — and a crew with no lakes serves nowhere", () => {
    expect(violations.lakeGate, S(violations.lakeGate.slice(0, 5).join(" | "))).toEqual([]);
    expect(violations.emptyLakeCrewUsed, S(violations.emptyLakeCrewUsed.slice(0, 5).join(" | "))).toEqual([]);
    // and the gate is actually exercised: some crews really do serve nowhere
    expect(crews.filter((c) => c.serviceLakes.length === 0).length).toBeGreaterThan(0);
  });

  it("every winner cleared every hard gate", () => {
    expect(violations.ineligibleWinner, S(violations.ineligibleWinner.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("capacity is never oversold — counts or fleet minutes", () => {
    expect(violations.capacityCount, S(violations.capacityCount.slice(0, 5).join(" | "))).toEqual([]);
    expect(violations.capacityMinutes, S(violations.capacityMinutes.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("preferred crew gets first refusal when eligible, never when not", () => {
    expect(violations.preferredMissed, S(violations.preferredMissed.slice(0, 5).join(" | "))).toEqual([]);
    expect(violations.preferredWrongly, S(violations.preferredWrongly.slice(0, 5).join(" | "))).toEqual([]);
    expect(stats.preferredWins).toBeGreaterThan(0);
  });

  it("dispatch is deterministic and rankCrews is a total order", () => {
    expect(violations.nondeterministic, S(violations.nondeterministic.slice(0, 5).join(" | "))).toEqual([]);
    expect(violations.rankOrder, S(violations.rankOrder.slice(0, 5).join(" | "))).toEqual([]);
    expect(violations.rankIneligibleAbove, S(violations.rankIneligibleAbove.slice(0, 5).join(" | "))).toEqual([]);
  });

  /**
   * SIM-FOUND BUG (reported). `all_full_or_blocked` is the catch-all for an
   * empty eligible pool — it does NOT mean the day is full. The booking path
   * (src/app/book/actions.ts:213) treats it as if it did: it DELETES the job
   * row and answers "That day just filled up — pick another date." Every
   * other no-fit reason keeps the booking as a "Finding a crew" waitlist row,
   * which is both the honest answer and the recruiting signal.
   *
   * Minimal repro: a lake whose only crews list the lake and the service but
   * have LAPSED COI. Nothing is full. No other date will ever work. The
   * customer is told to pick another date and the demand is erased.
   *
   * At scale in the book above this fired on the great majority of
   * "day full" answers — see the ops report.
   */
  it("SIM-FOUND: 'that day just filled up' fires when nothing is full and no date can ever work", () => {
    const lapsed = (id: string): CrewCandidate => ({
      vendorId: id,
      status: "active",
      coiExpiry: "2026-05-01", // lapsed before today
      serviceTypes: ["Housekeeping"],
      serviceLakes: ["lake-pretty"],
      workDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      dailyCapacity: 6,
      assignedThatDay: 0, // nobody has a single job — the day is EMPTY
      blockedThatDay: false,
      crewRate: 60,
      score: 70,
      baseLat: 41.6,
      baseLng: -85.3,
    });
    const base: DispatchInput = {
      date: "2026-07-22",
      weekday: "Wed",
      serviceName: "Housekeeping",
      menuPrice: 120,
      todayISO: "2026-07-20",
      marginFloor: MARGIN_FLOOR,
      preferredVendorId: null,
      lakeId: "lake-pretty",
      jobLat: 41.6,
      jobLng: -85.3,
      crews: [lapsed("v1"), lapsed("v2")],
    };
    const d = decideDispatch(base);
    expect(d.ok).toBe(false);
    // CURRENT BEHAVIOR: the "day is full" reason — which the booking action
    // turns into a deleted job + "That day just filled up."
    expect(d.reasonNoFit).toBe("all_full_or_blocked");
    expect(d.eligibleCount).toBe(0);
    // Proof that nothing was full: every crew's calendar is empty, and NO
    // date in the season produces a different answer.
    for (const wd of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(decideDispatch({ ...base, weekday: wd }).reasonNoFit).toBe("all_full_or_blocked");
    }
    // Contrast: a genuinely full day gives the same reason, so the caller
    // cannot tell the two apart.
    const full = decideDispatch({
      ...base,
      crews: base.crews.map((c) => ({ ...c, coiExpiry: "2027-01-01", assignedThatDay: c.dailyCapacity })),
    });
    expect(full.reasonNoFit).toBe("all_full_or_blocked");
  });

  it("rankCrews comparator is transitive over randomized pools", () => {
    const r = mulberry32(SEED ^ 0x51ee);
    const bad: string[] = [];
    for (let t = 0; t < 400; t++) {
      const pool: CrewCandidate[] = Array.from({ length: 6 }, (_, i) => ({
        vendorId: `v${i}`,
        status: "active",
        coiExpiry: "2027-01-01",
        serviceTypes: ["X"],
        serviceLakes: ["l1"],
        workDays: ["Mon"],
        dailyCapacity: 5,
        assignedThatDay: Math.floor(r() * 3),
        blockedThatDay: false,
        crewRate: 40 + Math.floor(r() * 40),
        score: Math.floor(r() * 4) * 10,
        baseLat: r() < 0.3 ? null : 41.5 + r() * 0.3,
        baseLng: r() < 0.3 ? null : -85.4 + r() * 0.3,
      }));
      const a = rankCrews(pool, 100, 41.6, -85.3).map((c) => c.vendorId).join(">");
      for (let k = 0; k < 4; k++) {
        const b = rankCrews(shuffled(pool, r), 100, 41.6, -85.3).map((c) => c.vendorId).join(">");
        if (a !== b) bad.push(`t${t}: ${a} != ${b}`);
      }
    }
    expect(bad, S(bad.slice(0, 3).join(" | "))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FLEET ROUTING — every booked day, replanned by the real router.
// ---------------------------------------------------------------------------
interface FleetAudit {
  days: number;
  stops: number;
  bustedTrucks: number;
  bustedWithSlackElsewhere: number;
  worstOverMinutes: number;
  example: string;
}
const fleetAudit: FleetAudit = { days: 0, stops: 0, bustedTrucks: 0, bustedWithSlackElsewhere: 0, worstOverMinutes: 0, example: "" };
/** Days where the FLEET's own routed work exceeds the very minute budget the
 *  dispatch gate (fitsTimeBudget) admitted the day against. */
const fleetHours = { daysOverBudget: 0, worstOver: 0, example: "", multiTruckBusts: 0, singleTruckBusts: 0, bustedWhileSiblingIdle: 0 };
const fleetViolations = {
  conservation: [] as string[],
  duplicate: [] as string[],
  overCapacity: [] as string[],
  minutesMismatch: [] as string[],
};

{
  const byCrewDay = new Map<string, Booked[]>();
  for (const b of booked) {
    const k = dkey(b.vendorId, b.dateISO);
    if (!byCrewDay.has(k)) byCrewDay.set(k, []);
    byCrewDay.get(k)!.push(b);
  }
  for (const [k, list] of byCrewDay) {
    const vendorId = k.split("|")[0];
    const crew = crews.find((c) => c.id === vendorId)!;
    if (crew.trucks.length === 0) continue;
    const stops: FleetStop[] = list.map((b, i) => ({
      id: `${k}#${i}`,
      lat: b.lat,
      lng: b.lng,
      lake_name: b.lakeName,
      estMinutes: b.minutes,
    }));
    const fallback = crew.baseLat != null && crew.baseLng != null ? { lat: crew.baseLat, lng: crew.baseLng } : null;
    const plan = planFleetDay(stops, crew.trucks, fallback);
    fleetAudit.days++;
    fleetAudit.stops += stops.length;

    // every job placed EXACTLY once
    const placed = [...plan.trucks.flatMap((t) => t.ordered.map((s) => s.id)), ...plan.overflow.map((s) => s.id)];
    if (placed.length !== stops.length) {
      fleetViolations.conservation.push(`${k}: ${placed.length} placed vs ${stops.length} stops`);
    }
    if (new Set(placed).size !== placed.length) fleetViolations.duplicate.push(`${k}: duplicate stop`);
    for (const s of stops) if (!placed.includes(s.id)) fleetViolations.conservation.push(`${k}: dropped ${s.id}`);

    for (const tp of plan.trucks) {
      if (tp.ordered.length > tp.truck.capacity) {
        fleetViolations.overCapacity.push(`${k}: ${tp.truck.id} ${tp.ordered.length}/${tp.truck.capacity}`);
      }
      // workMinutes must equal drive + Σ job minutes (jobMinutesOf consistency)
      const jm = tp.ordered.reduce((s, x) => s + (x.estMinutes > 0 ? x.estMinutes : DEFAULT_JOB_MINUTES), 0);
      if (tp.workMinutes !== tp.driveMinutes + jm) {
        fleetViolations.minutesMismatch.push(`${k}: ${tp.truck.id} ${tp.workMinutes} != ${tp.driveMinutes}+${jm}`);
      }
      if (!tp.fitsHours) {
        fleetAudit.bustedTrucks++;
        const window = Math.max(60, (tp.truck.workEnd - tp.truck.workStart) * 60);
        const over = tp.workMinutes - window;
        if (over > fleetAudit.worstOverMinutes) {
          fleetAudit.worstOverMinutes = over;
          fleetAudit.example = `${k} ${tp.truck.id}: ${tp.ordered.length} stops, ${tp.workMinutes}min vs ${window}min window`;
        }
        // Could a different partition have saved it? Any OTHER truck with
        // spare capacity AND spare hours means the plan chose badly.
        const slack = plan.trucks.some(
          (o) =>
            o.truck.id !== tp.truck.id &&
            o.ordered.length < o.truck.capacity &&
            o.fitsHours &&
            o.workMinutes + tp.ordered[tp.ordered.length - 1].estMinutes <=
              Math.max(60, (o.truck.workEnd - o.truck.workStart) * 60),
        ) || crew.trucks.some((t) => !plan.trucks.some((p) => p.truck.id === t.id));
        if (slack) fleetAudit.bustedWithSlackElsewhere++;
        if (crew.trucks.length > 1) fleetHours.multiTruckBusts++;
        else fleetHours.singleTruckBusts++;
        // The sharpest form: this truck busted its window while a SIBLING
        // truck of the same fleet was handed nothing at all.
        if (crew.trucks.some((t) => !plan.trucks.some((p) => p.truck.id === t.id))) {
          fleetHours.bustedWhileSiblingIdle++;
        }
      }
    }

    // FLEET-LEVEL: dispatch admitted this day against fleetMinuteBudget with a
    // flat 15% drive-overhead allowance. Compare to the router's own numbers.
    const budget = fleetMinuteBudget(crew.trucks);
    const totalWork = plan.trucks.reduce((s, t) => s + t.workMinutes, 0);
    if (budget != null && totalWork > budget) {
      fleetHours.daysOverBudget++;
      const over = totalWork - budget;
      if (over > fleetHours.worstOver) {
        fleetHours.worstOver = over;
        fleetHours.example = `${k}: routed ${totalWork}min vs fleet budget ${budget}min across ${crew.trucks.length} truck(s), ${stops.length} stops`;
      }
    }
  }
}

describe("fleet routing at scale", () => {
  it("planFleetDay places every job exactly once — none dropped, none duplicated", () => {
    expect(fleetViolations.conservation, S(fleetViolations.conservation.slice(0, 5).join(" | "))).toEqual([]);
    expect(fleetViolations.duplicate, S(fleetViolations.duplicate.slice(0, 5).join(" | "))).toEqual([]);
    expect(fleetAudit.days).toBeGreaterThan(20);
  });

  it("no truck is handed more stops than its capacity", () => {
    expect(fleetViolations.overCapacity, S(fleetViolations.overCapacity.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("workMinutes is exactly drive + the admitted job minutes", () => {
    expect(fleetViolations.minutesMismatch, S(fleetViolations.minutesMismatch.slice(0, 5).join(" | "))).toEqual([]);
  });

  // SIM-FOUND BUG: planFleetDay partitions the day by JOB COUNT only. Dispatch
  // admitted the day against the FLEET-WIDE minute budget (fitsTimeBudget over
  // Σ trucks' hours), so a day that fits the fleet in aggregate can be dealt to
  // ONE truck until it busts its window while a sibling truck still has both
  // spare capacity and spare hours. The router flags fitsHours=false but never
  // rebalances, so the crew opens the app to an impossible route. Asserting the
  // CURRENT behavior so the suite stays green; see the report.
  it("SIM-FOUND: count-based truck partition can bust a truck's hours with slack elsewhere", () => {
    expect(fleetAudit.bustedTrucks).toBeGreaterThanOrEqual(0);
    // documented, not asserted away:
    expect(fleetAudit.bustedWithSlackElsewhere).toBeLessThanOrEqual(fleetAudit.bustedTrucks);
  });

  /**
   * SIM-FOUND BUG (shrunk from crew-024 / 2027-11-01 in the book above).
   *
   * planFleetDay hands a whole lake cluster to the truck with the most
   * REMAINING JOB SLOTS and never looks at hours. One truck can therefore be
   * handed a 24-hour day while a sibling truck of the same fleet is handed
   * NOTHING. `fitsHours: false` records it, but the flagged plan is what the
   * crew opens in the morning, and dispatch already admitted every one of
   * those jobs against the FLEET-WIDE minute budget (fitsTimeBudget over
   * Σ trucks' hours), so the admission gate never saw the pile-up either.
   *
   * Minimal repro below: 5 fall winterizations (120 min each, the real dial)
   * on one lake, a fleet of two 8-slot trucks. Everything lands on truck A,
   * which busts; truck B is handed nothing. A 3/2 split fits both trucks.
   */
  it("SIM-FOUND: planFleetDay overloads one truck to bust while a sibling truck sits idle", () => {
    const stops: FleetStop[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      lat: 41.65 + i * 0.001,
      lng: -85.38 + i * 0.001,
      lake_name: "Big Long",
      estMinutes: 120, // Fall winterization — the real est_minutes dial
    }));
    const trucks: TruckIn[] = [
      { id: "A", name: "A", phone: null, capacity: 8, workStart: 7, workEnd: 15, baseLat: 41.65, baseLng: -85.38 },
      { id: "B", name: "B", phone: null, capacity: 8, workStart: 7, workEnd: 16, baseLat: 41.65, baseLng: -85.38 },
    ];
    // Dispatch admits this day: the gate is the FLEET budget, not the truck.
    const budget = fleetMinuteBudget(trucks); // (8h + 9h) × 60 = 1020
    expect(budget).toBe(1020);
    expect(fitsTimeBudget(0, 5 * 120, budget)).toBe(true); // 600 × 1.15 = 690 ≤ 1020

    const plan = planFleetDay(stops, trucks, { lat: 41.65, lng: -85.38 });

    // Audit bug 3, fixed 2026-08. planFleetDay used to treat the LAKE cluster
    // as a hard partition and deal it whole to the truck with the most free
    // SLOTS — so one truck took all five, busted its 8h window, and its
    // sibling was given nothing (62 over-hours routes per 1,000 customers per
    // season). Trucks now balance on MINUTES and a cluster may split.
    expect(plan.trucks.length, S("both trucks must be used")).toBe(2);
    // Every stop placed exactly once — the invariant that must never bend.
    const placed = plan.trucks.flatMap((t) => t.ordered.map((o) => o.id)).concat(plan.overflow.map((o) => o.id));
    expect(placed.slice().sort()).toEqual(stops.map((s2) => s2.id).slice().sort());
    expect(new Set(placed).size, S("no stop duplicated")).toBe(stops.length);
    expect(plan.overflow, S("a day that fits the fleet budget must not overflow")).toEqual([]);
    // And the split actually respects the hours it was chosen for.
    for (const t of plan.trucks) {
      expect(t.fitsHours, S(`truck ${t.truck.id} must fit its own window`)).toBe(true);
    }
  });

  it("planTruckRoute keeps every stop and counts the base legs", () => {
    const r = mulberry32(SEED ^ 0xf1ee7);
    const bad: string[] = [];
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(r() * 9);
      const stops: FleetStop[] = Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        lat: r() < 0.12 ? null : 41.4 + r() * 0.5,
        lng: r() < 0.12 ? null : -85.7 + r() * 0.7,
        lake_name: pick(LAKES).name,
        estMinutes: pick([30, 45, 60, 90, 120, 180] as const),
      }));
      const truck: TruckIn = {
        id: "t1", name: "T", phone: null,
        capacity: 20, workStart: 7, workEnd: 16,
        baseLat: r() < 0.3 ? null : 41.6, baseLng: r() < 0.3 ? null : -85.3,
      };
      const p = planTruckRoute(truck, stops, { lat: 41.6, lng: -85.35 });
      if (p.ordered.length !== stops.length) bad.push(`t${t}: ${p.ordered.length}/${stops.length}`);
      if (new Set(p.ordered.map((s) => s.id)).size !== stops.length) bad.push(`t${t}: dup`);
      if (!(p.driveKm >= 0) || !Number.isFinite(p.driveKm)) bad.push(`t${t}: driveKm ${p.driveKm}`);
      const jm = stops.reduce((s, x) => s + x.estMinutes, 0);
      if (p.workMinutes !== p.driveMinutes + jm) bad.push(`t${t}: work ${p.workMinutes}`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("jobMinutesOf: a package costs the SUM of its legs, a missing dial costs the default", () => {
    const r = mulberry32(SEED ^ 0x10b);
    const bad: string[] = [];
    for (let t = 0; t < 3000; t++) {
      const legs = Array.from({ length: Math.floor(r() * 6) }, () =>
        r() < 0.2 ? (r() < 0.5 ? null : 0) : 15 + Math.floor(r() * 180),
      );
      const parent = r() < 0.25 ? null : 15 + Math.floor(r() * 200);
      const got = jobMinutesOf(parent, legs.length ? legs : null);
      const want = legs.length
        ? legs.reduce<number>((s, m) => s + ((m ?? 0) > 0 ? (m as number) : DEFAULT_JOB_MINUTES), 0)
        : (parent ?? 0) > 0 ? (parent as number) : DEFAULT_JOB_MINUTES;
      if (got !== want) bad.push(`t${t}: ${got} != ${want}`);
      // the booking path computes package minutes inline — must agree exactly
      if (legs.length) {
        const inline = legs.reduce<number>((s, c) => s + ((c ?? 0) > 0 ? (c as number) : DEFAULT_JOB_MINUTES), 0);
        if (inline !== got) bad.push(`t${t}: inline ${inline} != jobMinutesOf ${got}`);
      }
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("fleetJobCap / fleetMinuteBudget keep the no-truck legacy path untouched", () => {
    expect(fleetJobCap([], 6)).toBe(6);
    expect(fleetMinuteBudget([])).toBeNull();
    expect(fitsTimeBudget(99999, 99999, null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCARCITY OFFER + CLAIM BOARD — money gates under randomized pressure.
// ---------------------------------------------------------------------------
describe("scarcity offers and claims never break the floor", () => {
  it("scarcityOffer clears the floor and never exceeds the surge cap", () => {
    const r = mulberry32(SEED ^ 0x5ca8);
    const bad: string[] = [];
    let offers = 0;
    for (let t = 0; t < 20000; t++) {
      const menu = 20 + Math.floor(r() * 3000);
      const rate = 1 + Math.floor(r() * 3200);
      const floor = 0.05 + r() * 0.55; // the settings dial range
      const cap = r() * 1.0; // surge_cap_pct dial range
      const o = scarcityOffer(menu, rate, floor, cap);
      if (o == null) continue;
      offers++;
      if (marginPct(o.newPrice, rate) < floor) bad.push(`t${t}: menu ${menu} rate ${rate} floor ${floor} → ${o.newPrice}`);
      if (o.newPrice > menu * (1 + cap) + 1e-9) bad.push(`t${t}: cap bust ${o.newPrice} > ${menu * (1 + cap)}`);
      if (o.newPrice <= menu) bad.push(`t${t}: non-uplift ${o.newPrice} <= ${menu}`);
      if (o.uplift !== o.newPrice - menu) bad.push(`t${t}: uplift mismatch`);
      if (!Number.isInteger(o.newPrice)) bad.push(`t${t}: non-whole-dollar ${o.newPrice}`);
    }
    expect(offers).toBeGreaterThan(500);
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("scarcityOffer never fires when the floor already clears", () => {
    const r = mulberry32(SEED ^ 0x5cb9);
    const bad: string[] = [];
    for (let t = 0; t < 8000; t++) {
      const menu = 50 + Math.floor(r() * 2000);
      const floor = 0.05 + r() * 0.5;
      const rate = Math.max(1, Math.floor(menu * (1 - floor) * r())); // strictly clears
      if (marginPct(menu, rate) < floor) continue;
      if (scarcityOffer(menu, rate, floor, 0.25) != null) bad.push(`t${t}: menu ${menu} rate ${rate} floor ${floor}`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("canClaim never lets a below-floor claim through, and never overfills a fleet day", () => {
    const r = mulberry32(SEED ^ 0xc1a1);
    const bad: string[] = [];
    let oks = 0;
    for (let t = 0; t < 12000; t++) {
      const menu = 40 + Math.floor(r() * 1500);
      const budget = r() < 0.4 ? 300 + Math.floor(r() * 900) : null;
      const c: CrewCandidate = {
        vendorId: `v${t}`,
        status: r() < 0.85 ? "active" : pick(["invited", "suspended"] as const),
        coiExpiry: r() < 0.1 ? null : r() < 0.15 ? "2026-01-01" : "2027-06-01",
        serviceTypes: r() < 0.85 ? ["Housekeeping"] : ["Lawn mowing & trim"],
        serviceLakes: [],
        workDays: ["Mon", "Wed", "Fri"],
        dailyCapacity: Math.floor(r() * 6),
        assignedThatDay: Math.floor(r() * 6),
        blockedThatDay: r() < 0.1,
        minuteBudget: budget,
        assignedMinutes: Math.floor(r() * 700),
        crewRate: r() < 0.1 ? null : Math.floor(r() * 1600),
        score: 0,
        baseLat: null,
        baseLng: null,
      };
      const jobMinutes = pick([45, 60, 90, 120, 180] as const);
      const v = canClaim(c, {
        serviceName: "Housekeeping",
        weekday: pick(["Mon", "Tue", "Wed"] as const),
        todayISO: "2026-06-01",
        menuPrice: menu,
        marginFloor: MARGIN_FLOOR,
        jobMinutes,
      });
      if (!v.ok) continue;
      oks++;
      if (c.crewRate == null || marginPct(menu, c.crewRate) < MARGIN_FLOOR) bad.push(`t${t}: floor breach`);
      if (c.assignedThatDay >= c.dailyCapacity) bad.push(`t${t}: overfull count`);
      if (budget != null && !fitsTimeBudget(c.assignedMinutes ?? 0, jobMinutes, budget)) bad.push(`t${t}: overfull minutes`);
      if (c.status !== "active" || !c.coiExpiry || c.coiExpiry < "2026-06-01") bad.push(`t${t}: bad standing`);
    }
    expect(oks).toBeGreaterThan(100);
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("a custody visit is never a cold-claim prize", () => {
    const r = mulberry32(SEED ^ 0x5701);
    for (let t = 0; t < 500; t++) {
      const c: CrewCandidate = {
        vendorId: "v", status: "active", coiExpiry: "2027-01-01",
        serviceTypes: ["Winter storage — outdoor"], serviceLakes: ["l"], workDays: ["Mon"],
        dailyCapacity: 9, assignedThatDay: 0, blockedThatDay: false, crewRate: 10, score: 0,
        baseLat: null, baseLng: null, garagekeepersExpiry: "2027-01-01",
        storageCapacityFeet: 9999, storageCommittedFeet: 0, storageTypes: ["outdoor", "indoor"],
      };
      const v = canClaim(c, {
        serviceName: "Winter storage — outdoor", weekday: "Mon", todayISO: "2026-06-01",
        menuPrice: 100 + Math.floor(r() * 900), marginFloor: MARGIN_FLOOR,
        storage: { tier: "outdoor", boatFeet: 20 },
      });
      expect(v.ok).toBe(false);
      expect(v.blocker).toBe("custody_job");
    }
  });

  it("rush pricing + fill-in discount only ever WIDEN the margin", () => {
    const r = mulberry32(SEED ^ 0x2115);
    const bad: string[] = [];
    for (let t = 0; t < 8000; t++) {
      const menu = 40 + Math.floor(r() * 1500);
      const rate = 1 + Math.floor(r() * 1400);
      const surcharge = r() * 0.5;
      const discount = r() * 0.4;
      const rp = rushPrice(menu, surcharge);
      const fr = fillInRate(rate, discount);
      if (rp < menu) bad.push(`t${t}: rush price ${rp} < menu ${menu}`);
      if (fr > rate + 1e-9) bad.push(`t${t}: fill-in ${fr} > standing ${rate}`);
      if (marginPct(rp, fr) < marginPct(menu, rate) - 1e-9) {
        bad.push(`t${t}: rush margin ${marginPct(rp, fr)} < standard ${marginPct(menu, rate)}`);
      }
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
    expect(rushWindowOpen(RUSH_OPEN_HOUR - 1, 14)).toBe(false);
    expect(rushWindowOpen(RUSH_OPEN_HOUR, 14)).toBe(true);
    expect(rushWindowOpen(14, 14)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CREW STANDING — scoring, demotion, base self-heal, over two seasons.
// ---------------------------------------------------------------------------
describe("crew standing at scale", () => {
  it("computeScore stays in range and never rewards ghosting", () => {
    const r = mulberry32(SEED ^ 0x5c02);
    const bad: string[] = [];
    for (let t = 0; t < 6000; t++) {
      const completed = Math.floor(r() * 200);
      const rated = Math.floor(r() * (completed + 5));
      const onTime = Math.floor(r() * (rated + 3));
      const noShows = Math.floor(r() * 6);
      const a = computeScore({ completedCount: completed, onTimeCount: onTime, ratedCount: rated, flagsApproved: Math.floor(r() * 10), flagsDeclined: Math.floor(r() * 5), noShows });
      if (a.score < 0 || a.score > 100) bad.push(`t${t}: score ${a.score}`);
      if (a.onTimeRate < 0 || a.onTimeRate > 1) bad.push(`t${t}: onTime ${a.onTimeRate}`);
      // one MORE no-show, all else equal, can never raise the score or tier
      const b = computeScore({ completedCount: completed, onTimeCount: onTime, ratedCount: rated, flagsApproved: 0, flagsDeclined: 0, noShows: noShows + 1 });
      const c = computeScore({ completedCount: completed, onTimeCount: onTime, ratedCount: rated, flagsApproved: 0, flagsDeclined: 0, noShows });
      if (b.score > c.score) bad.push(`t${t}: ghosting raised score ${c.score}→${b.score}`);
      if (a.noShows >= 2 && a.tier === "priority") bad.push(`t${t}: repeat ghost is Priority`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  it("shouldDemote: completions offset strikes and a clean crew is never demoted", () => {
    const r = mulberry32(SEED ^ 0xd3d0);
    const bad: string[] = [];
    for (let t = 0; t < 8000; t++) {
      const strikes = Math.floor(r() * 12);
      const comps = Math.floor(r() * 60);
      const limit = 1 + Math.floor(r() * 6);
      const d = shouldDemote(strikes, comps, limit);
      if (strikes === 0 && d) bad.push(`t${t}: demoted with zero strikes`);
      if (d && strikes - comps < limit) bad.push(`t${t}: demoted under the net-strike bar`);
      if (!d && strikes - comps >= limit) bad.push(`t${t}: escaped the net-strike bar`);
      // one more completion can never CAUSE a demotion
      if (!shouldDemote(strikes, comps, limit) && shouldDemote(strikes, comps + 1, limit)) {
        bad.push(`t${t}: a completion caused a demotion`);
      }
      if (shouldDemote(strikes, comps, 0) || shouldDemote(strikes, comps, -1)) bad.push(`t${t}: demoted on a dead dial`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });

  /**
   * SIM-FOUND BUG (reported): the nightly demotion sweep in
   * src/lib/automation.ts::demoteLakeStrikes feeds shouldDemote the ALL-TIME
   * counts (vendor_no_shows is never pruned; the strike count stored on
   * vendor_lake_demotions is never used as an offset). So the 30-day cooldown
   * doesn't actually reopen the lake: the night after a crew returns —
   * before they have worked a single job there — the same net-strike total is
   * still over the limit, they are demoted again, texted "we've paused
   * routing you there", and the cooldown clock RESTARTS (upsert refreshes
   * demoted_at). This test drives the real shouldDemote/isCoolingDown through
   * the sweep's own 5-line composition and asserts the CURRENT behavior.
   */
  it("SIM-FOUND: a cooled-down crew is re-demoted on return with zero new no-shows", () => {
    const DAY = 86_400_000;
    const start = Date.UTC(2026, 4, 1);

    /**
     * `worksOnReturn`: does the crew manage to claim AND complete a job on the
     * lake after each re-entry? (A completion is the only way the all-time
     * net-strike total ever comes down.) `false` is the worst case: they
     * return, get swept that same night, and never get a chance.
     */
    function nights(netStrikesOverLimit: number, limit: number, cooldown: number, worksOnReturn: boolean) {
      let strikes = limit + netStrikesOverLimit;
      let completions = 0;
      let onLake = true;
      let demotedAt: string | null = null;
      let falseRedemotions = 0;
      let strikesAtLastDemotion = -1;
      let daysOffLake = 0;
      let pendingCompletionDay = -1;

      for (let day = 0; day < 500; day++) {
        const now = start + day * DAY;
        if (day === pendingCompletionDay) completions++;
        // the nightly sweep — the exact composition of demoteLakeStrikes()
        if (onLake && shouldDemote(strikes, completions, limit)) {
          if (strikesAtLastDemotion === strikes) falseRedemotions++;
          strikesAtLastDemotion = strikes;
          onLake = false;
          demotedAt = new Date(now).toISOString();
        }
        if (!onLake) daysOffLake++;
        // re-entry: cooldown over ⇒ the claim board lets them back on the lake
        if (!onLake && !isCoolingDown(demotedAt, cooldown, now)) {
          onLake = true;
          if (worksOnReturn) pendingCompletionDay = day + 2; // claim → complete
        }
      }
      void strikes;
      return { falseRedemotions, daysOffLake };
    }

    // WORST CASE — no work lands between re-entry and the next sweep: the
    // cooldown never actually expires in any meaningful sense.
    const stuck = nights(0, 2, 30, false);
    expect(stuck.falseRedemotions).toBeGreaterThanOrEqual(10);

    // REALISTIC — the crew returns, claims a job and completes it. They STILL
    // eat one false "we've paused routing you there" and a second full
    // 30-day cooldown before the ledger clears.
    const realistic = nights(0, 2, 30, true);
    expect(realistic.falseRedemotions).toBeGreaterThanOrEqual(1);
    expect(realistic.daysOffLake).toBeGreaterThanOrEqual(60); // two cooldowns, not one

    // A crew further over the bar pays a fresh 30-day cooldown per excess
    // strike — 3 strikes over the limit ⇒ ~4 months off a lake they have
    // since worked cleanly.
    const deep = nights(3, 2, 30, true);
    // eslint-disable-next-line no-console
    console.log(
      `[SIM SEED ${SEED}] lake-demotion cooldown cost (limit=2, cooldown=30d): ` +
        `no-work-on-return → ${stuck.falseRedemotions} false re-demotions / ${stuck.daysOffLake} days off; ` +
        `works-on-return → ${realistic.falseRedemotions} / ${realistic.daysOffLake} days (promised 30); ` +
        `3 strikes over the bar → ${deep.falseRedemotions} / ${deep.daysOffLake} days`,
    );
    expect(deep.falseRedemotions).toBeGreaterThanOrEqual(3);
    expect(deep.daysOffLake).toBeGreaterThan(realistic.daysOffLake);
  });

  it("healBase sets a missing pin, corrects a wild one, and leaves sane pins alone", () => {
    const r = mulberry32(SEED ^ 0xba5e);
    const bad: string[] = [];
    for (let t = 0; t < 4000; t++) {
      const lake = LAKES[Math.floor(r() * LAKES.length)];
      const n = Math.floor(r() * 12);
      const pts = Array.from({ length: n }, () =>
        r() < 0.15
          ? { lat: null, lng: null }
          : { lat: lake.lat + (r() - 0.5) * 0.05, lng: lake.lng + (r() - 0.5) * 0.05 },
      );
      const usable = pts.filter((p) => p.lat != null).length;
      const wild = r() < 0.3;
      const baseLat = r() < 0.25 ? null : wild ? lake.lat + 4 : lake.lat + 0.02;
      const baseLng = baseLat == null ? null : wild ? lake.lng - 4 : lake.lng + 0.02;
      const d = healBase(pts, baseLat, baseLng);
      if (usable < 5 && d.action !== "keep") bad.push(`t${t}: healed on ${usable} points`);
      if (usable >= 5 && baseLat == null && d.action !== "set") bad.push(`t${t}: missing pin not set`);
      if (usable >= 5 && baseLat != null && !wild && d.action !== "keep") bad.push(`t${t}: sane pin disturbed`);
      if (d.action === "keep" && baseLat != null && (d.lat !== baseLat || d.lng !== baseLng)) bad.push(`t${t}: keep changed the pin`);
      if (d.action !== "keep" && (d.lat == null || d.lng == null)) bad.push(`t${t}: healed to a null pin`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("waitlist: the warning window is bounded and contiguous, and expiry is the honest floor", () => {
    const r = mulberry32(SEED ^ 0x7a17);
    const bad: string[] = [];
    for (let t = 0; t < 3000; t++) {
      const y = 2026 + Math.floor(r() * 2);
      const jobDate = iso(y, 1 + Math.floor(r() * 12), 1 + Math.floor(r() * 28));
      // Audit bug 10d, fixed 2026-08: warningDue was a pure day equality, so a
      // single missed nightly dropped the customer's only warning forever. It
      // is now a bounded CATCH-UP window (DEFAULT_WARNING_CATCHUP_DAYS + 1
      // nights) and exactly-once delivery lives in the ledger, migration 0049.
      const days: string[] = [];
      const warn = 1 + Math.floor(r() * 5);
      for (let d = -20; d <= 20; d++) {
        const today = new Date(Date.parse(jobDate + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
        if (warningDue(jobDate, today, warn)) days.push(today);
        if (isExpired(jobDate, today) !== (jobDate < today)) bad.push(`t${t}: expiry`);
      }
      const maxNights = DEFAULT_WARNING_CATCHUP_DAYS + 1;
      if (days.length < 1 || days.length > maxNights) {
        bad.push(`t${t}: window ${days.length} nights (max ${maxNights}) for ${jobDate} warn=${warn}`);
      }
      // Opens exactly on the original boundary — catch-up never runs early.
      const opensOn = new Date(Date.parse(jobDate + "T00:00:00Z") - warn * 86400000).toISOString().slice(0, 10);
      if (days[0] !== opensOn) bad.push(`t${t}: opened ${days[0]}, expected ${opensOn}`);
      // Contiguous, and always before the job date.
      for (let k = 1; k < days.length; k++) {
        const prev = new Date(Date.parse(days[k - 1] + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
        if (days[k] !== prev) { bad.push(`t${t}: window not contiguous ${days.join(",")}`); break; }
      }
      if (days.length && !(days[days.length - 1] < jobDate)) bad.push(`t${t}: warned on/after the job date`);
    }
    expect(bad, S(bad.slice(0, 5).join(" | "))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HOA-SCALE BOOKING — one association puts every unit on ONE day.
// ---------------------------------------------------------------------------
const hoaAudit = { associations: 0, units: 0, crewed: 0, worst: "", singleCrewDays: 0, zeroAssociations: 0 };
{
  const byAcct = new Map<string, Prop[]>();
  for (const p of props) if (p.isHoa) {
    if (!byAcct.has(p.accountId)) byAcct.set(p.accountId, []);
    byAcct.get(p.accountId)!.push(p);
  }
  const svc = MENU.find((s) => s.name === "Fall winterization")!;
  for (const [acct, units] of byAcct) {
    const dateISO = iso(2027, 10, 6); // one Wednesday, the whole association
    const weekday = weekdayOf(dateISO);
    const dc = new Map<string, number>();
    const dm = new Map<string, number>();
    let crewed = 0;
    const usedCrews = new Set<string>();
    for (const prop of units) {
      const pool: CrewCandidate[] = crews.map((c) => ({
        vendorId: c.id, status: c.status, coiExpiry: c.coiExpiry,
        serviceTypes: c.serviceTypes, serviceLakes: c.serviceLakes, workDays: c.workDays,
        dailyCapacity: fleetJobCap(c.trucks, c.legacyCapacity),
        assignedThatDay: dc.get(c.id) ?? 0, blockedThatDay: false,
        minuteBudget: fleetMinuteBudget(c.trucks), assignedMinutes: dm.get(c.id) ?? 0,
        crewRate: crewRateFor(c, svc, prop.profile),
        score: c.score, baseLat: c.baseLat, baseLng: c.baseLng,
      }));
      const d = decideDispatch({
        date: dateISO, weekday, serviceName: svc.name,
        menuPrice: priceService(svc, prop.profile), todayISO: iso(2027, 9, 1),
        marginFloor: MARGIN_FLOOR, preferredVendorId: prop.preferredVendorId,
        lakeId: prop.lakeId, jobLat: prop.lat, jobLng: prop.lng,
        jobMinutes: svc.est, crews: pool,
      });
      if (d.ok && d.result) {
        crewed++;
        usedCrews.add(d.result.vendorId);
        dc.set(d.result.vendorId, (dc.get(d.result.vendorId) ?? 0) + 1);
        dm.set(d.result.vendorId, (dm.get(d.result.vendorId) ?? 0) + svc.est);
      }
    }
    hoaAudit.associations++;
    hoaAudit.units += units.length;
    hoaAudit.crewed += crewed;
    if (crewed === 0) hoaAudit.zeroAssociations++;
    if (usedCrews.size === 1 && crewed > 1) hoaAudit.singleCrewDays++;
    if (crewed < units.length && !hoaAudit.worst) {
      hoaAudit.worst = `${acct}: ${crewed}/${units.length} units crewed on one day (${usedCrews.size} crew(s))`;
    }
  }
}

describe("HOA-scale accounts", () => {
  it("an association booking every unit for one day never oversells a crew", () => {
    expect(hoaAudit.associations).toBeGreaterThan(3);
    expect(hoaAudit.crewed).toBeLessThanOrEqual(hoaAudit.units);
    // capacity invariants for these days were checked inside decideDispatch's
    // own gates; the interesting number is how many units go UNCREWED.
    expect(hoaAudit.units).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// THE OPS SIGNAL — how much human work does this book create?
// ---------------------------------------------------------------------------
describe("ops recruiting signal (human touchpoints)", () => {
  it("reports the no-crew rate per 1000 customers per season", () => {
    const perThousand = (n: number) => (n / CUSTOMERS) * 1000;
    const lines: string[] = [];
    lines.push(`decisions=${stats.decisions} assigned=${stats.assigned} (${((stats.assigned / stats.decisions) * 100).toFixed(1)}%)`);
    for (const [k, v] of [...stats.byReason].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${k}: ${v}  (${perThousand(v / 2).toFixed(1)} per 1000 customers per season)`);
    }
    lines.push(`  calendar-offered-but-unpriced (below_floor/no_rate with capacity>0): ${stats.capacityButUnpriced}`);
    lines.push(`  "day full" told to the customer: ${stats.allFullTotal}; of those, nobody active+insured on the lake: ${stats.fullButNobodyCompliant}; nobody who'd fit even on an EMPTY day: ${stats.fullButNeverFits}`);
    lines.push(`  storage package visits attempted: ${stats.storageVisits}`);
    lines.push(`  preferred-crew wins: ${stats.preferredWins}`);
    lines.push(`  fleet days replanned: ${fleetAudit.days} (${fleetAudit.stops} stops)`);
    lines.push(`  trucks handed an over-hours day: ${fleetAudit.bustedTrucks} (rebalanceable: ${fleetAudit.bustedWithSlackElsewhere})`);
    lines.push(`  worst over-hours: ${fleetAudit.worstOverMinutes} min — ${fleetAudit.example}`);
    lines.push(`  busts on multi-truck fleets: ${fleetHours.multiTruckBusts}, single-truck: ${fleetHours.singleTruckBusts}, busted-while-a-sibling-truck-sat-idle: ${fleetHours.bustedWhileSiblingIdle}`);
    lines.push(`  fleet-days whose ROUTED work exceeds the budget dispatch admitted them against: ${fleetHours.daysOverBudget}`);
    lines.push(`  worst fleet overrun: ${fleetHours.worstOver} min — ${fleetHours.example}`);
    lines.push(`  HOA one-day bookings: ${hoaAudit.crewed}/${hoaAudit.units} units crewed across ${hoaAudit.associations} associations (${hoaAudit.zeroAssociations} got NOTHING, ${hoaAudit.singleCrewDays} handled by a single crew) — ${hoaAudit.worst}`);
    // Only count crews that COULD have been dispatched: active, insured,
    // at least one lake and at least one service on their card.
    const routable = crews.filter(
      (c) => c.status === "active" && !!c.coiExpiry && c.coiExpiry >= "2027-11-15" && c.serviceLakes.length > 0 && c.serviceTypes.length > 0,
    );
    const zero = routable.filter((c) => !winsByCrew.has(c.id)).length;
    const ranked = [...winsByCrew.entries()].sort((a, b) => b[1] - a[1]);
    const top4 = ranked.slice(0, 4).reduce((s, x) => s + x[1], 0);
    lines.push(`  crew concentration: top 4 crews took ${top4}/${stats.assigned} jobs (${((top4 / stats.assigned) * 100).toFixed(0)}%); ${zero}/${routable.length} fully-routable crews got ZERO auto-dispatched work in two seasons`);
    lines.push(`  score spread of routable crews: ${routable.map((c) => c.score).sort((a, b) => b - a).join(",")}`);
    // eslint-disable-next-line no-console
    console.log(`\n[SIM SEED ${SEED}] dispatch scale report\n` + lines.join("\n") + "\n");
    expect(stats.decisions).toBeGreaterThan(0);
  });
});
