/**
 * ============================================================================
 * MONEY LEDGER — TWO-SEASON SCALE SIMULATION
 * ============================================================================
 *
 * Owner's ask: "1000+ customers, two lake seasons, new lakes, HOAs, as many
 * crews as needed, organic onboarding with referrals, credits/commissions
 * tracked — find the bugs and the sticking points of human interaction."
 *
 * This file is the MONEY lane: refunds, clawbacks, payouts, cancellation
 * fees, disputes, referral commissions and credits.
 *
 * METHOD — property-based simulation, not example tests:
 *   * a seeded PRNG (mulberry32) builds a world: lakes that grow 3 → 6,
 *     ~1,000 homeowner accounts plus HOA-scale accounts, properties with
 *     real profile spread, 10–40 crews with their own rate cards;
 *   * every dollar decision is made by the REAL engine functions
 *     (src/lib/refunds.ts, payouts.ts, cancellation.ts, dispute-policy.ts,
 *     growth.ts, referrals.ts, pricing.ts) — nothing here reimplements them;
 *   * the harness around them mirrors what the server actions actually do
 *     (src/lib/refund-core.ts, src/app/requests/actions.ts,
 *      src/app/vendor/bank-actions.ts, src/lib/automation.ts) so the
 *     invariants are asserted against REACHABLE sequences, not toy inputs;
 *   * every case asserts CONSERVATION: no cent is created or destroyed.
 *
 * Determinism: SEED below reproduces any failure exactly. Failures are
 * collected (not thrown mid-loop) so one run reports the whole picture, and
 * every collected failure carries the seed + the minimal inputs.
 *
 * FILE OWNERSHIP: this file only. Engine sources are never edited — defects
 * found here are REPORTED, and the assertion documents the CURRENT behavior
 * with a `// SIM-FOUND BUG:` marker so the suite stays green and honest.
 */

import { describe, it, expect } from "vitest";
import {
  refundableRemaining,
  defaultClawback,
  clampClawback,
  planClawback,
  invoiceStatusAfter,
  type PayoutSnapshot,
} from "@/lib/refunds";
import { earlyFee, abaValid, accountPlausible } from "@/lib/payouts";
import { cancellationQuote, hoursUntilStart, type CancelDials } from "@/lib/cancellation";
import {
  decideDisputeOutcome,
  customerMayAnswer,
  respondByFrom,
  DISPUTE_ESCALATABLE_STATUSES,
  DISPUTE_ACCEPTABLE_STATUSES,
} from "@/lib/dispute-policy";
import { isLastDayOfMonth, nearMilestone, nudgeCooling } from "@/lib/growth";
import { withinSunset, customerReferralAccrual, crewShareAccrual, creditToApply } from "@/lib/referrals";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
const SEED = 0x1a4e11fe; // fixed; change only to widen coverage
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function next(): number {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const R2 = (n: number) => Math.round(n * 100) / 100;

/** Failure collector — keeps the loop running so one run reports everything. */
class Failures {
  readonly list: string[] = [];
  private counts = new Map<string, number>();
  add(kind: string, detail: string) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (this.list.length < 12) this.list.push(`[seed=${SEED}] ${kind}: ${detail}`);
  }
  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
  report(): string {
    if (!this.list.length) return "";
    const summary = [...this.counts.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
    return `\n  ${summary}\n  ` + this.list.join("\n  ");
  }
}

// ---------------------------------------------------------------------------
// Platform dials — mirror of DEFAULT_SETTINGS (src/lib/settings.ts is
// "server-only" so it cannot be imported here; the dials are DB values in
// production and are swept below anyway, which is the point of rule 8).
// ---------------------------------------------------------------------------
const DIALS = {
  marginFloor: 0.25,
  cancelFeePct: 0.25,
  cancelRoutineHours: 48,
  cancelWaterDays: 7,
  referralCustomerPct: 0.05,
  referralCrewSharePct: 0.25,
  referralCrewCap: 250,
  referralSunsetDays: 365,
  referralMaturationDays: 30,
  nudgeCreditThreshold: 50,
  nudgeCooldownDays: 30,
  earlyPayoutFeePct: 0.02,
  disputeAutoRefundMax: 150,
  disputeResponseHours: 24,
};

// ---------------------------------------------------------------------------
// Services — the REAL seed rows (supabase/seed/seed_services.sql). Pricing
// lives in data (rule 8), so the sim carries the data shape, not the numbers
// in code.
// ---------------------------------------------------------------------------
const SERVICES: Array<ServiceRule & { water: boolean; minPhotos: number }> = [
  { name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0, water: false, minPhotos: 3 },
  { name: "Fall winterization", pricing_model: "flat", base: 485, unit_rate: 0, water: false, minPhotos: 4 },
  { name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" }, water: true, minPhotos: 2 },
  { name: "Boat lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 }, water: true, minPhotos: 2 },
  { name: "Jet ski winterize & store", pricing_model: "per_section", base: 0, unit_rate: 350, band_pricing: { count_field: "jet_skis" }, water: true, minPhotos: 2 },
  { name: "PWC lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 165, band_pricing: { count_field: "pwc_lifts" }, water: true, minPhotos: 2 },
  { name: "Boat storage & winterize", pricing_model: "per_foot", base: 0, unit_rate: 50, water: true, minPhotos: 3 },
  { name: "Water toy prep & storage", pricing_model: "flat", base: 120, unit_rate: 0, band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] }, water: true, minPhotos: 1 },
  { name: "Lawn mowing & trim", pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 }, water: false, minPhotos: 1 },
  { name: "Housekeeping", pricing_model: "per_sqft_band", base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] }, water: false, minPhotos: 2 },
  // Winter storage seasonal minimum (0033_storage_seeds shape).
  { name: "Winter storage — outdoor", pricing_model: "seasonal_plus_perdiem", base: 350, unit_rate: 28, water: true, minPhotos: 3 },
  { name: "Winter storage — indoor", pricing_model: "seasonal_plus_perdiem", base: 650, unit_rate: 46, water: true, minPhotos: 3 },
];

