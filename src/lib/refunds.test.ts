import { describe, it, expect } from "vitest";
import {
  refundableRemaining,
  defaultClawback,
  clampClawback,
  planClawback,
  invoiceStatusAfter,
  type PayoutSnapshot,
  type ClawbackPlan,
} from "./refunds";

const round2 = (n: number) => Math.round(n * 100) / 100;

const payout = (over: Partial<PayoutSnapshot> = {}): PayoutSnapshot => ({
  id: "po_1",
  amount: 59,
  status: "released",
  batchId: null,
  ...over,
});

describe("refundableRemaining — cash captured minus cash already back out the door", () => {
  it("normal case", () => {
    expect(refundableRemaining(200, 50)).toBe(150);
  });
  it("over-refunded clamps to 0 (never lets the ledger go negative)", () => {
    expect(refundableRemaining(100, 150)).toBe(0);
    expect(refundableRemaining(100, 100)).toBe(0);
  });
  it("a negative already-refunded figure is treated as 0, not added back", () => {
    expect(refundableRemaining(100, -20)).toBe(100);
  });
  it("rounds to the cent instead of drifting on float math", () => {
    expect(refundableRemaining(100.005, 0)).toBe(100.01);
    expect(refundableRemaining(19.996, 4.99)).toBe(15.01); // 15.005999999999998 raw
  });
});

describe("defaultClawback — the crew's proportional share of the refund", () => {
  it("the worked example: refund $40 on an $85 price / $59 cost job claws $27.76", () => {
    expect(defaultClawback(40, 85, 59)).toBe(27.76);
  });
  it("a full refund claws exactly the vendor cost, not a penny more", () => {
    expect(defaultClawback(85, 85, 59)).toBe(59);
  });
  it("clamps at vendor cost even if the ratio would push past it", () => {
    // refund > customerPrice shouldn't happen upstream, but the clamp is load-bearing defense.
    expect(defaultClawback(200, 85, 59)).toBe(59);
  });
  it("zero or missing refund is zero clawback", () => {
    expect(defaultClawback(0, 85, 59)).toBe(0);
  });
  it("degenerate price/cost inputs (zero or negative) all resolve to 0", () => {
    expect(defaultClawback(40, 0, 59)).toBe(0);
    expect(defaultClawback(40, 85, 0)).toBe(0);
    expect(defaultClawback(-10, 85, 59)).toBe(0);
    expect(defaultClawback(40, -85, 59)).toBe(0);
    expect(defaultClawback(40, 85, -59)).toBe(0);
  });
});

describe("clampClawback — legal band [0, vendorCost] for an ops override", () => {
  it("a number inside the band passes through unchanged", () => {
    expect(clampClawback(30, 59)).toBe(30);
  });
  it("clamps a negative ask up to 0", () => {
    expect(clampClawback(-10, 59)).toBe(0);
  });
  it("clamps an over-ask down to vendorCost", () => {
    expect(clampClawback(1000, 59)).toBe(59);
  });
  it("NaN collapses to 0", () => {
    expect(clampClawback(NaN, 59)).toBe(0);
  });
  it("Infinity/-Infinity (not finite) collapse to 0", () => {
    expect(clampClawback(Infinity, 59)).toBe(0);
    expect(clampClawback(-Infinity, 59)).toBe(0);
  });
  it("a negative vendorCost floors the whole band at 0", () => {
    expect(clampClawback(30, -5)).toBe(0);
    expect(clampClawback(-30, -5)).toBe(0);
  });
});

describe("planClawback — mode: none", () => {
  it("zero clawback needs no recovery from the crew", () => {
    expect(planClawback(0, payout())).toEqual<ClawbackPlan>({ mode: "none" });
  });
  it("a negative clawback (shouldn't happen upstream) also resolves to none", () => {
    expect(planClawback(-5, payout())).toEqual<ClawbackPlan>({ mode: "none" });
  });
  it("none even with no payout at all, when there's nothing to claw", () => {
    expect(planClawback(0, null)).toEqual<ClawbackPlan>({ mode: "none" });
  });
});

describe("planClawback — mode: adjust (negative row nets against the next batch)", () => {
  it("no payout exists at all -> adjustment for the full clawback (fail-safe)", () => {
    expect(planClawback(25, null)).toEqual<ClawbackPlan>({ mode: "adjust", adjustmentAmount: -25 });
  });
  it("payout already swept into a batch -> adjustment, exactly -clawback", () => {
    const p = payout({ batchId: "batch-1", status: "released", amount: 100 });
    expect(planClawback(25, p)).toEqual<ClawbackPlan>({ mode: "adjust", adjustmentAmount: -25 });
  });
  it("payout already paid out -> adjustment, exactly -clawback", () => {
    const p = payout({ batchId: null, status: "paid", amount: 100 });
    expect(planClawback(25, p)).toEqual<ClawbackPlan>({ mode: "adjust", adjustmentAmount: -25 });
  });
  it("payout in some other non-released status (e.g. void) -> adjustment", () => {
    const p = payout({ batchId: null, status: "void", amount: 100 });
    expect(planClawback(25, p)).toEqual<ClawbackPlan>({ mode: "adjust", adjustmentAmount: -25 });
  });
});

