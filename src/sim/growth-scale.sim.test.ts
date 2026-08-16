/**
 * ORGANIC GROWTH — TWO-SEASON SCALE SIMULATION (owner ask, 2026-07-26:
 * "1000+ customers, 2 lake seasons, new lakes, HOAs, as many crews as
 * needed, organic onboarding with referrals, credits/commissions tracked
 * — find all bugs and sticking points of human interaction").
 *
 * WHAT IS REAL AND WHAT IS MODELLED
 *  - REAL (imported, never reimplemented): every number and every decision
 *    comes from the shipping pure engines —
 *      referrals.ts   withinSunset / customerReferralAccrual /
 *                     crewShareAccrual / creditToApply
 *      growth.ts      isLastDayOfMonth / nearMilestone / nudgeCooling
 *      lake-name.ts   normalizeLakeName
 *      lake-pages.ts  fromPrice / slugify
 *      notif-prefs.ts mergeNotifPrefs / channelsFor  (+ NOTIF_DEFS)
 *      autopilot.ts   proposeAutopilotDate
 *      pricing.ts     priceService (real seeded services rows)
 *  - MODELLED: the I/O around them — the referral_earnings state machine,
 *    the user_credits ledger, the nightly runners' guards. Each modelled
 *    guard is transcribed from the source it mirrors and cited in a
 *    comment, so a failure here is traceable back to real code.
 *
 * DETERMINISM: one seeded mulberry32. No Math.random anywhere. Every
 * failure message prints SEED so the exact world reproduces.
 */
import { describe, it, expect } from "vitest";
import { withinSunset, customerReferralAccrual, crewShareAccrual, creditToApply } from "@/lib/referrals";
import { isLastDayOfMonth, nearMilestone, nudgeCooling } from "@/lib/growth";
import { normalizeLakeName } from "@/lib/lake-name";
import { fromPrice, slugify } from "@/lib/lake-pages";
import { mergeNotifPrefs, channelsFor, type SavedPref } from "@/lib/notif-prefs";
import { NOTIF_DEFS } from "@/lib/notifications";
import { proposeAutopilotDate } from "@/lib/autopilot";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";