// ---------------------------------------------------------------------------
// Date helpers (lake wall-clock ISO dates, same convention as the engine)
// ---------------------------------------------------------------------------
function isoAdd(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
const SLOTS: Array<string | null> = ["8a", "10a", "1p", "3p", null];

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------
interface Crew {
  id: string;
  /** share of menu price the crew charges LakeLife (margin = 1 − this) */
  rateFactor: number;
  capacity: number;
  lakes: number[];
  hasBank: boolean;
  /** every loose/batched/paid payout row this crew owns, across all jobs */
  rows: Array<{ id: string; jobId: string; kind: "earning" | "adjustment"; amount: number; status: string; batchId: string | null }>;
  everOwed: number; // sum of original_amount across earning rows
  clawed: number; // sum of every clawback taken from this crew
  cashOut: number; // gross of batches actually paid
  earlyFees: number; // early-pay fees LakeLife kept
}

interface Customer {
  id: string;
  isHoa: boolean;
  propertyIds: number[];
  referrerId: string | null;
  joinedISO: string;
  creditBalance: number;
  creditsGranted: number;
  creditsSpent: number;
  refundedDisputes: number; // trailing-year resolved_refunded count
  accruedFromReferrals: number;
}

interface Property {
  id: number;
  ownerId: string;
  lake: number;
  profile: PricingProfile;
}

function buildWorld(rng: () => number) {
  const crews: Crew[] = [];
  const nCrews = 10 + Math.floor(rng() * 31); // 10–40
  for (let i = 0; i < nCrews; i++) {
    crews.push({
      id: `crew_${i}`,
      // margin between the floor (25%) and 60% — dispatch guarantees ≥ floor
      rateFactor: R2(1 - (DIALS.marginFloor + rng() * 0.35)),
      capacity: 2 + Math.floor(rng() * 7),
      lakes: [Math.floor(rng() * 6), Math.floor(rng() * 6)],
      hasBank: rng() > 0.12,
      rows: [],
      everOwed: 0,
      clawed: 0,
      cashOut: 0,
      earlyFees: 0,
    });
  }

  const customers: Customer[] = [];
  const properties: Property[] = [];
  let propId = 0;
  const N_CUSTOMERS = 1000;
  for (let i = 0; i < N_CUSTOMERS; i++) {
    // ~1.4% of accounts are HOA-scale (a lake association booking 8–40 homes)
    const isHoa = rng() < 0.014;
    // Organic onboarding: after the first 60 accounts, ~45% arrive referred.
    const referrerId = i > 60 && rng() < 0.45 ? `cust_${Math.floor(rng() * i)}` : null;
    const nProps = isHoa ? 8 + Math.floor(rng() * 33) : 1 + (rng() < 0.08 ? 1 : 0);
    const ids: number[] = [];
    // lakes 0..2 in season one, 0..5 once the new lakes are born
    const lake = i < N_CUSTOMERS * 0.72 ? Math.floor(rng() * 3) : Math.floor(rng() * 6);
    for (let p = 0; p < nProps; p++) {
      const boats = Array.from({ length: Math.floor(rng() * 3) }, () => ({
        length_ft: 14 + Math.floor(rng() * 20),
        engine_type: rng() < 0.08 ? "none" : "outboard",
        engine_hp: 40 + Math.floor(rng() * 360),
        engines: rng() < 0.15 ? 2 : 1,
      }));
      properties.push({
        id: propId,
        ownerId: `cust_${i}`,
        lake,
        profile: {
          sqft: 900 + Math.floor(rng() * 4200),
          beds: 2 + Math.floor(rng() * 5),
          baths: 1 + Math.floor(rng() * 4),
          pier_sections: Math.floor(rng() * 9),
          boat_lifts: Math.floor(rng() * 3),
          toy_lifts: Math.floor(rng() * 3),
          jet_skis: Math.floor(rng() * 4),
          pwc_lifts: Math.floor(rng() * 3),
          lawn_band: (["small", "medium", "large"] as const)[Math.floor(rng() * 3)],
          boats,
          toys: Array.from({ length: Math.floor(rng() * 5) }, () => ({ name: "toy" })),
        },
      });
      ids.push(propId++);
    }
    customers.push({
      id: `cust_${i}`,
      isHoa,
      propertyIds: ids,
      referrerId,
      joinedISO: isoAdd("2026-03-01", Math.floor(rng() * 300)),
      creditBalance: 0,
      creditsGranted: 0,
      creditsSpent: 0,
      refundedDisputes: 0,
      accruedFromReferrals: 0,
    });
  }
  return { crews, customers, properties, byId: new Map(customers.map((c) => [c.id, c])) };
}

// ---------------------------------------------------------------------------
// THE REFUND EXECUTOR HARNESS
// Mirrors src/lib/refund-core.ts executeRefund() step for step — the ledger
// reads, the clawable band, planClawback and its application, the invoice
// flip. Every DECISION is the real engine's; only the row-storage is local.
// ---------------------------------------------------------------------------
interface JobLedger {
  jobId: string;
  crew: Crew;
  customerPrice: number; // jobs.customer_price at refund time
  vendorCost: number; // jobs.vendor_cost at refund time
  captured: number; // payments.amount where status='captured'
  creditApplied: number; // user_credits row against this invoice
  refunded: number; // Σ refunds.amount
  clawed: number; // Σ refunds.crew_clawback
  everOwed: number; // payouts.original_amount (immutable anchor)
  payoutRowId: string | null;
  invoiceStatus: "due" | "paid" | "refunded";
  refundCount: number;
  /** true once ops hand-set a clawback — the proportional default no longer
   *  owns the outcome, so default-basis metrics must exclude this job. */
  usedOverride: boolean;
}

function payoutSnapshotOf(j: JobLedger): PayoutSnapshot | null {
  if (!j.payoutRowId) return null;
  const row = j.crew.rows.find((r) => r.id === j.payoutRowId);
  if (!row) return null;
  return { id: row.id, amount: row.amount, status: row.status, batchId: row.batchId };
}

interface RefundOutcome {
  ok: boolean;
  reason?: string;
  amount?: number;
  clawback?: number;
  recovered?: number; // what the plan actually removed from the crew
}

/**
 * One refund, exactly as executeRefund() runs it. `override` mirrors the ops
 * modal's clawback field (null = the proportional default the policy engine
 * uses). Returns what moved so the caller can assert conservation.
 */
function executeRefundSim(j: JobLedger, rawAmount: number, override: number | null, f: Failures): RefundOutcome {
  const amount = R2(rawAmount);
  if (!(amount > 0)) return { ok: false, reason: "non_positive" };

  // refund-core: "Only $X is still refundable on this bill."
  const remaining = refundableRemaining(j.captured, j.refunded);
  if (amount > remaining) return { ok: false, reason: "over_refund_guard" };

  // refund-core: clawable = original_amount − already clawed, floored at 0.
  const clawable = Math.max(0, R2(j.everOwed - j.clawed));
  if (override != null) j.usedOverride = true;
  const clawback =
    override == null
      ? Math.min(clawable, defaultClawback(amount, j.customerPrice, j.vendorCost))
      : clampClawback(override, clawable);

  // ---- INVARIANT: a clawback can never exceed what the crew was ever owed
  if (R2(j.clawed + clawback) > R2(j.everOwed) + 1e-9) {
    f.add(
      "clawback_exceeds_ever_owed",
      `job=${j.jobId} everOwed=${j.everOwed} alreadyClawed=${j.clawed} thisClawback=${clawback} refund=${amount} price=${j.customerPrice} cost=${j.vendorCost}`,
    );
  }

  const snapshot = payoutSnapshotOf(j);
  const plan = planClawback(clawback, snapshot);

  // ---- Apply the plan the way refund-core applies it, and measure EXACTLY
  //      how much left the crew's side of the ledger.
  let reduction = 0;
  let adjustment = 0;
  switch (plan.mode) {
    case "none":
      break;
    case "adjust":
      adjustment = -plan.adjustmentAmount; // stored negative → magnitude
      j.crew.rows.push({ id: `adj_${j.jobId}_${j.refundCount}`, jobId: j.jobId, kind: "adjustment", amount: plan.adjustmentAmount, status: "released", batchId: null });
      break;
    case "reduce": {
      const row = j.crew.rows.find((r) => r.id === plan.payoutId)!;
      reduction = R2(row.amount - plan.newAmount);
      row.amount = plan.newAmount;
      row.status = plan.newStatus;
      break;
    }
    case "reduce_and_adjust": {
      const row = j.crew.rows.find((r) => r.id === plan.payoutId)!;
      reduction = R2(row.amount - plan.newAmount);
      row.amount = plan.newAmount;
      row.status = plan.newStatus;
      adjustment = -plan.adjustmentAmount;
      j.crew.rows.push({ id: `adj_${j.jobId}_${j.refundCount}`, jobId: j.jobId, kind: "adjustment", amount: plan.adjustmentAmount, status: "released", batchId: null });
      break;
    }
  }

  // ---- HEADLINE INVARIANT: the plan's pieces sum to EXACTLY the clawback.
  const recovered = R2(reduction + adjustment);
  if (recovered !== R2(clawback)) {
    f.add(
      "planClawback_not_conserved",
      `job=${j.jobId} mode=${plan.mode} clawback=${clawback} reduction=${reduction} adjustment=${adjustment} snapshot=${JSON.stringify(snapshot)}`,
    );
  }

  j.refunded = R2(j.refunded + amount);
  j.clawed = R2(j.clawed + clawback);
  j.refundCount++;

  // ---- INVARIANT: cumulative refunds never exceed captured cash.
  if (j.refunded > R2(j.captured) + 1e-9) {
    f.add("refunds_exceed_captured", `job=${j.jobId} captured=${j.captured} refundedTotal=${j.refunded} thisRefund=${amount}`);
  }

  // refund-core: the invoice flips only on a FULL refund.
  const status = invoiceStatusAfter(j.captured, j.refunded);
  const shouldBeRefunded = j.refunded >= j.captured;
  if ((status === "refunded") !== shouldBeRefunded) {
    f.add("invoice_flip_off", `job=${j.jobId} captured=${j.captured} refunded=${j.refunded} status=${status}`);
  }
  if (status === "refunded" && j.refunded < R2(j.captured)) {
    f.add("invoice_flipped_early", `job=${j.jobId} captured=${j.captured} refunded=${j.refunded}`);
  }
  j.invoiceStatus = status;

  return { ok: true, amount, clawback, recovered };
}

/** The crew-side identity: live rows must equal ever-owed minus ever-clawed. */
function crewLedgerNet(crew: Crew): number {
  return R2(crew.rows.reduce((s, r) => s + r.amount, 0));
}

/** Early-pay claim, exactly as src/app/vendor/bank-actions.ts runs it. */
function claimEarlyPayout(crew: Crew, batchId: string, f: Failures): { claimed: boolean; gross: number; fee: number; net: number } {
  if (!crew.hasBank) return { claimed: false, gross: 0, fee: 0, net: 0 };
  const loose = crew.rows.filter((r) => r.status === "released" && r.batchId == null);
  const gross = R2(loose.reduce((s, r) => s + r.amount, 0));
  if (loose.length === 0 || gross <= 0) return { claimed: false, gross, fee: 0, net: 0 };
  const { fee, net } = earlyFee(gross, DIALS.earlyPayoutFeePct);
  // ---- INVARIANT: an early payout never creates or destroys a cent.
  if (R2(fee + net) !== gross) f.add("earlyFee_not_conserved", `gross=${gross} fee=${fee} net=${net}`);
  if (fee < 0 || net < 0) f.add("earlyFee_negative", `gross=${gross} fee=${fee} net=${net}`);
  for (const r of loose) r.batchId = batchId;
  return { claimed: true, gross, fee, net };
}

// ===========================================================================
// SUITE 1 — TWO FULL SEASONS OF MONEY LIFECYCLES
// ===========================================================================
describe(`money ledger — two-season scale simulation (seed ${SEED})`, () => {
  it("runs ~1,000 customers × 2 seasons through the real refund/payout/cancel/dispute engines with no cent created or destroyed", () => {
    const rng = mulberry32(SEED);
    const f = new Failures();
    const world = buildWorld(rng);

    // Season telemetry — the human-touchpoint counters the owner asked for.
    const stats = {
      customers: world.customers.length,
      hoaAccounts: world.customers.filter((c) => c.isHoa).length,
      properties: world.properties.length,
      crews: world.crews.length,
      jobs: 0,
      cases: 0,
      completed: 0,
      cancelledFree: 0,
      cancelledFee: 0,
      cancelNotSelfServe: 0,
      refunds: 0,
      fullRefunds: 0,
      disputes: 0,
      disputesAutoRefunded: 0,
      disputesEscalated: 0,
      disputesNoCash: 0,
      adjustmentsStranded: 0,
      clawbackAfterBatch: 0,
      creditCoveredNoCash: 0,
      creditUnderClaw: 0,
      creditUnderClawDollars: 0,
      crewShareOverFee: 0,
      crewShareOverFeeDollars: 0,
      roundingResidueMax: 0,
      crewsPayingEarlyFeeOnClawedMoney: 0,
      referralAccruals: 0,
      fullRefundsOnReferredSpend: 0,
    };

    const SEASONS: Array<{ label: string; start: string; lakes: number }> = [
      { label: "2026", start: "2026-04-01", lakes: 3 },
      { label: "2027", start: "2027-04-01", lakes: 6 },
    ];

    let batchSeq = 0;

    for (const season of SEASONS) {
      // Each season, every property books a handful of services.
      for (const prop of world.properties) {
        if (prop.lake >= season.lakes) continue; // that lake isn't born yet
        const owner = world.byId.get(prop.ownerId)!;
        const nJobs = owner.isHoa ? 1 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 3);

        for (let k = 0; k < nJobs; k++) {
          const svc = SERVICES[Math.floor(rng() * SERVICES.length)];
          const crew = world.crews[Math.floor(rng() * world.crews.length)];
          const jobId = `job_${season.label}_${prop.id}_${k}`;
          stats.jobs++;

          // ---- PRICE: the real pricing engine against the real profile.
          let customerPrice = priceService(svc, prop.profile);
          if (customerPrice <= 0) continue;
          let vendorCost = R2(customerPrice * crew.rateFactor);

          // ---- REACHABLE BAD DATA: an owner-approved downward flag
          // correction reprices customer_price and PRESERVES vendor_cost
          // (src/app/approvals/actions.ts:72) with no margin-floor re-check.
          // ~4% of jobs — crews flag over-counted pier sections constantly.
          const repricedDown = rng() < 0.04;
          if (repricedDown) {
            customerPrice = Math.max(1, Math.round(customerPrice * (0.35 + rng() * 0.4)));
          }

          const jobDate = isoAdd(season.start, Math.floor(rng() * 180));
          const slot = SLOTS[Math.floor(rng() * SLOTS.length)];

          // =================================================================
          // BRANCH A — CANCELLATION (self-serve, policy-priced)
          // =================================================================
          if (rng() < 0.14) {
            const daysOut = Math.floor(rng() * 16); // 0 = day-of → "call us"
            const nowDate = isoAdd(jobDate, -daysOut);
            const nowMinutes = Math.floor(rng() * 1440);
            const dials: CancelDials = {
              cancelFeePct: DIALS.cancelFeePct,
              cancelRoutineHours: DIALS.cancelRoutineHours,
              cancelWaterDays: DIALS.cancelWaterDays,
            };
            const status = rng() < 0.2 ? "requested" : "scheduled";
            const hasCrew = status === "scheduled" ? rng() > 0.03 : rng() < 0.5;
            const q = cancellationQuote(
              { status, hasCrew, isWaterWork: svc.water, jobDateISO: jobDate, slot, nowDateISO: nowDate, nowMinutes, customerPrice, vendorCost },
              dials,
            );
            stats.cases++;

            // ---- INVARIANT: a cancellation fee never exceeds the job price.
            if (q.fee > R2(customerPrice) + 1e-9) {
              f.add("cancel_fee_exceeds_price", `job=${jobId} price=${customerPrice} fee=${q.fee} pct=${q.feePct}`);
            }
            if (q.free && q.fee !== 0) f.add("free_cancel_charged", `job=${jobId} fee=${q.fee} reason=${q.reason}`);
            if (!q.allowed && q.fee !== 0) f.add("blocked_cancel_charged", `job=${jobId} fee=${q.fee}`);
            if (q.crewShare < 0 || q.fee < 0) f.add("negative_cancel_money", `job=${jobId} fee=${q.fee} crewShare=${q.crewShare}`);
            // Outside-window free cancels must genuinely be outside the window.
            if (q.reason === "outside_window") {
              const hrs = hoursUntilStart(jobDate, slot, nowDate, nowMinutes);
              const win = svc.water ? dials.cancelWaterDays * 24 : dials.cancelRoutineHours;
              if (hrs < win) f.add("outside_window_but_inside", `job=${jobId} hours=${hrs} window=${win}`);
            }
            // SIM-FOUND BUG (see report): crewShare is NOT clamped to the fee.
            if (q.crewShare > q.fee + 1e-9) {
              stats.crewShareOverFee++;
              stats.crewShareOverFeeDollars = R2(stats.crewShareOverFeeDollars + (q.crewShare - q.fee));
              if (vendorCost <= customerPrice) {
                f.add("crewShare_over_fee_without_bad_cost", `job=${jobId} price=${customerPrice} cost=${vendorCost} fee=${q.fee} crewShare=${q.crewShare}`);
              }
            }

            if (!q.allowed) {
              stats.cancelNotSelfServe++; // → the customer must call a human
              continue;
            }
            if (q.free || q.fee <= 0) {
              stats.cancelledFree++;
              continue;
            }

            // FEE PATH (src/app/requests/actions.ts): invoice = fee, charge it,
            // and the crew's earning is born at the FEE SHARE, never cost.
            stats.cancelledFee++;
            const chargeOk = rng() > 0.06;
            if (!chargeOk) continue; // invoice sits 'due', no payout — nothing to conserve
            const rowId = `po_${jobId}`;
            crew.rows.push({ id: rowId, jobId, kind: "earning", amount: q.crewShare, status: "released", batchId: null });
            crew.everOwed = R2(crew.everOwed + q.crewShare);
            const ledger: JobLedger = {
              jobId, crew, customerPrice, vendorCost, captured: q.fee, creditApplied: 0,
              refunded: 0, clawed: 0, everOwed: q.crewShare, payoutRowId: rowId,
              invoiceStatus: "paid", refundCount: 0, usedOverride: false,
            };
            // Ops sometimes waives a late fee after a phone call — a refund on
            // a fee invoice, the trickiest clawback basis in the system.
            if (rng() < 0.25) {
              const r = executeRefundSim(ledger, ledger.captured, null, f);
              if (r.ok) {
                stats.refunds++;
                crew.clawed = R2(crew.clawed + (r.clawback ?? 0));
                if (ledger.invoiceStatus === "refunded") stats.fullRefunds++;
                // A fully-waived fee must claw the crew's whole fee share back.
                if (ledger.invoiceStatus === "refunded" && R2(ledger.clawed) < R2(ledger.everOwed) - 0.02 && vendorCost <= customerPrice) {
                  f.add("fee_waiver_underclaw", `job=${jobId} fee=${q.fee} crewShare=${q.crewShare} clawed=${ledger.clawed}`);
                }
              }
            }
            checkCrewIdentity(crew, f);
            continue;
          }

          // =================================================================
          // BRANCH B — COMPLETED JOB → payout, invoice, charge, then money
          // =================================================================
          stats.completed++;
          stats.cases++;

          // Referral credits (§8b) shrink the CASH captured, never the price.
          const creditApplied = owner.creditBalance > 0 ? creditToApply(owner.creditBalance, customerPrice) : 0;
          if (creditApplied > R2(Math.min(owner.creditBalance, customerPrice)) + 1e-9) {
            f.add("credit_over_applied", `owner=${owner.id} balance=${owner.creditBalance} price=${customerPrice} applied=${creditApplied}`);
          }
          owner.creditBalance = R2(owner.creditBalance - creditApplied);
          owner.creditsSpent = R2(owner.creditsSpent + creditApplied);
          if (owner.creditBalance < -1e-9) f.add("credit_balance_negative", `owner=${owner.id} balance=${owner.creditBalance}`);

          const cashDue = R2(customerPrice - creditApplied);

          // settleJob(): the payout row is born FIRST, with original_amount as
          // the immutable "ever owed" anchor.
          const openDispute = rng() < 0.06;
          const rowId = `po_${jobId}`;
          crew.rows.push({ id: rowId, jobId, kind: "earning", amount: vendorCost, status: openDispute ? "held" : "released", batchId: null });
          crew.everOwed = R2(crew.everOwed + vendorCost);

          const chargeOk = !openDispute && rng() > 0.05;
          const captured = cashDue <= 0 ? 0 : chargeOk ? cashDue : 0;
          if (cashDue <= 0 && creditApplied > 0) stats.creditCoveredNoCash++;

          const ledger: JobLedger = {
            jobId, crew, customerPrice, vendorCost, captured, creditApplied,
            refunded: 0, clawed: 0, everOwed: vendorCost, payoutRowId: rowId,
            invoiceStatus: captured > 0 ? "paid" : "due", refundCount: 0, usedOverride: false,
          };

          // Referral commission accrues on COLLECTED money only.
          if (captured > 0 && owner.referrerId) {
            const referrer = world.byId.get(owner.referrerId);
            if (referrer && withinSunset(owner.joinedISO, Date.parse(jobDate + "T12:00:00Z"), DIALS.referralSunsetDays)) {
              const accrual = customerReferralAccrual(captured, DIALS.referralCustomerPct);
              if (accrual > R2(captured * 0.5) + 1e-9) f.add("referral_accrual_over_half", `collected=${captured} accrual=${accrual}`);
              referrer.accruedFromReferrals = R2(referrer.accruedFromReferrals + accrual);
              // Maturation: spendable after the clawback window (dial).
              referrer.creditBalance = R2(referrer.creditBalance + accrual);
              referrer.creditsGranted = R2(referrer.creditsGranted + accrual);
              stats.referralAccruals++;
            }
          }

          // ---------------- DISPUTE (Make-It-Right ladder) ----------------
          let disputeAutoRefund = 0;
          if (rng() < 0.09) {
            stats.disputes++;
            // The crew's turn first: fix / verify / talk — or silence.
            const crewMove = (["fixing", "verifying", "talk", "crew_review"] as const)[Math.floor(rng() * 4)];
            const answer: "resolved" | "still" = rng() < 0.55 ? "still" : "resolved";
            const mayAnswer = customerMayAnswer(crewMove, answer);

            // ---- INVARIANT: 'still' can never act before the crew responded.
            if (answer === "still" && mayAnswer && crewMove === "crew_review") {
              f.add("escalate_before_crew_response", `job=${jobId} status=${crewMove}`);
            }
            if (answer === "still" && mayAnswer && !DISPUTE_ESCALATABLE_STATUSES.includes(crewMove as never)) {
              f.add("escalate_from_non_escalatable", `job=${jobId} status=${crewMove}`);
            }
            if (answer === "resolved" && mayAnswer && !DISPUTE_ACCEPTABLE_STATUSES.includes(crewMove as never)) {
              f.add("accept_from_non_acceptable", `job=${jobId} status=${crewMove}`);
            }

            if (answer === "still" && mayAnswer) {
              const decision = decideDisputeOutcome({
                capturedCash: ledger.captured,
                customerPrice,
                autoRefundMax: DIALS.disputeAutoRefundMax,
                priorDisputesByCustomer: owner.refundedDisputes,
              });
              // ---- INVARIANTS on the auto-refund gate.
              if (decision === "auto_refund") {
                if (!(ledger.captured > 0)) f.add("auto_refund_no_cash", `job=${jobId} captured=${ledger.captured}`);
                if (customerPrice > DIALS.disputeAutoRefundMax) f.add("auto_refund_over_dial", `job=${jobId} price=${customerPrice} dial=${DIALS.disputeAutoRefundMax}`);
                if (owner.refundedDisputes >= 2) f.add("auto_refund_repeat_refunder", `job=${jobId} priors=${owner.refundedDisputes}`);

                // firePolicy: release the hold FIRST so the reduce path sees a
                // loose row, then refund the whole remaining cash.
                const row = crew.rows.find((r) => r.id === rowId)!;
                if (row.status === "held") row.status = "released";
                const amount = refundableRemaining(ledger.captured, ledger.refunded);
                if (amount > DIALS.disputeAutoRefundMax + 1e-9) {
                  f.add("auto_refund_amount_over_dial", `job=${jobId} amount=${amount} dial=${DIALS.disputeAutoRefundMax}`);
                }
                if (amount > 0) {
                  const r = executeRefundSim(ledger, amount, null, f);
                  if (r.ok) {
                    stats.refunds++;
                    stats.disputesAutoRefunded++;
                    disputeAutoRefund = r.amount ?? 0;
                    crew.clawed = R2(crew.clawed + (r.clawback ?? 0));
                    owner.refundedDisputes++;
                    if (ledger.invoiceStatus === "refunded") stats.fullRefunds++;
                  }
                }
              } else {
                stats.disputesEscalated++; // → a human decides
                if (!(ledger.captured > 0)) stats.disputesNoCash++;
              }
            }
            if (respondByFrom(Date.parse(jobDate + "T12:00:00Z"), DIALS.disputeResponseHours).length < 20) {
              f.add("respond_by_malformed", `job=${jobId}`);
            }
          }

          // ---------------- INTERLEAVED PAYOUT LIFECYCLE + REFUNDS ---------
          // The crew claims early pay, batches settle, ops refunds land — in
          // whatever order the season deals them.
          const steps = 1 + Math.floor(rng() * 5);
          for (let s = 0; s < steps && ledger.captured > 0; s++) {
            const roll = rng();

            if (roll < 0.22) {
              // Crew pulls their money early ("get it now").
              const bid = `batch_${batchSeq++}`;
              const res = claimEarlyPayout(crew, bid, f);
              if (res.claimed) {
                for (const r of crew.rows) if (r.batchId === bid) r.status = "paid";
                crew.cashOut = R2(crew.cashOut + res.gross);
                crew.earlyFees = R2(crew.earlyFees + res.fee);
              }
              continue;
            }
            if (roll < 0.28) {
              // Month-end batch (free) sweeps whatever is loose.
              const bid = `mbatch_${batchSeq++}`;
              const loose = crew.rows.filter((r) => r.status === "released" && r.batchId == null);
              const gross = R2(loose.reduce((a, r) => a + r.amount, 0));
              if (gross > 0) {
                for (const r of loose) { r.batchId = bid; r.status = "paid"; }
                crew.cashOut = R2(crew.cashOut + gross);
              }
              continue;
            }
            if (roll < 0.33) {
              // A dispute freezes the crew's pay mid-stream.
              const row = crew.rows.find((r) => r.id === rowId);
              if (row && row.status === "released" && row.batchId == null) row.status = "held";
              continue;
            }

            // A refund: partial, full, ops-override, or goodwill (zero claw).
            const before = payoutSnapshotOf(ledger);
            const remaining = refundableRemaining(ledger.captured, ledger.refunded);
            if (remaining <= 0) break;
            const full = rng() < 0.3;
            const amount = full ? remaining : R2(Math.max(0.01, remaining * (0.05 + rng() * 0.6)));
            let override: number | null = null;
            const mode = rng();
            if (mode < 0.15) override = 0; // goodwill refund, crew keeps their pay
            else if (mode < 0.3) override = R2(ledger.vendorCost * (0.5 + rng())); // crew-fault, ops claws hard
            else if (mode < 0.36) override = -50; // fat-fingered negative
            else if (mode < 0.4) override = Number.NaN; // empty field

            const r = executeRefundSim(ledger, amount, override, f);
            if (!r.ok) continue;
            stats.refunds++;
            crew.clawed = R2(crew.clawed + (r.clawback ?? 0));
            if (before && before.batchId != null && (r.clawback ?? 0) > 0) stats.clawbackAfterBatch++;
            if (ledger.invoiceStatus === "refunded") {
              stats.fullRefunds++;
              // Referral unwind: refund-core voids only 'accrued' rows — a
              // matured/credited accrual survives a full refund.
              if (owner.referrerId) stats.fullRefundsOnReferredSpend++;
            }
            checkCrewIdentity(crew, f);
          }

          // ---- SIM-FOUND BUG (see report): a FULLY refunded invoice whose
          // cash was shrunk by credits under-claws the crew, because the
          // proportional default is computed against the full customer_price
          // while the refund can only ever be the cash. Assert the CURRENT
          // behavior so the defect is documented, not hidden.
          if (ledger.invoiceStatus === "refunded" && !ledger.usedOverride && ledger.creditApplied > 0 && ledger.everOwed > 0) {
            const shortfall = R2(ledger.everOwed - ledger.clawed);
            if (shortfall > 0.02) {
              stats.creditUnderClaw++;
              stats.creditUnderClawDollars = R2(stats.creditUnderClawDollars + shortfall);
            }
          }

          // Residual rounding drift on multi-refund jobs (crew-favourable only).
          if (ledger.invoiceStatus === "refunded" && !ledger.usedOverride && ledger.creditApplied === 0 && ledger.refundCount > 1) {
            const drift = R2(ledger.everOwed - ledger.clawed);
            if (drift > stats.roundingResidueMax) stats.roundingResidueMax = drift;
          }

          checkCrewIdentity(crew, f);
          if (disputeAutoRefund > ledger.captured + 1e-9) {
            f.add("dispute_refund_over_captured", `job=${jobId} refund=${disputeAutoRefund} captured=${ledger.captured}`);
          }
        }
      }

      // Season close-out: month-end batch every crew, and check the books.
      for (const crew of world.crews) {
        const loose = crew.rows.filter((r) => r.status === "released" && r.batchId == null);
        const gross = R2(loose.reduce((a, r) => a + r.amount, 0));
        if (gross > 0) {
          const bid = `season_${season.label}_${crew.id}`;
          for (const r of loose) { r.batchId = bid; r.status = "paid"; }
          crew.cashOut = R2(crew.cashOut + gross);
        } else if (gross < 0) {
          // Negative net: bank-actions refuses the claim and the adjustment
          // rows sit there waiting for future work to net against.
          stats.adjustmentsStranded++;
        }
      }
    }

    // ---- WHOLE-WORLD CONSERVATION -----------------------------------------
    for (const crew of world.crews) {
      const net = crewLedgerNet(crew);
      const expected = R2(crew.everOwed - crew.clawed);
      if (net !== expected) {
        f.add("crew_ledger_broken", `crew=${crew.id} rowsNet=${net} everOwed=${crew.everOwed} clawed=${crew.clawed} expected=${expected}`);
      }
      if (crew.clawed > crew.everOwed + 1e-9) {
        f.add("crew_clawed_more_than_owed", `crew=${crew.id} clawed=${crew.clawed} everOwed=${crew.everOwed}`);
      }
      if (crew.earlyFees > 0 && crew.clawed > 0) stats.crewsPayingEarlyFeeOnClawedMoney++;
      if (crew.earlyFees > R2(crew.cashOut * DIALS.earlyPayoutFeePct) + 0.05) {
        f.add("early_fees_over_rate", `crew=${crew.id} fees=${crew.earlyFees} cashOut=${crew.cashOut}`);
      }
    }
    for (const c of world.customers) {
      if (c.creditBalance < -1e-9) f.add("customer_credit_negative", `cust=${c.id} balance=${c.creditBalance}`);
      if (R2(c.creditsSpent) > R2(c.creditsGranted) + 1e-9) {
        f.add("credits_spent_over_granted", `cust=${c.id} spent=${c.creditsSpent} granted=${c.creditsGranted}`);
      }
    }

    // Telemetry for the report (visible with --reporter=verbose / on failure).
    (globalThis as Record<string, unknown>).__LAKELIFE_MONEY_SIM__ = stats;
    if (process.env.SIM_TELEMETRY) console.log("SIM STATS", JSON.stringify(stats, null, 1));

    expect(stats.cases).toBeGreaterThan(2000);
    expect(stats.refunds).toBeGreaterThan(500);
    expect(f.total, `money-conservation violations across ${stats.cases} simulated cases${f.report()}`).toBe(0);

    // SIM-FOUND BUG #1 (cancellation.ts): the crew's slot-hold share is not
    // clamped to the fee the customer actually pays. Reachable whenever an
    // owner-approved downward flag correction drops customer_price below the
    // preserved vendor_cost (approvals/actions.ts re-derives margin with no
    // floor re-check). Asserting the CURRENT behavior so the suite stays green.
    expect(stats.crewShareOverFee).toBeGreaterThan(0);

    // SIM-FOUND BUG #2 (refund-core.ts:76 / refunds.ts defaultClawback basis):
    // a credit-covered invoice that reaches status 'refunded' leaves part of
    // the crew's pay un-clawed, because the proportional default is taken
    // against customer_price while only the CASH can ever be refunded.
    expect(stats.creditUnderClaw).toBeGreaterThan(0);
  });
});

