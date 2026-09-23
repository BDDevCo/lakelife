import { describe, it, expect } from "vitest";
import {
  customerPrice,
  crewPayout,
  platformTake,
  platformTakePct,
  quoteBreakdown,
  type PlatformFee,
} from "./platform-fee";

const twelve: PlatformFee = { customerPct: 0.12, crewPct: 0.12 };

/**
 * Every figure below is traced to the owner's own example or computed by hand
 * ONCE and written down — never recomputed from the expression under test.
 *
 *   $50.00 at 12/12  ->  customer 50 + 6.00 = 56.00, crew 50 − 6.00 = 44.00,
 *                        LakeLife 56.00 − 44.00 = 12.00
 *   $416.00 at 12/12 ->  customer 416 + 49.92 = 465.92, crew 416 − 49.92 = 366.08,
 *                        LakeLife 465.92 − 366.08 = 99.84
 */
describe("the crew's quote, both ends of it", () => {
  it("his own example: a $50 yard bills $56 and pays $44", () => {
    expect(customerPrice(50, twelve)).toBe(56);
    expect(crewPayout(50, twelve)).toBe(44);
    expect(platformTake(50, twelve)).toBe(12);
  });

  it("carries cents — $416 is $465.92, not $466", () => {
    expect(customerPrice(416, twelve)).toBe(465.92);
    expect(crewPayout(416, twelve)).toBe(366.08);
    expect(platformTake(416, twelve)).toBe(99.84);
  });

  it("THE IDENTITY: customer − payout IS the take, on awkward cents", () => {
    // If platformTake were ever computed as round2(q × (c + k)) instead of as
    // the difference of the two rounded ends, these would drift a cent apart
    // and the invoice, the payout and the ledger would stop agreeing.
    for (const q of [0.07, 1.01, 33.33, 49.99, 416, 1234.56, 99999.99]) {
      const c = customerPrice(q, twelve);
      const p = crewPayout(q, twelve);
      expect(platformTake(q, twelve), `q=${q}`).toBe(Math.round((c - p) * 100) / 100);
    }
  });

  it("every number is a whole count of cents", () => {
    for (const q of [0.07, 33.33, 49.99, 416, 1234.56]) {
      for (const n of [customerPrice(q, twelve), crewPayout(q, twelve), platformTake(q, twelve)]) {
        expect(Math.abs(n * 100 - Math.round(n * 100)), `q=${q} n=${n}`).toBeLessThan(1e-6);
      }
    }
  });

  it("the two dials may diverge — 'whatever we want to call it'", () => {
    // 15 on the customer, 10 off the crew, on a $200 quote:
    //   customer 200 × 1.15 = 230.00   crew 200 × 0.90 = 180.00   take 50.00
    const split: PlatformFee = { customerPct: 0.15, crewPct: 0.10 };
    expect(customerPrice(200, split)).toBe(230);
    expect(crewPayout(200, split)).toBe(180);
    expect(platformTake(200, split)).toBe(50);
  });

  it("at 0/0 LakeLife keeps nothing and the crew keeps their quote", () => {
    const free: PlatformFee = { customerPct: 0, crewPct: 0 };
    expect(customerPrice(50, free)).toBe(50);
    expect(crewPayout(50, free)).toBe(50);
    expect(platformTake(50, free)).toBe(0);
    expect(platformTakePct(free)).toBe(0);
  });
});

describe("LakeLife's share is a CONSTANT", () => {
  it("is 0.24 / 1.12 at 12/12, whatever the crew charges", () => {
    // Hand-computed: (0.12 + 0.12) / 1.12 = 0.2142857142857...
    expect(platformTakePct(twelve)).toBeCloseTo(0.2142857142857143, 12);
  });

  it("the actual take on a bill lands on that share at every quote", () => {
    for (const q of [25, 50, 100, 416, 2500]) {
      const share = platformTake(q, twelve) / customerPrice(q, twelve);
      expect(share, `q=${q}`).toBeCloseTo(0.2142857142857143, 4);
    }
  });

  it("falls UNDER the live 0.20 margin floor at 11/11 — the global switch", () => {
    // (0.11 + 0.11) / 1.11 = 0.198198..., which is why a floor cannot be a
    // per-crew filter on this path: it would refuse every job on the platform.
    expect(platformTakePct({ customerPct: 0.11, crewPct: 0.11 })).toBeCloseTo(0.1981981981981982, 12);
    expect(platformTakePct({ customerPct: 0.11, crewPct: 0.11 })).toBeLessThan(0.20);
  });
});

describe("a quote we cannot price is zero, not a guess", () => {
  it("NaN, Infinity, negative and zero all price at nothing", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -50, 0]) {
      expect(customerPrice(bad, twelve), String(bad)).toBe(0);
      expect(crewPayout(bad, twelve), String(bad)).toBe(0);
      expect(platformTake(bad, twelve), String(bad)).toBe(0);
      expect(quoteBreakdown(bad, twelve).crewQuote, String(bad)).toBe(0);
    }
  });
});

describe("a fee out of band is refused, never silently applied", () => {
  it("REFUSES crewPct 1.0 — the one that pays a contractor $0", () => {
    expect(() => crewPayout(50, { customerPct: 0.12, crewPct: 1 })).toThrow(/crewPct/);
    // And it never returns a number instead.
    let paid: number | null = null;
    try { paid = crewPayout(50, { customerPct: 0.12, crewPct: 1 }); } catch { /* expected */ }
    expect(paid).toBeNull();
  });

  it("refuses negative, over-one and non-finite dials on either side", () => {
    for (const fee of [
      { customerPct: -0.01, crewPct: 0.12 },
      { customerPct: 0.12, crewPct: -0.01 },
      { customerPct: 1.5, crewPct: 0.12 },
      { customerPct: 0.12, crewPct: Number.NaN },
    ]) {
      expect(() => customerPrice(50, fee), JSON.stringify(fee)).toThrow(RangeError);
      expect(() => crewPayout(50, fee), JSON.stringify(fee)).toThrow(RangeError);
      expect(() => platformTakePct(fee), JSON.stringify(fee)).toThrow(RangeError);
    }
  });

  it("accepts the settings clamp's own ceiling, 0.5", () => {
    // 100 × 1.5 = 150.00, 100 × 0.5 = 50.00, take 100.00. The clamp stops here;
    // this proves the guard does not refuse the highest legal dial.
    const half: PlatformFee = { customerPct: 0.5, crewPct: 0.5 };
    expect(customerPrice(100, half)).toBe(150);
    expect(crewPayout(100, half)).toBe(50);
    expect(platformTake(100, half)).toBe(100);
  });
});

describe("quoteBreakdown — what a screen prints", () => {
  it("says all four numbers, and they tie", () => {
    expect(quoteBreakdown(50, twelve)).toEqual({
      crewQuote: 50,
      customerPrice: 56,
      crewPayout: 44,
      platformTake: 12,
    });
  });

  it("agrees with the single-number functions on awkward cents", () => {
    const b = quoteBreakdown(416, twelve);
    expect(b).toEqual({ crewQuote: 416, customerPrice: 465.92, crewPayout: 366.08, platformTake: 99.84 });
    expect(b.customerPrice - b.crewPayout).toBeCloseTo(b.platformTake, 9);
  });
});