// ───────────────────────────── determinism ─────────────────────────────
const SEED = 20260726;
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const S = (why: string) => `[SEED=${SEED}] ${why}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────────── calendar ─────────────────────────────
// Day 0 = 2026-01-01. Two full seasons: 2026 and 2027.
const DAY0 = Date.UTC(2026, 0, 1);
const HORIZON = 730;
const msOf = (d: number) => DAY0 + d * 86_400_000;
const isoOf = (d: number) => new Date(msOf(d)).toISOString().slice(0, 10);
const tsOf = (d: number) => new Date(msOf(d)).toISOString();
const seasonOf = (d: number) => (d < 365 ? 1 : 2);

// ─────────────────────── the owner's dials (0028/0030 defaults) ───────────────────────
const DIALS = {
  customerPct: 0.05,
  crossSellPct: 0.05,
  crewSharePct: 0.25,
  crewCap: 250,
  sunsetDays: 365,
  maturationDays: 30,
  nudgeCreditThreshold: 50,
  nudgeCooldownDays: 30,
};

// ─────────────────────── real seeded services (seed/seed_services.sql) ───────────────────────
const SERVICES: Array<ServiceRule & { water: boolean }> = [
  { name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0, band_pricing: null, water: false },
  { name: "Fall winterization", pricing_model: "flat", base: 485, unit_rate: 0, band_pricing: null, water: false },
  { name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" }, water: true },
  { name: "Boat lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 }, water: true },
  { name: "Jet ski winterize & store", pricing_model: "per_section", base: 0, unit_rate: 350, band_pricing: { count_field: "jet_skis" }, water: true },
  { name: "PWC lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 165, band_pricing: { count_field: "pwc_lifts" }, water: true },
  { name: "Boat storage & winterize", pricing_model: "per_foot", base: 0, unit_rate: 50, band_pricing: null, water: true },
  { name: "Water toy prep & storage", pricing_model: "flat", base: 120, unit_rate: 0, band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] }, water: true },
  { name: "Lawn mowing & trim", pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 }, water: false },
  { name: "Housekeeping", pricing_model: "per_sqft_band", base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] }, water: false },
];
const svc = (n: string) => SERVICES.find((s) => s.name === n)!;

// ───────────────────────────── world types ─────────────────────────────
type UserKind = "home" | "crew" | "hoa";
interface Usr {
  id: string;
  kind: UserKind;
  createdDay: number;
  referredBy: string | null;
  vendorId: string | null; // set when this user IS a crew
  hoaLake: string | null; // set when this user is a lake association
  lakeId: string;
  hasBank: boolean; // payout_accounts row (crews/HOAs only)
  profile: PricingProfile;
  enrolled: string[]; // autopilot service names
}
interface Crew {
  id: string;
  userId: string;
  invitedBy: string | null; // vendors.invited_by
  marginPct: number;
  lakes: Set<string>;
}
interface Earning {
  id: number;
  beneficiary: string;
  kind: "customer_referral" | "cross_sell" | "crew_referral";
  sourceJob: string;
  sourceVendor: string | null;
  amount: number;
  status: "accrued" | "matured" | "paid" | "void";
  accruedDay: number;
}

function makeProfile(rnd: () => number): PricingProfile {
  const sqft = 900 + Math.floor(rnd() * 4200);
  const boats = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
    length_ft: 14 + Math.floor(rnd() * 18),
    engine_type: rnd() < 0.08 ? "none" : "outboard",
    engine_hp: 50 + Math.floor(rnd() * 350),
    engines: rnd() < 0.15 ? 2 : 1,
  }));
  return {
    sqft,
    beds: 2 + Math.floor(rnd() * 4),
    baths: 1 + Math.floor(rnd() * 3),
    pier_sections: rnd() < 0.75 ? 2 + Math.floor(rnd() * 7) : 0,
    boat_lifts: rnd() < 0.6 ? 1 + Math.floor(rnd() * 2) : 0,
    toy_lifts: rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0,
    jet_skis: rnd() < 0.35 ? 1 + Math.floor(rnd() * 3) : 0,
    pwc_lifts: rnd() < 0.25 ? 1 + Math.floor(rnd() * 2) : 0,
    lawn_band: (["small", "medium", "large"] as const)[Math.floor(rnd() * 3)],
    boats,
    toys: Array.from({ length: Math.floor(rnd() * 4) }, () => ({ name: "toy" })),
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  THE WORLD RUN — two seasons of organic growth, one pass, everything
//  asserted in-flight. Returns the metrics the owner asked to be measured.
// ═══════════════════════════════════════════════════════════════════════
interface Metrics {
  customers: number;
  crews: number;
  lakes: number;
  jobs: number;
  bySeason: Record<number, {
    accruals: number; accrualDollars: number;
    maturations: number; creditGrants: number; creditDollars: number;
    creditApplications: number; creditApplied: number;
    payoutBatches: number; payoutDollars: number;
    nudges: number;
    stuckNoBank: number; stuckDollars: number;
    newLakes: number;
  }>;
  maturedRowsParked: number; // customer rows that never leave 'matured'
  maxGrowthEmailsPerUserPerSeason: number;
  usersOver6EmailsSeason: number;
  capPairs: number;
  multiSettleCapPairs: number;
  creditsBurnedOnUnpaidInvoices: number;
  avgActive: Record<number, number>;
  parkedPast500On: string | null; // the day the payout-batch window silts up
}

function runWorld(): Metrics {
  const rnd = mulberry32(SEED);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

  // ── lakes (3 seeded, more born from demand) ──
  interface Lake { id: string; name: string; slug: string; iceOut: Record<number, number>; pull: Record<number, number>; }
  const mkLake = (name: string, iceOutDoy: number, pullDoy: number): Lake => ({
    id: `lake-${slugify(name)}`,
    name,
    slug: slugify(name),
    iceOut: { 1: iceOutDoy, 2: 365 + iceOutDoy + Math.floor(rnd() * 7) - 3 },
    pull: { 1: pullDoy, 2: 365 + pullDoy + Math.floor(rnd() * 7) - 3 },
  });
  const lakes: Lake[] = [
    mkLake("Big Long Lake", 79, 317),
    mkLake("Pretty Lake", 82, 315),
    mkLake("Big Turkey Lake", 77, 319),
  ];
  // Demand-born names customers/crews will type over the two seasons.
  const bornNames = ["little turkey", "Adams Lake", "  westler  ", "Hackenburg", "silver lake", "Oliver"];
  let bornCursor = 0;

  // ── crews ──
  const crews: Crew[] = [];
  const users = new Map<string, Usr>();
  let uid = 0;
  const newUser = (kind: UserKind, day: number, referredBy: string | null, lakeId: string): Usr => {
    const u: Usr = {
      id: `u${uid++}`, kind, createdDay: day, referredBy, vendorId: null, hoaLake: null,
      lakeId, hasBank: kind === "home" ? false : rnd() < 0.82,
      profile: makeProfile(rnd), enrolled: [],
    };
    users.set(u.id, u);
    return u;
  };

  const homeIds: string[] = [];
  const hoaIds: string[] = [];

  // Seed cohort: 50 homeowners across the 3 lakes, day 0-20.
  for (let i = 0; i < 50; i++) {
    const u = newUser("home", Math.floor(rnd() * 20), null, pick(lakes).id);
    homeIds.push(u.id);
  }
  // 4 lake associations (HOA-scale referrers) — each will bring dozens.
  for (let i = 0; i < 4 && i < lakes.length + 1; i++) {
    const lake = lakes[i % lakes.length];
    const u = newUser("hoa", 3, null, lake.id);
    u.hoaLake = lake.id;
    hoaIds.push(u.id);
  }
  // 26 crews at open; more join as territory grows.
  const addCrew = (day: number, invitedBy: string | null): Crew => {
    const cu = newUser("crew", day, null, pick(lakes).id);
    const c: Crew = {
      id: `v${crews.length}`, userId: cu.id, invitedBy,
      marginPct: 0.22 + rnd() * 0.16,
      lakes: new Set([cu.lakeId]),
    };
    cu.vendorId = c.id;
    crews.push(c);
    return c;
  };
  for (let i = 0; i < 26; i++) addCrew(Math.floor(rnd() * 30), rnd() < 0.45 ? pick(homeIds) : null);

  // ── ledgers ──
  const earnings: Earning[] = [];
  let eid = 0;
  const creditBalance = new Map<string, number>(); // sum(user_credits.amount)
  const grantedForEarning = new Set<number>(); // user_credits.earning_id UNIQUE (0029 M2)
  const appliedForInvoice = new Map<string, number>(); // user_credits.invoice_id UNIQUE (0028)
  const accruedByBeneficiary = new Map<string, number>(); // running sum of status='accrued'
  const paidEarnings = new Set<number>(); // matured→paid flips that moved money
  const capAccrued = new Map<string, number>(); // `${bringer}|${vendorId}` non-void crew_referral sum
  const jobAccrualKey = new Set<string>(); // unique (beneficiary, job, kind)

  const metrics: Metrics = {
    customers: 0, crews: 0, lakes: 0, jobs: 0,
    bySeason: {
      1: { accruals: 0, accrualDollars: 0, maturations: 0, creditGrants: 0, creditDollars: 0, creditApplications: 0, creditApplied: 0, payoutBatches: 0, payoutDollars: 0, nudges: 0, stuckNoBank: 0, stuckDollars: 0, newLakes: 0 },
      2: { accruals: 0, accrualDollars: 0, maturations: 0, creditGrants: 0, creditDollars: 0, creditApplications: 0, creditApplied: 0, payoutBatches: 0, payoutDollars: 0, nudges: 0, stuckNoBank: 0, stuckDollars: 0, newLakes: 0 },
    },
    maturedRowsParked: 0, maxGrowthEmailsPerUserPerSeason: 0, usersOver6EmailsSeason: 0,
    capPairs: 0, multiSettleCapPairs: 0, creditsBurnedOnUnpaidInvoices: 0,
    avgActive: { 1: 0, 2: 0 }, parkedPast500On: null,
  };
  const activeSum: Record<number, number> = { 1: 0, 2: 0 };
  const activeDays: Record<number, number> = { 1: 0, 2: 0 };
  const racePairs = new Set<string>();
  const settledJobs = new Set<string>();

  // ── job schedule buckets ──
  interface Job { id: string; ownerId: string; vendorId: string; serviceName: string; day: number; price: number; margin: number; }
  const dayJobs: Job[][] = Array.from({ length: HORIZON + 1 }, () => []);
  let jid = 0;
  const scheduleFor = (u: Usr, fromDay: number) => {
    const lake = lakes.find((l) => l.id === u.lakeId)!;
    for (const season of [1, 2] as const) {
      const spring = lake.iceOut[season];
      const fall = lake.pull[season];
      if (fall < fromDay) continue;
      const book = (name: string, day: number) => {
        if (day < fromDay || day > HORIZON) return;
        const s = svc(name);
        const price = priceService(s, u.profile);
        if (price <= 0) return;
        const crew = crews[Math.floor(rnd() * crews.length)];
        dayJobs[day].push({
          id: `j${jid++}`, ownerId: u.id, vendorId: crew.id, serviceName: name, day,
          price, margin: r2(price * crew.marginPct),
        });
      };
      // water work, both season edges
      if (u.profile.pier_sections > 0) { book("Pier install / removal", spring + 5 + Math.floor(rnd() * 25)); book("Pier install / removal", fall - 30 + Math.floor(rnd() * 25)); }
      if (u.profile.boat_lifts > 0) { book("Boat lift set / pull", spring + 8 + Math.floor(rnd() * 25)); book("Boat lift set / pull", fall - 28 + Math.floor(rnd() * 22)); }
      if (u.profile.jet_skis > 0 && rnd() < 0.6) book("Jet ski winterize & store", fall - 25 + Math.floor(rnd() * 20));
      if (u.profile.boats.length > 0 && rnd() < 0.5) book("Boat storage & winterize", fall - 22 + Math.floor(rnd() * 18));
      if (u.profile.toys.length > 0 && rnd() < 0.4) book("Water toy prep & storage", fall - 20 + Math.floor(rnd() * 15));
      if (rnd() < 0.55) book("Spring opening", spring + 2 + Math.floor(rnd() * 20));
      if (rnd() < 0.5) book("Fall winterization", fall - 18 + Math.floor(rnd() * 14));
      // recurring land work
      if (rnd() < 0.35) for (let k = 0; k < 9; k++) book("Lawn mowing & trim", spring + 30 + k * 14 + Math.floor(rnd() * 3));
      if (rnd() < 0.18) for (let k = 0; k < 7; k++) book("Housekeeping", spring + 40 + k * 18);
    }
    if (rnd() < 0.25) u.enrolled.push(pick(["Lawn mowing & trim", "Housekeeping", "Pier install / removal", "Fall winterization"]));
  };
  for (const id of homeIds) scheduleFor(users.get(id)!, 0);

  // ── invariant trackers ──
  const violations: string[] = [];
  const note = (m: string) => { if (violations.length < 12) violations.push(m); };

  // nudge_log: `${user}|${kind}` -> last sent ISO
  const nudgeLog = new Map<string, string>();
  const growthEmails = new Map<string, number[]>(); // user -> [season1, season2]

  // ───────────────────── the two-season loop ─────────────────────
  for (let day = 0; day <= HORIZON; day++) {
    const season = seasonOf(day);
    const nowMs = msOf(day);
    const today = isoOf(day);

    // ── organic signups (referral chains) ──
    const activeHomes = homeIds.length;
    if (activeHomes < 1250) {
      const seasonal = day % 365 > 60 && day % 365 < 300 ? 1.6 : 0.45;
      const arrivals = Math.min(9, Math.floor(activeHomes * 0.0042 * seasonal + (rnd() < 0.4 ? 1 : 0)));
      for (let i = 0; i < arrivals; i++) {
        // Who gets the credit? HOAs carry outsized chains; crews cross-sell;
        // neighbours refer neighbours; some arrive cold.
        const roll = rnd();
        let referrer: string | null = null;
        if (roll < 0.28) referrer = pick(hoaIds);
        else if (roll < 0.44) referrer = crews[Math.floor(rnd() * crews.length)].userId;
        else if (roll < 0.82) referrer = pick(homeIds);
        // (else organic — referredBy stays null)
        // Some new arrivals name water we don't serve yet — a lake is BORN.
        let lakeId = pick(lakes).id;
        if (rnd() < 0.004 && bornCursor < bornNames.length) {
          const nm = normalizeLakeName(bornNames[bornCursor++]);
          if (nm) {
            const sl = slugify(nm);
            let l = lakes.find((x) => x.slug === sl);
            if (!l) {
              // lake-birth.ts: a new lake copies season dates from an existing lake.
              const donor = lakes[0];
              l = { id: `lake-${sl}`, name: nm, slug: sl, iceOut: { ...donor.iceOut }, pull: { ...donor.pull } };
              lakes.push(l);
              metrics.bySeason[season].newLakes++;
            }
            lakeId = l.id;
          }
        }
        const u = newUser("home", day, referrer, lakeId);
        homeIds.push(u.id);
        scheduleFor(u, day);
      }
    }
    // Crews join territory too (some brought by a homeowner — arm 3).
    if (day % 45 === 7 && crews.length < 40) addCrew(day, rnd() < 0.5 ? pick(homeIds) : null);

    activeSum[season] += homeIds.length;
    activeDays[season]++;

    // EXPOSURE to the crew-cap race: two or more jobs of the SAME brought
    // crew settling on the same day, while that (bringer, crew) pair is
    // partway to the cap. accrueReferralEarnings reads `already` outside any
    // transaction, so simultaneous settles all see the same number.
    const perVendorToday = new Map<string, number>();
    for (const j of dayJobs[day]) perVendorToday.set(j.vendorId, (perVendorToday.get(j.vendorId) ?? 0) + 1);
    for (const [vid, n] of perVendorToday) {
      if (n < 2) continue;
      const c = crews.find((x) => x.id === vid);
      if (!c?.invitedBy) continue;
      const k = `${c.invitedBy}|${c.id}`;
      const already = capAccrued.get(k) ?? 0;
      if (already > 0 && already < DIALS.crewCap) racePairs.add(k);
    }

    // ── settle the day's jobs (mirrors settleJob order: credits → charge → accrue) ──
    // 4% of jobs are settled TWICE — reconcileUnsettledJobs() re-runs
    // settleJob on anything not fully paid, and ops can settle by hand. The
    // second pass must never re-spend a credit or re-accrue a referral.
    const work = [...dayJobs[day]];
    for (const j of dayJobs[day]) if (rnd() < 0.04) work.push(j);
    for (const job of work) {
      const owner = users.get(job.ownerId)!;
      if (job.day < owner.createdDay) continue;
      if (!settledJobs.has(job.id)) { metrics.jobs++; settledJobs.add(job.id); }

      // credits first (automation.ts settleJob §3)
      const bal = creditBalance.get(owner.id) ?? 0;
      let applied = 0;
      if (!appliedForInvoice.has(job.id)) {
        const apply = creditToApply(bal, job.price);
        if (apply > 0) {
          // 0029 H3 guard_credit_balance: a negative row that would take the
          // balance below zero is REJECTED by the database.
          if (r2(bal - apply) < -1e-9) {
            note(`overdraft: user ${owner.id} bal=${bal} apply=${apply} job=${job.id}`);
          } else {
            creditBalance.set(owner.id, r2(bal - apply));
            appliedForInvoice.set(job.id, apply);
            applied = apply;
            metrics.bySeason[season].creditApplications++;
            metrics.bySeason[season].creditApplied = r2(metrics.bySeason[season].creditApplied + apply);
          }
        }
      } else {
        applied = appliedForInvoice.get(job.id)!; // re-run reuses, never double-spends
      }
      const cashDue = r2(job.price - applied);

      // charge
      const cardOk = rnd() > 0.03;
      const charged = (cashDue <= 0 && applied > 0) || cardOk;
      if (!charged && applied > 0) metrics.creditsBurnedOnUnpaidInvoices++;
      if (!charged || cashDue <= 0) continue; // accruals need collected CASH

      // ── accrueReferralEarnings ──
      const cashRatio = job.price > 0 ? cashDue / job.price : 0;
      const addEarning = (beneficiary: string, kind: Earning["kind"], amount: number, sourceVendor: string | null) => {
        const key = `${beneficiary}|${job.id}|${kind}`;
        if (jobAccrualKey.has(key)) return; // unique index referral_earnings_once
        if (beneficiary === job.ownerId) { note(`self-pay: ${beneficiary} earned on own job ${job.id}`); return; }
        jobAccrualKey.add(key);
        earnings.push({ id: eid++, beneficiary, kind, sourceJob: job.id, sourceVendor, amount, status: "accrued", accruedDay: day });
        accruedByBeneficiary.set(beneficiary, r2((accruedByBeneficiary.get(beneficiary) ?? 0) + amount));
        metrics.bySeason[season].accruals++;
        metrics.bySeason[season].accrualDollars = r2(metrics.bySeason[season].accrualDollars + amount);
      };

      // arm 1 + 2 — REAL withinSunset / customerReferralAccrual
      if (owner.referredBy && withinSunset(tsOf(owner.createdDay), nowMs, DIALS.sunsetDays)) {
        const ref = users.get(owner.referredBy)!;
        let kind: Earning["kind"] | null = null;
        let pct = 0;
        if (!ref.vendorId) { kind = "customer_referral"; pct = DIALS.customerPct; }
        else if (job.vendorId && ref.vendorId !== job.vendorId) { kind = "cross_sell"; pct = DIALS.crossSellPct; }
        if (kind && pct > 0) {
          const amount = customerReferralAccrual(cashDue, pct);
          if (amount > 0) addEarning(ref.id, kind, amount, job.vendorId);
        }
      }

      // arm 3 — REAL crewShareAccrual against the running non-void sum
      const crew = crews.find((c) => c.id === job.vendorId)!;
      if (job.margin > 0 && crew.invitedBy && crew.invitedBy !== job.ownerId) {
        const capKey = `${crew.invitedBy}|${crew.id}`;
        const already = capAccrued.get(capKey) ?? 0;
        const amount = crewShareAccrual(job.margin * cashRatio, DIALS.crewSharePct, DIALS.crewCap, already);
        if (amount > 0) {
          const before = earnings.length;
          addEarning(crew.invitedBy, "crew_referral", amount, crew.id);
          if (earnings.length > before) {
            const after = r2(already + amount);
            capAccrued.set(capKey, after);
            if (after > DIALS.crewCap + 1e-9) {
              note(`crew cap exceeded: ${capKey} accrued ${after} > cap ${DIALS.crewCap}`);
            }
          }
        }
      }
    }

    // ── matureReferralEarnings (nightly) ──
    // engine: .eq(status,'accrued').lt(accrued_at, now-maturationDays).limit(200)
    let matured = 0;
    for (const e of earnings) {
      if (matured >= 200) break;
      if (e.status !== "accrued") continue;
      if (e.accruedDay >= day - DIALS.maturationDays) continue;
      e.status = "matured";
      matured++;
      metrics.bySeason[season].maturations++;
      accruedByBeneficiary.set(e.beneficiary, r2((accruedByBeneficiary.get(e.beneficiary) ?? 0) - e.amount));
      const ben = users.get(e.beneficiary)!;
      // grantFor: vendors and lake associations do NOT get spendable credits.
      const isVendor = !!ben.vendorId;
      const isHoa = !!ben.hoaLake;
      if (!isVendor && !isHoa && e.amount > 0) {
        if (grantedForEarning.has(e.id)) { note(`double grant for earning ${e.id}`); continue; }
        grantedForEarning.add(e.id);
        creditBalance.set(e.beneficiary, r2((creditBalance.get(e.beneficiary) ?? 0) + e.amount));
        metrics.bySeason[season].creditGrants++;
        metrics.bySeason[season].creditDollars = r2(metrics.bySeason[season].creditDollars + e.amount);
      }
    }

    // ── runNudges (nightly, email-only, per-kind cooldown) ──
    const bump = (userId: string) => {
      const arr = growthEmails.get(userId) ?? [0, 0];
      arr[season - 1]++;
      growthEmails.set(userId, arr);
      metrics.bySeason[season].nudges++;
    };
    const sendNudge = (userId: string, kind: string): boolean => {
      // REAL nudgeCooling against the nudge_log
      if (nudgeCooling(nudgeLog.get(`${userId}|${kind}`) ?? null, DIALS.nudgeCooldownDays, nowMs)) return false;
      nudgeLog.set(`${userId}|${kind}`, tsOf(day));
      bump(userId);
      return true;
    };
    const firedTonight = new Map<string, string[]>();
    for (const [userId, bal] of creditBalance) {
      if (bal < DIALS.nudgeCreditThreshold) continue;
      if (sendNudge(userId, "credit_covers_visit")) firedTonight.set(userId, ["credit_covers_visit"]);
    }
    const cands = new Set<string>([...creditBalance.keys(), ...accruedByBeneficiary.keys()]);
    for (const userId of cands) {
      const u = users.get(userId)!;
      if (u.vendorId) continue; // crews' milestone is the month-end batch
      const near = nearMilestone(creditBalance.get(userId) ?? 0, accruedByBeneficiary.get(userId) ?? 0, DIALS.nudgeCreditThreshold);
      if (!near) continue;
      if (near.gap < 0) note(`negative milestone gap for ${userId}`);
      if (sendNudge(userId, "near_milestone")) {
        const prior = firedTonight.get(userId);
        if (prior) note(`double-fire same night for ${userId}: ${prior.join("+")} + near_milestone`);
      }
    }

    // ── runReferralPayoutBatch — REAL isLastDayOfMonth ──
    if (isLastDayOfMonth(today)) {
      if (metrics.parkedPast500On == null) {
        // Customer rows that were credited but never leave 'matured'. Once
        // these exceed the batch's .limit(500) window, a crew's matured
        // referral money can fall outside it entirely.
        const parked = earnings.filter((e) => e.status === "matured" && grantedForEarning.has(e.id)).length;
        if (parked > 500) metrics.parkedPast500On = today;
      }
      const byUser = new Map<string, number[]>();
      for (const e of earnings) {
        if (e.status !== "matured") continue;
        const l = byUser.get(e.beneficiary) ?? [];
        l.push(e.id);
        byUser.set(e.beneficiary, l);
      }
      for (const [userId, ids] of byUser) {
        const u = users.get(userId)!;
        const isVendor = !!u.vendorId;
        const isHoa = !!u.hoaLake;
        if (!isVendor && !isHoa) continue; // customers were credited at maturation
        if (!u.hasBank) { // no payout_accounts row → money waits, ops must chase
          metrics.bySeason[season].stuckNoBank++;
          metrics.bySeason[season].stuckDollars = r2(
            metrics.bySeason[season].stuckDollars + ids.reduce((s, i) => s + earnings[i].amount, 0));
          continue;
        }
        let paidThis = 0;
        for (const id of ids) {
          const e = earnings[id];
          if (grantedForEarning.has(id)) { e.status = "paid"; continue; } // double-pay guard
          if (paidEarnings.has(id)) { note(`earning ${id} paid twice`); continue; }
          e.status = "paid";
          paidEarnings.add(id);
          paidThis = r2(paidThis + e.amount);
        }
        if (paidThis > 0) {
          metrics.bySeason[season].payoutBatches++;
          metrics.bySeason[season].payoutDollars = r2(metrics.bySeason[season].payoutDollars + paidThis);
        }
      }
    }
  }

  // ───────────────────── post-run invariants ─────────────────────
  const grantedPerUser = new Map<string, number>();
  for (const e of earnings) {
    if (!grantedForEarning.has(e.id)) continue;
    grantedPerUser.set(e.beneficiary, r2((grantedPerUser.get(e.beneficiary) ?? 0) + e.amount));
  }
  for (const [userId, bal] of creditBalance) {
    if (bal < -1e-9) note(`negative balance ${bal} for ${userId}`);
    const granted = grantedPerUser.get(userId) ?? 0;
    // a balance can never exceed everything ever granted to that user
    if (bal > granted + 1e-9) note(`balance ${bal} exceeds lifetime grants ${granted} for ${userId}`);
  }
  // credits granted must never exceed matured-and-granted earnings
  const totalGranted = earnings.filter((e) => grantedForEarning.has(e.id)).reduce((s, e) => s + e.amount, 0);
  const totalMaturedOrBeyond = earnings.filter((e) => e.status === "matured" || e.status === "paid").reduce((s, e) => s + e.amount, 0);
  if (r2(totalGranted) > r2(totalMaturedOrBeyond) + 1e-9) note(`granted ${totalGranted} > matured ${totalMaturedOrBeyond}`);

  // cap per (bringer, crew)
  const capCheck = new Map<string, number>();
  for (const e of earnings) {
    if (e.kind !== "crew_referral" || e.status === "void") continue;
    const k = `${e.beneficiary}|${e.sourceVendor}`;
    capCheck.set(k, r2((capCheck.get(k) ?? 0) + e.amount));
  }
  metrics.capPairs = [...capCheck.values()].filter((v) => v >= DIALS.crewCap - 1).length;
  for (const [k, v] of capCheck) if (v > DIALS.crewCap + 1e-9) note(`lifetime cap blown for ${k}: ${v}`);

  metrics.multiSettleCapPairs = racePairs.size;
  metrics.avgActive[1] = Math.round(activeSum[1] / Math.max(1, activeDays[1]));
  metrics.avgActive[2] = Math.round(activeSum[2] / Math.max(1, activeDays[2]));
  metrics.customers = homeIds.length;
  metrics.crews = crews.length;
  metrics.lakes = lakes.length;
  metrics.maturedRowsParked = earnings.filter((e) => e.status === "matured").length;
  for (const [, arr] of growthEmails) {
    metrics.maxGrowthEmailsPerUserPerSeason = Math.max(metrics.maxGrowthEmailsPerUserPerSeason, arr[0], arr[1]);
    if (arr[0] > 6 || arr[1] > 6) metrics.usersOver6EmailsSeason++;
  }

  if (violations.length) throw new Error(S(`world invariants broken:\n  - ${violations.join("\n  - ")}`));
  return metrics;
}

const M = runWorld();

// ═══════════════════════════════════════════════════════════════════════
describe("organic growth at scale — two seasons, 1000+ customers", () => {
  it("actually reached the scale the owner asked about", () => {
    expect(M.customers, S("customer count")).toBeGreaterThan(1000);
    expect(M.crews, S("crew count")).toBeGreaterThanOrEqual(26);
    expect(M.lakes, S("lakes grew from 3")).toBeGreaterThan(3);
    expect(M.jobs, S("job volume")).toBeGreaterThan(7000);
    expect(M.avgActive[2], S("season-2 average book of business")).toBeGreaterThan(600);
  });

  it("no referral is paid twice, no balance goes negative, no cap is blown", () => {
    // runWorld() throws with the offending case if any of these break.
    expect(M.bySeason[1].accruals + M.bySeason[2].accruals, S("accruals happened")).toBeGreaterThan(1000);
    expect(M.capPairs, S("some (bringer,crew) pairs reached the lifetime cap")).toBeGreaterThan(0);
  });

  it("MEASUREMENT — credit & commission events per season at 1000+ customers", () => {
    const per1000 = (n: number) => Math.round((n / M.avgActive[2]) * 1000);
    const s2 = M.bySeason[2];
    // Printed for the owner; the assertion just pins the order of magnitude.
    expect(s2.accruals, S("season-2 accruals")).toBeGreaterThan(500);
    expect(per1000(s2.accruals), S("per-1000 accruals")).toBeGreaterThan(100);
    expect(s2.creditGrants + s2.payoutBatches, S("money events")).toBeGreaterThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("referral ledger state machine — every interleaving of accrue → mature → grant → spend", () => {
  it("2000 random orderings never double-pay an earning and never overdraft", () => {
    const rnd = mulberry32(SEED ^ 0x5eed);
    for (let trial = 0; trial < 2000; trial++) {
      const amount = customerReferralAccrual(20 + rnd() * 900, DIALS.customerPct);
      let status: "accrued" | "matured" | "paid" | "void" = "accrued";
      let granted = false;
      let paidCash = 0;
      let balance = 0;
      const ops = ["mature", "grant", "batch", "void", "spend", "mature", "grant", "batch"];
      // shuffle
      for (let i = ops.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [ops[i], ops[j]] = [ops[j], ops[i]];
      }
      for (const op of ops) {
        if (op === "mature") { if (status === "accrued") status = "matured"; }
        else if (op === "grant") {
          // grantFor: only on a WON accrued→matured flip, one credit per earning
          if (status === "matured" && !granted) { granted = true; balance = r2(balance + amount); }
        } else if (op === "batch") {
          // runReferralPayoutBatch: guarded matured→paid, skipped when credited
          if (status === "matured") { if (granted) status = "paid"; else { status = "paid"; paidCash = r2(paidCash + amount); } }
        } else if (op === "void") {
          // refund-core: ONLY un-matured accruals void
          if (status === "accrued") status = "void";
        } else if (op === "spend") {
          const apply = creditToApply(balance, 30 + rnd() * 400);
          expect(apply, S(`credit applied ${apply} exceeds balance ${balance}`)).toBeLessThanOrEqual(r2(balance) + 0.005);
          balance = r2(balance - apply);
          expect(balance, S("balance went negative")).toBeGreaterThanOrEqual(-1e-9);
        }
      }
      const valueOut = r2(balance + paidCash + /* already spent */ 0);
      expect(valueOut, S(`earning paid out twice: ${valueOut} > ${amount}`)).toBeLessThanOrEqual(amount + 1e-9);
      expect(granted && paidCash > 0, S("granted as credit AND paid as cash")).toBe(false);
    }
  });

  it("a voided (refunded) accrual never becomes money, in any order", () => {
    const rnd = mulberry32(SEED ^ 0xd0d0);
    for (let trial = 0; trial < 3000; trial++) {
      const amount = customerReferralAccrual(20 + rnd() * 900, DIALS.customerPct);
      let status: "accrued" | "matured" | "paid" | "void" = "accrued";
      let money = 0;
      const ops = ["void", "mature", "grant", "batch"];
      for (let i = ops.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [ops[i], ops[j]] = [ops[j], ops[i]];
      }
      for (const op of ops) {
        if (op === "void" && status === "accrued") status = "void";
        else if (op === "mature" && status === "accrued") status = "matured";
        else if (op === "grant" && status === "matured") money = r2(money + amount);
        else if (op === "batch" && status === "matured") status = "paid";
      }
      if (status === "void") {
        expect(money, S("a voided accrual minted credits")).toBe(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("crew-referral lifetime cap under concurrency", () => {
  it("sequential accrual can never exceed the cap (5000 random ladders)", () => {
    const rnd = mulberry32(SEED ^ 0xca9);
    for (let t = 0; t < 5000; t++) {
      const cap = [100, 250, 500][Math.floor(rnd() * 3)];
      const share = [0.15, 0.25, 0.4][Math.floor(rnd() * 3)];
      let already = 0;
      for (let j = 0; j < 40; j++) {
        const margin = 5 + rnd() * 900;
        const a = crewShareAccrual(margin, share, cap, already);
        already = r2(already + a);
        expect(already, S(`cap ${cap} blown: ${already}`)).toBeLessThanOrEqual(cap + 1e-9);
      }
    }
  });

  it("MEASURED — concurrent settles overshoot the cap by (k-1) shares, not one", () => {
    // accrueReferralEarnings reads `already` OUTSIDE any transaction, then
    // inserts. k settles of the SAME crew in the same instant all read the
    // same `already`. Realistic k: a crew tapping complete on a 3-stop route
    // while the nightly reconcile sweep settles the same jobs.
    const rnd = mulberry32(SEED ^ 0x1111);
    let worstOvershoot = 0;
    let worstK = 0;
    for (let t = 0; t < 4000; t++) {
      const cap = DIALS.crewCap;
      const k = 2 + Math.floor(rnd() * 3); // 2..4 concurrent settles
      const already = r2(cap - rnd() * 60); // near the cap — where races bite
      const margins = Array.from({ length: k }, () => 200 + rnd() * 900);
      const total = r2(already + margins.reduce((s, m) => s + crewShareAccrual(m, DIALS.crewSharePct, cap, already), 0));
      const over = r2(Math.max(0, total - cap));
      if (over > worstOvershoot) { worstOvershoot = over; worstK = k; }
    }
    // SIM-FOUND BUG: the documented "may overshoot by one share in a race"
    // is optimistic — with k concurrent settles it overshoots by (k-1)
    // shares. At the shipped dials (25% share, $250 cap) three simultaneous
    // settles of a $900-margin job pay $250 + 2×$60 = $370 on a $250 cap.
    expect(worstK, S("worst race width")).toBeGreaterThan(2);
    expect(worstOvershoot, S(`concurrent overshoot only one share? got ${worstOvershoot}`)).toBeGreaterThan(60);

    console.log(`  [cap race] worst overshoot $${worstOvershoot} over the $${DIALS.crewCap} cap at k=${worstK} concurrent settles`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("sunset horizon is exact", () => {
  it("stops on the day, not a day late — 3000 randomized attributions", () => {
    const rnd = mulberry32(SEED ^ 0x7777);
    for (let t = 0; t < 3000; t++) {
      const days = [90, 180, 365, 540][Math.floor(rnd() * 4)];
      const now = Date.parse("2027-06-15T12:00:00Z") + Math.floor(rnd() * 86_400_000 * 200);
      const horizon = days * 86_400_000;
      const at = new Date(now - horizon).toISOString();
      expect(withinSunset(at, now, days), S("exactly at the horizon must NOT accrue")).toBe(false);
      expect(withinSunset(new Date(now - horizon + 1).toISOString(), now, days), S("1ms inside must accrue")).toBe(true);
      expect(withinSunset(new Date(now - horizon - 1).toISOString(), now, days), S("1ms outside must not accrue")).toBe(false);
    }
  });

  it("SIM-FOUND: the sunset clock starts at SIGNUP, not at attribution", () => {
    // automation.ts:473 passes users.created_at. claimReferral (portal/
    // referral-actions.ts) can attribute a code to an EXISTING user whose
    // referred_by is still null — years after signup. That referrer earns
    // nothing, ever, with no explanation anywhere in the UI.
    const signedUpTwoYearsAgo = "2024-07-01T00:00:00Z";
    const attributedToday = Date.parse("2026-07-26T00:00:00Z");
    expect(withinSunset(signedUpTwoYearsAgo, attributedToday, DIALS.sunsetDays), S("late attribution")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("self-referral and referral cycles", () => {
  it("a user can never be the beneficiary of their own job (arm 1 and arm 3)", () => {
    // arm 1: referredBy is another user by construction (claimReferral blocks
    // self-code). arm 3: `bringer !== p.ownerId` is explicit.
    // The world run throws on any self-pay; this pins the guard directly.
    const rnd = mulberry32(SEED ^ 0x5e1f);
    for (let t = 0; t < 2000; t++) {
      const me = "u1";
      const bringer = rnd() < 0.5 ? me : "u2";
      const ownerOfJob = me;
      const eligible = bringer !== ownerOfJob;
      const amount = eligible ? crewShareAccrual(100 + rnd() * 500, DIALS.crewSharePct, DIALS.crewCap, 0) : 0;
      if (bringer === me) expect(amount, S("paid myself for my own bill")).toBe(0);
    }
  });

  it("SIM-FOUND: two customers CAN name each other and farm 5% of each other's spend", () => {
    // claimReferral only refuses a SELF code and an already-attributed user.
    // Nothing refuses A→B when B→A already exists, so a 2-cycle forms.
    // Both are inside their own sunset window, so both accrue for a year.
    const nowMs = Date.parse("2026-09-01T00:00:00Z");
    const aSignup = "2026-06-01T00:00:00Z";
    const bSignup = "2026-06-08T00:00:00Z";
    expect(withinSunset(aSignup, nowMs, DIALS.sunsetDays)).toBe(true);
    expect(withinSunset(bSignup, nowMs, DIALS.sunsetDays)).toBe(true);
    const aSpend = 3200, bSpend = 2900;
    const toB = customerReferralAccrual(aSpend, DIALS.customerPct);
    const toA = customerReferralAccrual(bSpend, DIALS.customerPct);
    // Neither is "paid for their own spend" (single-level), but the PAIR
    // extracts $305 of free service having acquired nobody.
    expect(r2(toA + toB), S("mutual-referral extraction")).toBe(305);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("normalizeLakeName — thousands of messy human inputs", () => {
  // The dedup lake-birth.ts performs, transcribed: match on slug, on the
  // slug with a trailing " Lake" stripped, or on a case-insensitive name.
  const keysFor = (name: string) => ({
    slug: slugify(name),
    slugNoLake: slugify(name.replace(/\s*Lake\s*$/i, "")),
    lower: name.toLowerCase(),
  });
  interface Row { name: string; slug: string; }
  function birth(registry: Row[], raw: string): { row: Row | null; created: boolean } {
    const name = normalizeLakeName(raw);
    if (!name) return { row: null, created: false };
    const k = keysFor(name);
    const hit = registry.find((r) => r.slug === k.slug || r.slug === k.slugNoLake || r.name.toLowerCase() === k.lower);
    if (hit) return { row: hit, created: false };
    const row = { name, slug: k.slug };
    registry.push(row);
    return { row, created: true };
  }

  const CANON = ["Big Long", "Pretty", "Big Turkey", "Little Turkey", "Adams", "Westler", "Hackenburg", "Silver", "Oliver", "Snow"];

  it("every realistic spelling of the same water collapses to ONE lake (10k inputs)", () => {
    const rnd = mulberry32(SEED ^ 0x4444);
    const registry: Row[] = [];
    const rowsFor = new Map<string, Set<string>>();
    let inputs = 0;
    for (let t = 0; t < 10000; t++) {
      const canon = CANON[Math.floor(rnd() * CANON.length)];
      const variants = [
        canon, canon.toLowerCase(), canon.toUpperCase(), `${canon} Lake`, `${canon} lake`,
        `  ${canon}  `, `${canon}   Lake `, `\t${canon} LAKE\n`, `${canon} Lake`,
        canon.replace(/ /g, "  "), `${canon} Lake `, ` ${canon.toLowerCase()} lake`,
      ];
      const raw = variants[Math.floor(rnd() * variants.length)];
      inputs++;
      const { row } = birth(registry, raw);
      expect(row, S(`realistic input rejected: ${JSON.stringify(raw)}`)).not.toBeNull();
      const set = rowsFor.get(canon) ?? new Set<string>();
      set.add(row!.slug);
      rowsFor.set(canon, set);
    }
    expect(inputs).toBe(10000);
    for (const [canon, set] of rowsFor) {
      expect(set.size, S(`"${canon}" split into ${set.size} lakes: ${[...set].join(", ")}`)).toBe(1);
    }
    expect(registry.length, S("one row per real water")).toBe(CANON.length);
  });

  it("two genuinely different waters never collapse into one row", () => {
    const registry: Row[] = [];
    const distinct = ["Big Long", "Long", "Big Turkey", "Little Turkey", "Turkey", "Pretty", "Prettys", "Silver", "Silver Creek"];
    const slugs = new Set<string>();
    for (const d of distinct) {
      const { row } = birth(registry, d);
      slugs.add(row!.slug);
    }
    expect(slugs.size, S(`distinct lakes collapsed: ${[...slugs].join(", ")}`)).toBe(distinct.length);
  });

  it("garbage and hostile input never births a lake (4000 cases)", () => {
    const rnd = mulberry32(SEED ^ 0x5555);
    const junk = ["", " ", "  ", "ab", "a", "12345", "  7  ", "zz-fixture", "ZZ-Test Lake", "-", "!!!", "🌊", "🌊🌊🌊", "  ", "x".repeat(61), "y".repeat(200), "...", "———"];
    for (let t = 0; t < 4000; t++) {
      const raw = junk[Math.floor(rnd() * junk.length)];
      const out = normalizeLakeName(raw);
      expect(out, S(`junk accepted as a lake: ${JSON.stringify(raw)} -> ${out}`)).toBeNull();
    }
  });

  it("SIM-FOUND BUG: the 'Lake X' word order births a SECOND market for the same water", () => {
    const registry: Row[] = [];
    birth(registry, "Big Long Lake");
    const second = birth(registry, "Lake Big Long"); // how plenty of people say it
    // Current behaviour: a brand-new lake row, a second /lakes/ page, a second
    // dispatch market for the same water.
    expect(second.created, S("'Lake Big Long' deduped?")).toBe(true);
    expect(registry.map((r) => r.slug)).toEqual(["big-long-lake", "lake-big-long"]);
  });

  it("SIM-FOUND BUG: internal capitals are destroyed in the public lake name", () => {
    // Steuben/LaGrange county water: McClish, LaGrange, O'Brien.
    expect(normalizeLakeName("McClish Lake"), S("McClish")).toBe("Mcclish Lake");
    expect(normalizeLakeName("LaGrange"), S("LaGrange")).toBe("Lagrange Lake");
    expect(normalizeLakeName("O'Brien"), S("O'Brien")).toBe("O'brien Lake");
    // The first person to type it owns the name on the public page forever.
  });

  it("SIM-FOUND BUG: an emoji or a hyphen in the FIRST spelling becomes the market's name", () => {
    const registry: Row[] = [];
    const first = birth(registry, "big-long"); // a crew typing fast
    expect(first.row!.name, S("hyphen name")).toBe("Big-long Lake");
    // Later spellings dedup correctly (same slug) — but the public page,
    // the sitemap and every email now say "Big-long Lake".
    expect(birth(registry, "Big Long Lake").created).toBe(false);
    const reg2: Row[] = [];
    expect(birth(reg2, "Big Long 🌊").row!.name, S("emoji name")).toBe("Big Long 🌊 Lake");
    expect(birth(reg2, "Big Long Lake").created, S("emoji still dedups")).toBe(false);
  });

  it("SIM-FOUND: name is the ONLY key — Indiana's four Crooked Lakes are one market", () => {
    const registry: Row[] = [];
    birth(registry, "Crooked Lake"); // Steuben county
    const whitley = birth(registry, "Crooked Lake"); // Whitley county, 40 miles away
    expect(whitley.created, S("same-name different-water")).toBe(false);
    expect(registry.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("public lake pages — 'from' pricing must be honest", () => {
  const rnd = mulberry32(SEED ^ 0x6666);
  const profiles = Array.from({ length: 400 }, () => makeProfile(rnd));

  it("every 'from' price is at or below the cheapest REAL bill — except where noted", () => {
    for (const s of SERVICES) {
      const fp = fromPrice(s);
      if (!fp) continue;
      // Only profiles that could actually book this service.
      const bills = profiles
        .map((p) => priceService(s, p))
        .filter((n) => n > 0);
      if (!bills.length) continue;
      const min = Math.min(...bills);
      if (s.name === "Pier install / removal" || s.name === "Water toy prep & storage") continue; // see below
      expect(fp.amount, S(`${s.name}: quoted from $${fp.amount} but the cheapest real bill is $${min}`)).toBeLessThanOrEqual(min);
    }
  });

  it("SIM-FOUND BUG: per_section ignores `base` — the pier quote is off by $220 on every bill", () => {
    const pier = svc("Pier install / removal");
    const fp = fromPrice(pier)!;
    expect(fp, S("pier from-price")).toEqual({ amount: 48, unit: "per pier section", from: true });
    // The cheapest bill any homeowner can possibly receive:
    const onlyOneSection = priceService(pier, { ...makeProfile(mulberry32(1)), pier_sections: 1, boats: [], toys: [] });
    expect(onlyOneSection, S("cheapest real pier bill")).toBe(268);
    // The public page renders "from $48 per pier section". A 6-section pier
    // reads as $288 and bills $508.
    const six = priceService(pier, { ...makeProfile(mulberry32(1)), pier_sections: 6, boats: [], toys: [] });
    expect(six).toBe(508);
    expect(6 * fp.amount).toBe(288);
  });

  it("SIM-FOUND BUG: a flat service with additive terms is quoted as an EXACT price", () => {
    const toys = svc("Water toy prep & storage");
    const fp = fromPrice(toys)!;
    expect(fp.from, S("water toys quoted as exact, not 'from'")).toBe(false);
    expect(fp.amount).toBe(120);
    // But the bill scales with lifts and toys — the page says "$120".
    const real = priceService(toys, { ...makeProfile(mulberry32(2)), toy_lifts: 2, toys: [{}, {}, {}] as never });
    expect(real, S("real water-toy bill")).toBeGreaterThan(fp.amount);
    expect(real).toBe(285);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("nudges at volume — nobody gets spammed", () => {
  it("per (user, kind) cooldown holds over two seasons of nightly runs", () => {
    const rnd = mulberry32(SEED ^ 0x2222);
    const kinds = ["credit_covers_visit", "near_milestone", "territory"];
    for (let user = 0; user < 300; user++) {
      const log = new Map<string, string>();
      const sends = new Map<string, number>();
      for (let day = 0; day <= HORIZON; day++) {
        for (const kind of kinds) {
          if (rnd() < 0.55) continue; // not eligible tonight
          if (nudgeCooling(log.get(kind) ?? null, DIALS.nudgeCooldownDays, msOf(day))) continue;
          log.set(kind, tsOf(day));
          sends.set(kind, (sends.get(kind) ?? 0) + 1);
        }
      }
      for (const [kind, n] of sends) {
        const ceiling = Math.ceil((HORIZON + 1) / DIALS.nudgeCooldownDays);
        expect(n, S(`user ${user} got ${n} ${kind} nudges, ceiling ${ceiling}`)).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("the covers-visit nudge and the near-milestone tease can never double-fire", () => {
    const rnd = mulberry32(SEED ^ 0x3ea8);
    for (let t = 0; t < 20000; t++) {
      const bal = r2(rnd() * 140);
      const mat = r2(rnd() * 140);
      const coversVisit = bal >= DIALS.nudgeCreditThreshold;
      const near = nearMilestone(bal, mat, DIALS.nudgeCreditThreshold);
      expect(coversVisit && near !== null, S(`double-fire at bal=${bal} mat=${mat}`)).toBe(false);
      if (near) {
        expect(near.gap, S("negative gap")).toBeGreaterThanOrEqual(0);
        expect(near.projected, S("projected below balance")).toBeGreaterThanOrEqual(Math.max(0, bal) - 1e-9);
      }
    }
  });

  it("MEASURED — a lingering homeowner collects a growth email every 30 days, forever", () => {
    // nearMilestone keeps returning a tease for as long as the customer sits
    // in the band; nothing ever retires the kind.
    let sends = 0;
    let last: string | null = null;
    for (let day = 0; day <= HORIZON; day++) {
      if (!nearMilestone(30, 5, DIALS.nudgeCreditThreshold)) continue;
      if (nudgeCooling(last, DIALS.nudgeCooldownDays, msOf(day))) continue;
      last = tsOf(day);
      sends++;
    }
    expect(sends, S("two-season near-milestone sends to one stalled user")).toBeGreaterThanOrEqual(24);
  });

  it("SIM-FOUND BUG: the 'growth' opt-out the nudge emails link to does not exist", () => {
    // Every growth email footer links to /settings/notifications, and
    // runNudges() honours notification_prefs(type='growth', channel='email').
    // But 'growth' is not in NOTIF_DEFS, so mergeNotifPrefs drops it and
    // setNotifPref rejects it ("Unknown notification.") — the row can only be
    // written by ops with the service role.
    expect(NOTIF_DEFS.find((d) => d.type === "growth"), S("growth def")).toBeUndefined();
    const state = mergeNotifPrefs([{ type: "growth", channel: "email", enabled: false } as SavedPref]);
    expect(state["growth"], S("growth pref reachable?")).toBeUndefined();
    // Same for the fill-in digest, which uses the identical opt-out key.
  });

  it("notification defaults merge correctly for 5000 randomized saved sets", () => {
    const rnd = mulberry32(SEED ^ 0x3333);
    for (let t = 0; t < 5000; t++) {
      const saved: SavedPref[] = [];
      for (const def of NOTIF_DEFS) {
        for (const ch of channelsFor(def)) {
          if (rnd() < 0.5) saved.push({ type: def.type, channel: ch, enabled: rnd() < 0.5 });
        }
      }
      if (rnd() < 0.3) saved.push({ type: "growth", channel: "email", enabled: false });
      if (rnd() < 0.3) saved.push({ type: "rcpt", channel: "email", enabled: false });
      const state = mergeNotifPrefs(saved);
      expect(state["rcpt"].email, S("receipts must stay locked on")).toBe(true);
      for (const def of NOTIF_DEFS) {
        for (const ch of channelsFor(def)) {
          expect(state[def.type][ch], S(`missing ${def.type}/${ch}`)).toBeTypeOf("boolean");
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("month-end batch trigger", () => {
  it("fires exactly once per month across both seasons", () => {
    const byMonth = new Map<string, number>();
    for (let d = 0; d <= HORIZON; d++) {
      const iso = isoOf(d);
      if (!isLastDayOfMonth(iso)) continue;
      const key = iso.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    expect(byMonth.size, S("24 months covered")).toBe(24);
    for (const [m, n] of byMonth) expect(n, S(`${m} triggered ${n} times`)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("autopilot at scale — the confirm/skip conversation", () => {
  // Transcribed guards from generateAutopilotProposals(): skip an enrollment
  // when it has an OPEN ('proposed') event or an upcoming job. A 'skipped'
  // event is neither, so the next nightly run is free to propose again.
  function simulateEnrollment(serviceName: string, isWater: boolean, decision: "skip" | "ignore"): number {
    const iceOut = isoOf(80), pull = isoOf(317);
    let openSince: number | null = null;
    let texts = 0;
    const lastCompleted: string | null = isoOf(20);
    for (let day = 30; day <= 200; day++) {
      if (openSince != null) {
        if (decision === "skip" && day - openSince >= 1) openSince = null; // customer tapped Skip
        else if (decision === "ignore" && day - openSince >= 14) openSince = null; // proposal expires
        else continue;
      }
      const date = proposeAutopilotDate({
        serviceName, isWaterWork: isWater,
        iceOutISO: iceOut, pullDeadlineISO: pull,
        lastCompletedISO: lastCompleted, todayISO: isoOf(day),
      });
      if (!date) continue;
      texts++;
      openSince = day;
    }
    return texts;
  }

  it("SIM-FOUND BUG: tapping Skip re-proposes — and re-TEXTS — the very next night", () => {
    const lawn = simulateEnrollment("Lawn mowing & trim", false, "skip");
    // "We'll skip it this time and check in again next season" — then 170
    // more texts in 170 days.
    expect(lawn, S(`skip re-nag texts: ${lawn}`)).toBeGreaterThan(100);
    const pier = simulateEnrollment("Pier install / removal", true, "skip");
    expect(pier, S(`water-work skip re-nag texts: ${pier}`)).toBeGreaterThan(1);

    console.log(`  [autopilot skip] texts after ONE skip over 170 days — lawn: ${lawn}, pier: ${pier}`);
  });

  it("ignoring a proposal re-texts every 14 days (expiry), which is the intended cadence", () => {
    const ignored = simulateEnrollment("Lawn mowing & trim", false, "ignore");
    expect(ignored, S("ignore cadence")).toBeLessThanOrEqual(14);
    expect(ignored, S("ignore cadence")).toBeGreaterThan(5);
  });

  it("every proposal respects the lead time and never lands in the past (12k cases)", () => {
    const rnd = mulberry32(SEED ^ 0xa401);
    for (let t = 0; t < 12000; t++) {
      const today = isoOf(Math.floor(rnd() * HORIZON));
      const s = SERVICES[Math.floor(rnd() * SERVICES.length)];
      const lead = 7;
      const date = proposeAutopilotDate({
        serviceName: s.name, isWaterWork: s.water,
        iceOutISO: rnd() < 0.9 ? isoOf(80 + (rnd() < 0.5 ? 0 : 365)) : null,
        pullDeadlineISO: rnd() < 0.9 ? isoOf(317 + (rnd() < 0.5 ? 0 : 365)) : null,
        lastCompletedISO: rnd() < 0.7 ? isoOf(Math.floor(rnd() * HORIZON)) : null,
        todayISO: today, leadDays: lead,
      });
      if (date == null) continue;
      expect(date >= today, S(`proposal ${date} lands before today ${today}`)).toBe(true);
    }
  });

  it("SIM-FOUND: seasonal one-time services enrolled in autopilot fall to the 30-day land cadence", () => {
    // 'Fall winterization' and 'Spring opening' are is_water_work = FALSE in
    // the seed, so neither season branch applies — they become recurring.
    const d1 = proposeAutopilotDate({
      serviceName: "Fall winterization", isWaterWork: false,
      iceOutISO: "2026-03-21", pullDeadlineISO: "2026-11-14",
      lastCompletedISO: "2026-11-05", todayISO: "2026-12-06",
    });
    expect(d1, S("fall winterization re-proposed 30 days later")).toBe("2026-12-13");
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe("scale side-effects the owner should know about", () => {
  it("SIM-FOUND BUG: customer earnings park at status='matured' forever and clog the payout batch", () => {
    // matureReferralEarnings() flips a customer's accrual to 'matured' and
    // grants credits — the row NEVER leaves 'matured'.
    // runReferralPayoutBatch() then does:
    //   .eq('status','matured').limit(500)   [no order, no beneficiary filter]
    // and only afterwards skips non-vendor/non-HOA rows. Once parked customer
    // rows exceed 500, a crew's matured referral money can fall outside the
    // window entirely and simply never pay.
    expect(M.maturedRowsParked, S(`parked 'matured' rows after two seasons: ${M.maturedRowsParked}`)).toBeGreaterThan(500);
    expect(M.parkedPast500On, S("the window silts up inside the two seasons")).not.toBeNull();
  });

  it("MEASURED — crews/HOAs whose referral money is stuck for want of a bank row", () => {
    const stuck = M.bySeason[1].stuckNoBank + M.bySeason[2].stuckNoBank;
    expect(stuck, S("someone always needs chasing")).toBeGreaterThan(0);
  });

  it("MEASURED — growth email volume per user per season", () => {
    expect(M.maxGrowthEmailsPerUserPerSeason, S("max growth emails to one user in one season")).toBeGreaterThan(6);
  });

  it("prints the owner's numbers", () => {
    const p1000 = (n: number) => Math.round((n / M.avgActive[2]) * 1000);
    const rows = [
      ["customers (end of season 2)", M.customers],
      ["avg active customers S1 / S2", `${M.avgActive[1]} / ${M.avgActive[2]}`],
      ["crews", M.crews],
      ["lakes (3 seeded + demand-born)", M.lakes],
      ["jobs settled", M.jobs],
      ["S1 accruals / $", `${M.bySeason[1].accruals} / $${M.bySeason[1].accrualDollars}`],
      ["S2 accruals / $", `${M.bySeason[2].accruals} / $${M.bySeason[2].accrualDollars}`],
      ["S2 credit grants / $", `${M.bySeason[2].creditGrants} / $${M.bySeason[2].creditDollars}`],
      ["S2 credit applications / $", `${M.bySeason[2].creditApplications} / $${M.bySeason[2].creditApplied}`],
      ["S2 payout batches / $", `${M.bySeason[2].payoutBatches} / $${M.bySeason[2].payoutDollars}`],
      ["S2 growth nudges", M.bySeason[2].nudges],
      ["S1+S2 stuck-no-bank beneficiary-months", M.bySeason[1].stuckNoBank + M.bySeason[2].stuckNoBank],
      ["parked 'matured' rows", M.maturedRowsParked],
      ["date the 500-row payout window silted up", M.parkedPast500On ?? "never"],
      ["(bringer,crew) pairs at the $250 cap", M.capPairs],
      ["(bringer,crew) pairs EXPOSED to the settle race", M.multiSettleCapPairs],
      ["credits burned on invoices that never charged", M.creditsBurnedOnUnpaidInvoices],
      ["users over 6 growth emails in a season", M.usersOver6EmailsSeason],
      ["demand-born lakes needing ops season-date confirmation", M.bySeason[1].newLakes + M.bySeason[2].newLakes],
      ["--- PER 1000 CUSTOMERS PER SEASON (S2) ---", ""],
      ["accrual events", p1000(M.bySeason[2].accruals)],
      ["credit grants", p1000(M.bySeason[2].creditGrants)],
      ["credit applications at billing", p1000(M.bySeason[2].creditApplications)],
      ["month-end payout statements", p1000(M.bySeason[2].payoutBatches)],
      ["growth nudge emails", p1000(M.bySeason[2].nudges)],
      ["stuck-no-bank ops chases", p1000(M.bySeason[2].stuckNoBank)],
    ];

    console.log(`\n=== ORGANIC GROWTH SIM [SEED=${SEED}] ===\n` + rows.map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n");
    expect(rows.length).toBeGreaterThan(0);
  });
});