/** The crew-side conservation identity, checked after every money move. */
function checkCrewIdentity(crew: Crew, f: Failures) {
  const net = crewLedgerNet(crew);
  const expected = R2(crew.everOwed - crew.clawed);
  if (net !== expected) {
    f.add("crew_ledger_broken_midstream", `crew=${crew.id} rowsNet=${net} everOwed=${crew.everOwed} clawed=${crew.clawed}`);
  }
}

// ===========================================================================
// SUITE 2 — planClawback CONSERVATION UNDER EVERY PAYOUT STATE
// ===========================================================================
describe(`planClawback — exhaustive conservation sweep (seed ${SEED})`, () => {
  it("the in-place reduction plus the adjustment sum to EXACTLY the clawback, in every payout state including 'held'", () => {
    const rng = mulberry32(SEED ^ 0x5eed);
    const f = new Failures();
    const STATES = ["released", "held", "paid", "clawed", "pending", "void"];
    let cases = 0;

    for (let i = 0; i < 30000; i++) {
      const clawback = R2(rng() * 900);
      const amount = R2(rng() * 900);
      const status = STATES[Math.floor(rng() * STATES.length)];
      const batchId = rng() < 0.35 ? `b_${i}` : null;
      const snap: PayoutSnapshot | null = rng() < 0.06 ? null : { id: `po_${i}`, amount, status, batchId };
      const plan = planClawback(clawback, snap);
      cases++;

      let reduction = 0;
      let adjustment = 0;
      switch (plan.mode) {
        case "none":
          if (clawback > 0) f.add("none_for_positive_clawback", `clawback=${clawback} snap=${JSON.stringify(snap)}`);
          break;
        case "adjust":
          adjustment = -plan.adjustmentAmount;
          if (plan.adjustmentAmount > 0) f.add("adjustment_positive", `plan=${JSON.stringify(plan)}`);
          break;
        case "reduce":
          reduction = R2((snap as PayoutSnapshot).amount - plan.newAmount);
          if (plan.newAmount < 0) f.add("reduce_negative_amount", `plan=${JSON.stringify(plan)} snap=${JSON.stringify(snap)}`);
          if (plan.newAmount > 0 && plan.newStatus === "clawed") f.add("clawed_with_money_left", `plan=${JSON.stringify(plan)}`);
          if (plan.newAmount === 0 && plan.newStatus !== "clawed") f.add("zeroed_but_not_clawed", `plan=${JSON.stringify(plan)}`);
          // A held remainder must STAY held — the dispute owns its release.
          if (plan.newAmount > 0 && (snap as PayoutSnapshot).status === "held" && plan.newStatus !== "held") {
            f.add("held_remainder_unheld", `plan=${JSON.stringify(plan)}`);
          }
          break;
        case "reduce_and_adjust":
          reduction = R2((snap as PayoutSnapshot).amount - plan.newAmount);
          adjustment = -plan.adjustmentAmount;
          break;
      }

      const recovered = R2(reduction + adjustment);
      const expected = clawback > 0 ? R2(clawback) : 0;
      if (recovered !== expected) {
        f.add(
          "not_conserved",
          `clawback=${clawback} snap=${JSON.stringify(snap)} plan=${JSON.stringify(plan)} reduction=${reduction} adjustment=${adjustment}`,
        );
      }
      // Never touch a batched or non-loose row in place.
      if ((plan.mode === "reduce" || plan.mode === "reduce_and_adjust") && snap) {
        if (snap.batchId != null) f.add("reduced_a_batched_row", `snap=${JSON.stringify(snap)}`);
        if (snap.status !== "released" && snap.status !== "held") f.add("reduced_a_frozen_row", `snap=${JSON.stringify(snap)}`);
      }
    }

    expect(cases).toBe(30000);
    expect(f.total, `planClawback conservation${f.report()}`).toBe(0);
  });

  it("survives a long sequence of clawbacks against ONE payout without creating or destroying a cent", () => {
    const rng = mulberry32(SEED ^ 0xc1a3);
    const f = new Failures();
    let sequences = 0;

    for (let i = 0; i < 4000; i++) {
      const everOwed = R2(20 + rng() * 900);
      const row = { id: `po_${i}`, amount: everOwed, status: "released", batchId: null as string | null };
      const adjustments: number[] = [];
      let clawedTotal = 0;
      const n = 2 + Math.floor(rng() * 12);

      for (let k = 0; k < n; k++) {
        // Interleave the real-world state changes between clawbacks.
        const churn = rng();
        if (churn < 0.15) row.batchId = `b_${i}_${k}`;
        else if (churn < 0.25) row.status = "held";
        else if (churn < 0.3) row.status = "paid";
        else if (churn < 0.35 && row.batchId == null) row.status = "released";

        const clawable = Math.max(0, R2(everOwed - clawedTotal));
        const want = R2(rng() * everOwed * 0.5);
        const clawback = clampClawback(want, clawable);
        const snap: PayoutSnapshot = { id: row.id, amount: row.amount, status: row.status, batchId: row.batchId };
        const plan = planClawback(clawback, snap);

        let reduction = 0;
        let adjustment = 0;
        if (plan.mode === "adjust") { adjustment = -plan.adjustmentAmount; adjustments.push(plan.adjustmentAmount); }
        else if (plan.mode === "reduce") { reduction = R2(row.amount - plan.newAmount); row.amount = plan.newAmount; row.status = plan.newStatus; }
        else if (plan.mode === "reduce_and_adjust") {
          reduction = R2(row.amount - plan.newAmount);
          row.amount = plan.newAmount; row.status = plan.newStatus;
          adjustment = -plan.adjustmentAmount; adjustments.push(plan.adjustmentAmount);
        }
        if (R2(reduction + adjustment) !== R2(clawback)) {
          f.add("sequence_step_not_conserved", `i=${i} k=${k} clawback=${clawback} reduction=${reduction} adjustment=${adjustment} plan=${JSON.stringify(plan)}`);
        }
        clawedTotal = R2(clawedTotal + clawback);

        const net = R2(row.amount + adjustments.reduce((a, b) => a + b, 0));
        if (net !== R2(everOwed - clawedTotal)) {
          f.add("sequence_ledger_drift", `i=${i} k=${k} net=${net} everOwed=${everOwed} clawed=${clawedTotal}`);
        }
        if (clawedTotal > everOwed + 1e-9) {
          f.add("sequence_over_clawed", `i=${i} clawed=${clawedTotal} everOwed=${everOwed}`);
        }
      }
      sequences++;
    }

    expect(sequences).toBe(4000);
    expect(f.total, `clawback sequence conservation${f.report()}`).toBe(0);
  });
});