describe("planClawback — mode: reduce (loose payout, in-place reduction)", () => {
  it("partial reduction with room to spare keeps the payout 'released'", () => {
    const p = payout({ amount: 59, status: "released", batchId: null });
    expect(planClawback(20, p)).toEqual<ClawbackPlan>({
      mode: "reduce",
      payoutId: p.id,
      newAmount: 39,
      newStatus: "released",
    });
  });
  it("reduced to exactly zero flips status to 'clawed' so batches skip it", () => {
    const p = payout({ amount: 59, status: "released", batchId: null });
    expect(planClawback(59, p)).toEqual<ClawbackPlan>({
      mode: "reduce",
      payoutId: p.id,
      newAmount: 0,
      newStatus: "clawed",
    });
  });
});

describe("planClawback — mode: reduce_and_adjust (loose payout too small)", () => {
  it("drains the loose payout to 0 ('clawed') and adjusts for the remainder", () => {
    const p = payout({ amount: 20, status: "released", batchId: null });
    expect(planClawback(50, p)).toEqual<ClawbackPlan>({
      mode: "reduce_and_adjust",
      payoutId: p.id,
      newAmount: 0,
      newStatus: "clawed",
      adjustmentAmount: -30,
    });
  });
  it("the two pieces always sum to exactly -clawback", () => {
    const p = payout({ amount: 20, status: "released", batchId: null });
    const plan = planClawback(50, p);
    if (plan.mode !== "reduce_and_adjust") throw new Error("expected reduce_and_adjust");
    const reductionDelta = plan.newAmount - p.amount; // money removed from the payout (negative)
    expect(round2(reductionDelta + plan.adjustmentAmount)).toBe(-50);
  });
});

describe("invoiceStatusAfter — boundary between 'paid' and 'refunded'", () => {
  it("exactly-equal cumulative refunds flips the invoice to 'refunded'", () => {
    expect(invoiceStatusAfter(150, 150)).toBe("refunded");
  });
  it("a cent under the captured cash stays 'paid'", () => {
    expect(invoiceStatusAfter(150, 149.99)).toBe("paid");
  });
  it("over-refunded (shouldn't happen, but math is defensive) still reads 'refunded'", () => {
    expect(invoiceStatusAfter(150, 150.01)).toBe("refunded");
  });
  it("zero refunded against captured cash stays 'paid'", () => {
    expect(invoiceStatusAfter(150, 0)).toBe("paid");
  });
});

// --- Money-conservation property test -------------------------------------
// Deterministic PRNG (mulberry32) — no new test dependency, same result every run.
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("money conservation — property test across random refund/price/cost combos", () => {
  const rng = mulberry32(0xc0ffee);
  const CENT = 0.01;

  it("defaultClawback never exceeds vendorCost, and planClawback's pieces always sum to exactly -clawback", () => {
    for (let i = 0; i < 500; i++) {
      const customerPrice = rng() * 500 + 1; // (0, 501]
      const vendorCost = rng() * customerPrice; // [0, customerPrice)
      const refundAmount = rng() * customerPrice; // [0, customerPrice)

      const clawback = defaultClawback(refundAmount, customerPrice, vendorCost);

      // Money conservation #1: the crew is never clawed back more than they were owed.
      expect(clawback).toBeLessThanOrEqual(vendorCost + CENT);
      expect(clawback).toBeGreaterThanOrEqual(0);

      // Money conservation #2: however the recovery is split across a reduction
      // and/or an adjustment row, the pieces always net to exactly -clawback.
      const payoutScenarios: (PayoutSnapshot | null)[] = [
        null,
        payout({ amount: round2(rng() * vendorCost), status: "released", batchId: null }),
        payout({ amount: round2(rng() * vendorCost), status: "released", batchId: "batch-x" }),
        payout({ amount: round2(rng() * vendorCost), status: "paid", batchId: null }),
      ];

      for (const p of payoutScenarios) {
        const plan = planClawback(clawback, p);
        const expected = clawback > 0 ? -clawback : 0;

        let recovered: number;
        switch (plan.mode) {
          case "none":
            recovered = 0;
            break;
          case "adjust":
            recovered = plan.adjustmentAmount;
            break;
          case "reduce":
            recovered = round2(plan.newAmount - (p as PayoutSnapshot).amount);
            break;
          case "reduce_and_adjust":
            recovered = round2(plan.newAmount - (p as PayoutSnapshot).amount + plan.adjustmentAmount);
            break;
        }

        expect(Math.abs(recovered - expected)).toBeLessThanOrEqual(CENT);
      }
    }
  });
});