// ===========================================================================
// SUITE 3 — MANY SMALL REFUNDS: ROUNDING
// ===========================================================================
describe(`refund sequences — accumulated rounding (seed ${SEED})`, () => {
  it("40-step drip refunds never over-refund captured cash and never over-claw the crew", () => {
    const rng = mulberry32(SEED ^ 0xd21b);
    const f = new Failures();
    let worstUnderClaw = 0;
    let worstOverClaw = 0;
    let cases = 0;

    for (let i = 0; i < 6000; i++) {
      const price = R2(40 + rng() * 1400);
      const cost = R2(price * (0.4 + rng() * 0.35));
      const captured = price;
      const everOwed = cost;
      let refunded = 0;
      let clawed = 0;
      const steps = 8 + Math.floor(rng() * 34);

      for (let k = 0; k < steps; k++) {
        const remaining = refundableRemaining(captured, refunded);
        if (remaining <= 0) break;
        // Tiny drips — the classic place a cent gets minted.
        const amount = k === steps - 1 ? remaining : R2(Math.min(remaining, Math.max(0.01, rng() * 3)));
        if (!(amount > 0)) continue;
        if (amount > remaining) { f.add("drip_over_remaining", `i=${i} amount=${amount} remaining=${remaining}`); break; }
        const clawable = Math.max(0, R2(everOwed - clawed));
        const claw = Math.min(clawable, defaultClawback(amount, price, cost));
        refunded = R2(refunded + amount);
        clawed = R2(clawed + claw);
        if (refunded > captured + 1e-9) f.add("drip_refunds_exceed_captured", `i=${i} refunded=${refunded} captured=${captured}`);
        if (clawed > everOwed + 1e-9) f.add("drip_clawed_exceeds_owed", `i=${i} clawed=${clawed} everOwed=${everOwed}`);
        if (invoiceStatusAfter(captured, refunded) === "refunded" && refunded < captured) {
          f.add("drip_flipped_early", `i=${i} refunded=${refunded} captured=${captured}`);
        }
      }
      cases++;
      if (R2(refunded) === R2(captured)) {
        const residue = R2(everOwed - clawed);
        if (residue > worstUnderClaw) worstUnderClaw = residue;
        if (residue < worstOverClaw) worstOverClaw = residue;
        if (invoiceStatusAfter(captured, refunded) !== "refunded") {
          f.add("full_refund_not_flipped", `i=${i} refunded=${refunded} captured=${captured}`);
        }
      }
    }

    expect(cases).toBe(6000);
    expect(f.total, `drip-refund rounding${f.report()}`).toBe(0);
    // The crew is never over-clawed by rounding; the residue always lands in
    // the crew's favour and stays inside a couple of cents even at 40 steps.
    expect(worstOverClaw).toBe(0);
    expect(worstUnderClaw).toBeLessThanOrEqual(0.25);
  });
});

// ===========================================================================
// SUITE 4 — CANCELLATION FEE POLICY
// ===========================================================================
describe(`cancellation fee policy — dial sweep (seed ${SEED})`, () => {
  it("a fee never exceeds the job price at any dial, and free always means free", () => {
    const rng = mulberry32(SEED ^ 0xca4c);
    const f = new Failures();
    let cases = 0;
    let overFeeCrewShare = 0;
    let notSelfServe = 0;

    const PCTS = [0, 0.1, 0.25, 0.4, 0.75, 1];
    for (const pct of PCTS) {
      for (let i = 0; i < 4000; i++) {
        const dials: CancelDials = {
          cancelFeePct: pct,
          cancelRoutineHours: [0, 24, 48, 72, 336][Math.floor(rng() * 5)],
          cancelWaterDays: [0, 3, 7, 14, 60][Math.floor(rng() * 5)],
        };
        const price = R2(35 + rng() * 2000);
        // Honest crews clear the margin floor; a repriced-down job does not.
        const cost = rng() < 0.08 ? R2(price * (1.05 + rng())) : R2(price * (0.4 + rng() * 0.35));
        const water = rng() < 0.5;
        const jobDate = isoAdd("2026-05-01", Math.floor(rng() * 400));
        const nowDate = isoAdd(jobDate, -Math.floor(rng() * 25));
        const nowMinutes = Math.floor(rng() * 1440);
        const status = (["requested", "scheduled", "in_progress", "complete", "cancelled"] as const)[Math.floor(rng() * 5)];
        const q = cancellationQuote(
          {
            status, hasCrew: rng() > 0.05, isWaterWork: water, jobDateISO: jobDate,
            slot: SLOTS[Math.floor(rng() * SLOTS.length)], nowDateISO: nowDate, nowMinutes,
            customerPrice: price, vendorCost: rng() < 0.04 ? null : cost,
          },
          dials,
        );
        cases++;

        if (q.fee > R2(price) + 1e-9) f.add("fee_over_price", `price=${price} fee=${q.fee} pct=${pct}`);
        if (q.fee < 0 || q.crewShare < 0) f.add("negative_money", `fee=${q.fee} crewShare=${q.crewShare}`);
        if (q.free && (q.fee !== 0 || q.crewShare !== 0)) f.add("free_but_charged", `reason=${q.reason} fee=${q.fee}`);
        if (!q.allowed) {
          notSelfServe++;
          if (q.fee !== 0) f.add("blocked_but_charged", `reason=${q.reason} fee=${q.fee}`);
        }
        if (q.reason === "inside_window" && !(q.fee > 0)) f.add("inside_window_zero_fee", `pct=${pct} price=${price}`);
        if (q.crewShare > q.fee + 1e-9) {
          overFeeCrewShare++;
          // SIM-FOUND BUG #1: only ever happens when vendor_cost > price.
          if (cost <= price) f.add("crewShare_over_fee_with_sane_cost", `price=${price} cost=${cost} fee=${q.fee} crewShare=${q.crewShare}`);
        }
        // Day-of and in-progress are never self-serve (the "call us" rail).
        if (q.allowed && status !== "requested" && status !== "scheduled") {
          f.add("self_serve_on_terminal_status", `status=${status}`);
        }
      }
    }

    expect(cases).toBe(24000);
    expect(notSelfServe).toBeGreaterThan(0);
    expect(f.total, `cancellation policy${f.report()}`).toBe(0);
    // SIM-FOUND BUG #1 — documented, not hidden: crewShare is unclamped.
    expect(overFeeCrewShare).toBeGreaterThan(0);
  });

  it("hoursUntilStart is monotone and slot-aware, so the free/fee boundary can't flap", () => {
    const rng = mulberry32(SEED ^ 0x40c2);
    const f = new Failures();
    for (let i = 0; i < 8000; i++) {
      const jobDate = isoAdd("2026-04-15", Math.floor(rng() * 500));
      const days = Math.floor(rng() * 20);
      const nowDate = isoAdd(jobDate, -days);
      const m1 = Math.floor(rng() * 1439);
      const slot = SLOTS[Math.floor(rng() * SLOTS.length)];
      const a = hoursUntilStart(jobDate, slot, nowDate, m1);
      const b = hoursUntilStart(jobDate, slot, nowDate, m1 + 1);
      if (!(b < a)) f.add("time_not_monotone", `job=${jobDate} now=${nowDate} m=${m1} a=${a} b=${b}`);
      if (Math.abs(a - b - 1 / 60) > 1e-6) f.add("minute_not_a_minute", `a=${a} b=${b}`);
      const earlier = hoursUntilStart(jobDate, slot, isoAdd(nowDate, -1), m1);
      if (Math.abs(earlier - a - 24) > 1e-6) f.add("day_not_24h", `a=${a} earlier=${earlier}`);
    }
    expect(f.total, `hoursUntilStart${f.report()}`).toBe(0);
  });
});

// ===========================================================================
// SUITE 5 — DISPUTE POLICY
// ===========================================================================
describe(`dispute policy — auto-refund gate (seed ${SEED})`, () => {
  it("never auto-refunds with zero captured cash, never above the dial, never for a repeat refunder", () => {
    const rng = mulberry32(SEED ^ 0xd15b);
    const f = new Failures();
    let autos = 0;
    let escalations = 0;

    for (let i = 0; i < 40000; i++) {
      const customerPrice = R2(rng() < 0.05 ? 0 : rng() * 1600);
      const creditCovered = rng() < 0.15;
      const chargeFailed = rng() < 0.12;
      const capturedCash = creditCovered || chargeFailed ? 0 : R2(customerPrice * (rng() < 0.85 ? 1 : 0.4));
      const autoRefundMax = [0, 50, 150, 400, 2000][Math.floor(rng() * 5)];
      const priors = Math.floor(rng() * 5);

      const d = decideDisputeOutcome({ capturedCash, customerPrice, autoRefundMax, priorDisputesByCustomer: priors });
      if (d === "auto_refund") {
        autos++;
        if (!(capturedCash > 0)) f.add("auto_with_no_cash", `captured=${capturedCash}`);
        if (customerPrice > autoRefundMax) f.add("auto_over_dial", `price=${customerPrice} dial=${autoRefundMax}`);
        if (priors >= 2) f.add("auto_for_repeat_refunder", `priors=${priors}`);
        // The money it would move is the remaining cash — bounded by the dial.
        const amount = refundableRemaining(capturedCash, 0);
        if (amount > autoRefundMax + 1e-9) f.add("auto_amount_over_dial", `amount=${amount} dial=${autoRefundMax}`);
        if (amount > capturedCash + 1e-9) f.add("auto_amount_over_captured", `amount=${amount} captured=${capturedCash}`);
      } else {
        escalations++;
      }
    }

    expect(autos).toBeGreaterThan(1000);
    expect(escalations).toBeGreaterThan(1000);
    expect(f.total, `dispute auto-refund gate${f.report()}`).toBe(0);
  });

  it("'still not right' can never act before the crew has had its turn", () => {
    const f = new Failures();
    const ALL = ["crew_review", "fixing", "verifying", "talk", "escalated", "resolved_verified", "resolved_fixed", "resolved_closed", "resolved_refunded", "", "STILL", "open"];
    for (const s of ALL) {
      if (customerMayAnswer(s, "still") && s === "crew_review") f.add("escalate_pre_response", `status=${s}`);
      if (customerMayAnswer(s, "still") && !(DISPUTE_ESCALATABLE_STATUSES as readonly string[]).includes(s)) {
        f.add("escalate_outside_list", `status=${s}`);
      }
      if (customerMayAnswer(s, "resolved") && !(DISPUTE_ACCEPTABLE_STATUSES as readonly string[]).includes(s)) {
        f.add("accept_outside_list", `status=${s}`);
      }
      // Accepting is always at least as permissive as escalating.
      if (customerMayAnswer(s, "still") && !customerMayAnswer(s, "resolved")) {
        f.add("escalate_allowed_but_accept_not", `status=${s}`);
      }
    }
    expect(f.total, `customerMayAnswer${f.report()}`).toBe(0);
    expect(customerMayAnswer("crew_review", "still")).toBe(false);
    expect(customerMayAnswer("verifying", "still")).toBe(true);
    expect(customerMayAnswer("talk", "still")).toBe(true);
    // SIM-FOUND (reported as a sticking point, not a money bug): 'fixing' is
    // acceptable but NOT escalatable — the portal door strands a customer
    // whose promised fix visit went badly, while the SMS door (disputes.ts
    // customerStill) still accepts it. The two doors disagree.
    expect(customerMayAnswer("fixing", "resolved")).toBe(true);
    expect(customerMayAnswer("fixing", "still")).toBe(false);
  });
});

// ===========================================================================
// SUITE 6 — PAYOUT RAILS + REFERRAL COMMISSIONS AT SCALE
// ===========================================================================
describe(`payout rails and referral commissions (seed ${SEED})`, () => {
  it("early-pay fees conserve the gross and never invert the crew's cheque", () => {
    const rng = mulberry32(SEED ^ 0xea41);
    const f = new Failures();
    for (let i = 0; i < 20000; i++) {
      const gross = R2(rng() < 0.05 ? -rng() * 500 : rng() * 9000);
      const pct = [0, 0.01, 0.02, 0.05, 0.1][Math.floor(rng() * 5)];
      const { fee, net } = earlyFee(gross, pct);
      const g = Math.max(0, gross);
      if (R2(fee + net) !== R2(g)) f.add("early_fee_not_conserved", `gross=${gross} fee=${fee} net=${net}`);
      if (fee < 0 || net < 0) f.add("early_fee_negative", `gross=${gross} fee=${fee} net=${net}`);
      if (fee > R2(g * pct) + 0.01) f.add("early_fee_over_rate", `gross=${gross} pct=${pct} fee=${fee}`);
    }
    // A negative loose balance must never present as money to pull.
    expect(earlyFee(-120, 0.02)).toEqual({ fee: 0, net: 0 });
    expect(f.total, `earlyFee${f.report()}`).toBe(0);
  });

  it("bank details are checksum-gated before a cent can be routed", () => {
    const rng = mulberry32(SEED ^ 0xba4c);
    let valid = 0;
    for (let i = 0; i < 5000; i++) {
      const digits = Array.from({ length: 9 }, () => Math.floor(rng() * 10)).join("");
      if (abaValid(digits)) valid++;
    }
    expect(valid).toBeGreaterThan(200); // ~1 in 10 random 9-digit strings
    expect(abaValid("000000000")).toBe(false); // all-zero passes the mod but is not a bank
    expect(abaValid("12345678")).toBe(false);
    expect(accountPlausible("0001")).toBe(true);
    expect(accountPlausible("123")).toBe(false);
    expect(accountPlausible("12345678901234567890")).toBe(false);
  });

  it("referral commissions stay inside the lifetime cap across a two-season chain, and credits never exceed the bill", () => {
    const rng = mulberry32(SEED ^ 0x8e5a);
    const f = new Failures();
    let pairs = 0;

    for (let i = 0; i < 3000; i++) {
      // One (referrer, brought-crew) pair worked all season.
      const cap = [0, 100, 250, 2000][Math.floor(rng() * 4)];
      const pct = [0, 0.05, 0.25, 0.5, 0.9][Math.floor(rng() * 5)];
      let accrued = 0;
      const jobs = 5 + Math.floor(rng() * 60);
      for (let k = 0; k < jobs; k++) {
        const margin = R2(rng() * 400);
        const a = crewShareAccrual(margin, pct, cap, accrued);
        if (a < 0) f.add("negative_crew_accrual", `margin=${margin} pct=${pct}`);
        if (a > R2(margin * Math.min(pct, 1)) + 0.01) f.add("crew_accrual_over_share", `margin=${margin} pct=${pct} a=${a}`);
        accrued = R2(accrued + a);
        if (accrued > cap + 1e-9) f.add("crew_accrual_over_cap", `cap=${cap} accrued=${accrued}`);
      }
      pairs++;

      // The customer side: credits granted, then spent against real bills.
      let balance = R2(rng() * 400);
      const granted = balance;
      let spent = 0;
      for (let k = 0; k < 12; k++) {
        const bill = R2(20 + rng() * 900);
        const apply = creditToApply(balance, bill);
        if (apply > bill + 1e-9) f.add("credit_over_bill", `bill=${bill} apply=${apply}`);
        if (apply > balance + 1e-9) f.add("credit_over_balance", `balance=${balance} apply=${apply}`);
        if (apply < 0) f.add("negative_credit", `apply=${apply}`);
        balance = R2(balance - apply);
        spent = R2(spent + apply);
        if (balance < -1e-9) f.add("credit_balance_negative", `balance=${balance}`);
      }
      if (spent > granted + 1e-9) f.add("spent_over_granted", `granted=${granted} spent=${spent}`);

      // Sunset + maturation cadence.
      const attributed = isoAdd("2026-05-01", Math.floor(rng() * 700));
      const now = Date.parse(attributed + "T12:00:00Z") + Math.floor(rng() * 800) * 86_400_000;
      const inside = withinSunset(attributed, now, 365);
      const days = (now - Date.parse(attributed + "T12:00:00Z")) / 86_400_000;
      if (inside !== days < 365) f.add("sunset_boundary", `attributed=${attributed} days=${days} inside=${inside}`);
      if (withinSunset(null, now, 365)) f.add("sunset_null_attributed", "null attributed accrued");
    }

    expect(pairs).toBe(3000);
    expect(f.total, `referral commissions${f.report()}`).toBe(0);
  });

  it("month-end batch cadence and the nudge dials behave over two full seasons of dates", () => {
    const f = new Failures();
    let monthEnds = 0;
    let d = "2026-01-01";
    for (let i = 0; i < 730; i++) {
      if (isLastDayOfMonth(d)) {
        monthEnds++;
        const tomorrow = isoAdd(d, 1);
        if (!tomorrow.endsWith("-01")) f.add("month_end_wrong", `date=${d} next=${tomorrow}`);
      }
      d = isoAdd(d, 1);
    }
    // Two calendar years = 24 month-ends, leap-day aware.
    if (monthEnds !== 24) f.add("month_end_count", `got=${monthEnds}`);
    if (!isLastDayOfMonth("2028-02-29")) f.add("leap_day", "2028-02-29 not seen as month end");
    if (isLastDayOfMonth("2026-02-29")) f.add("bad_leap_day", "2026-02-29 accepted");

    // Milestone tease must never double-fire with the covers-a-visit nudge.
    const rng = mulberry32(SEED ^ 0x9cd6);
    for (let i = 0; i < 8000; i++) {
      const balance = R2(rng() * 120);
      const maturing = R2(rng() * 120);
      const near = nearMilestone(balance, maturing, DIALS.nudgeCreditThreshold);
      if (balance >= DIALS.nudgeCreditThreshold && near !== null) f.add("double_fire", `balance=${balance}`);
      if (near) {
        if (near.gap < 0) f.add("negative_gap", `gap=${near.gap}`);
        if (near.projected < R2(balance + maturing) - 0.01) f.add("projected_short", `projected=${near.projected}`);
      }
      const lastSent = new Date(Date.now() - rng() * 90 * 86_400_000).toISOString();
      const cooling = nudgeCooling(lastSent, DIALS.nudgeCooldownDays, Date.now());
      const age = (Date.now() - Date.parse(lastSent)) / 86_400_000;
      if (cooling !== age < DIALS.nudgeCooldownDays) f.add("cooldown_boundary", `age=${age} cooling=${cooling}`);
      if (nudgeCooling(null, 30, Date.now())) f.add("cooldown_on_never_sent", "");
    }
    expect(f.total, `growth cadence${f.report()}`).toBe(0);
  });
});

// ===========================================================================
// SUITE 7 — SIM-FOUND DEFECTS, SHRUNK TO MINIMAL REPRODUCING INPUTS
//
// Each case below was found by the randomized suites above and shrunk by hand
// against the engine source. They assert the CURRENT (defective) behavior on
// purpose, so this suite stays green while the defect stays documented and
// impossible to regress away silently. Fixing the engine SHOULD break these.
// ===========================================================================
describe("SIM-FOUND defects — minimal repros (assert CURRENT behavior)", () => {
  // -------------------------------------------------------------------------
  // SIM-FOUND BUG #1 — src/lib/cancellation.ts
  // cancellationQuote() computes the crew's slot-hold share off vendor_cost
  // and the customer's fee off customer_price, and clamps NEITHER against the
  // other. When customer_price < vendor_cost, LakeLife pays the crew more than
  // the fee it collects — real cash out the door on a cancelled job.
  //
  // REACHABILITY: src/app/approvals/actions.ts:66-74 reprices every open job
  // on a property when an owner approves a crew's profile correction. It
  // rewrites customer_price and PRESERVES vendor_cost, re-deriving margin with
  // NO margin-floor re-check and no re-dispatch. A downward correction (pier
  // "8 sections" → "2 sections") therefore leaves a scheduled job whose crew
  // rate exceeds its price. src/app/requests/actions.ts then charges the fee
  // and pays q.crewShare from it.
  // -------------------------------------------------------------------------
  it("BUG #1: a late-cancel pays the crew MORE than the fee when a flag repriced the job below its crew rate", () => {
    const pier: ServiceRule = {
      name: "Pier install / removal", pricing_model: "per_section",
      base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" },
    };
    const profile = (sections: number): PricingProfile => ({
      sqft: 2400, beds: 3, baths: 2, pier_sections: sections, boat_lifts: 1,
      toy_lifts: 0, jet_skis: 0, pwc_lifts: 0, lawn_band: "medium", boats: [], toys: [],
    });
    const pricedAt8 = priceService(pier, profile(8)); // 604 — what dispatch quoted
    const vendorCost = R2(pricedAt8 * 0.7); // 422.80 — crew rate, 30% margin
    const repricedAt2 = priceService(pier, profile(2)); // 316 — after the approved flag
    expect(pricedAt8).toBe(604);
    expect(repricedAt2).toBe(316);
    expect(vendorCost).toBeGreaterThan(repricedAt2); // margin is now NEGATIVE

    const q = cancellationQuote(
      {
        status: "scheduled", hasCrew: true, isWaterWork: true,
        jobDateISO: "2026-10-10", slot: "8a", nowDateISO: "2026-10-08", nowMinutes: 600,
        customerPrice: repricedAt2, vendorCost,
      },
      { cancelFeePct: 0.25, cancelRoutineHours: 48, cancelWaterDays: 7 },
    );
    expect(q.allowed).toBe(true);
    expect(q.free).toBe(false);
    expect(q.fee).toBe(79); // 25% of $316 charged to the customer's card
    expect(q.crewShare).toBe(105.7); // 25% of $422.80 paid to the crew
    // CURRENT behavior: crewShare > fee. Expected behavior: crewShare <= fee.
    expect(q.crewShare).toBeGreaterThan(q.fee);
    expect(R2(q.crewShare - q.fee)).toBe(26.7); // LakeLife's loss on this cancel
  });

  // -------------------------------------------------------------------------
  // SIM-FOUND BUG #2 — src/lib/refund-core.ts:75-77 (basis passed to
  // src/lib/refunds.ts defaultClawback)
  // Referral credits reduce the CASH captured (automation.ts settleJob charges
  // price − creditApplied) but the proportional clawback is computed against
  // the full customer_price. A refund can only ever return the cash, so a
  // FULL refund — the invoice literally flips to 'refunded' — claws back only
  // captured/price of the crew's cost. The crew keeps the credit-funded slice
  // of their pay on a job the customer paid nothing net for.
  // -------------------------------------------------------------------------
  it("BUG #2: a FULLY refunded credit-covered invoice leaves part of the crew's pay un-clawed", () => {
    const customerPrice = 604;
    const vendorCost = 422.8;
    const creditApplied = 120; // referral credits the owner had banked
    const captured = R2(customerPrice - creditApplied); // 484 — the only cash there is

    const fullCashRefund = refundableRemaining(captured, 0);
    expect(fullCashRefund).toBe(484);

    // The invoice is DONE — nothing more can ever be refunded on it.
    expect(invoiceStatusAfter(captured, fullCashRefund)).toBe("refunded");
    expect(refundableRemaining(captured, fullCashRefund)).toBe(0);

    // But the clawback is proportional to the PRICE, not the cash.
    const clawback = defaultClawback(fullCashRefund, customerPrice, vendorCost);
    expect(clawback).toBe(338.8);
    // CURRENT behavior: the crew keeps $84.00 on a fully-refunded job.
    expect(R2(vendorCost - clawback)).toBe(84);
    // Expected behavior: a 'refunded' invoice claws the full original_amount.
    expect(clawback).toBeLessThan(vendorCost);
  });

  // -------------------------------------------------------------------------
  // SIM-FOUND EDGE #3 — src/lib/refunds.ts:84 invoiceStatusAfter
  // With zero captured cash the invoice reads 'refunded' before a single cent
  // has moved. Not reachable through executeRefund today (its own guards stop
  // a $0-captured refund first), but it is a live trap for any future caller —
  // e.g. the credit-covered path, which settles an invoice with NO payments
  // row at all.
  // -------------------------------------------------------------------------
  it("EDGE #3: invoiceStatusAfter reports 'refunded' for a zero-cash invoice with zero refunds", () => {
    expect(invoiceStatusAfter(0, 0)).toBe("refunded");
  });

  // -------------------------------------------------------------------------
  // SIM-FOUND EDGE #4 — src/lib/refunds.ts:71 planClawback
  // `available = max(0, payout.amount)` throws away a negative row amount, so
  // the plan's newAmount of 0 RAISES the row while the adjustment covers the
  // whole clawback — the only input shape where the pieces do not sum to the
  // clawback. Earning rows are never negative today (amount = vendor_cost), so
  // this is defense-in-depth, not a live leak.
  // -------------------------------------------------------------------------
  it("EDGE #4: planClawback against a negative payout amount does not conserve", () => {
    const plan = planClawback(50, { id: "po", amount: -20, status: "released", batchId: null });
    expect(plan).toEqual({ mode: "reduce_and_adjust", payoutId: "po", newAmount: 0, newStatus: "clawed", adjustmentAmount: -50 });
    // Applying it: the row moves -20 → 0, which HANDS THE CREW $20 back, and
    // the adjustment takes $50. Net recovered = -20 + -50... = -30, not -50.
    const rowDelta = R2(0 - -20); // +20 to the crew
    const recovered = R2(-rowDelta + 50); // what actually left the crew
    expect(recovered).toBe(30);
    expect(recovered).not.toBe(50); // the clawback that was planned
  });
});
