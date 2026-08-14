import { describe, it, expect } from "vitest";
import {
  allocateCost, allocationSummary, recoveryByCategory,
  type CostLot, type CostCategory, canSplit, whyNotSplit,
} from "./cost-helpers";

/** The Haven: 19 occupied lots, 2 empty (3 and 22). */
const HAVEN: CostLot[] = [
  ...["1","2","4","5","6","8","9","10","11","12","13","14","15","16","17","18","19","20","21"]
    .map((n) => ({ lotId: `l${n}`, lotNumber: n, reservationId: `r${n}` })),
  { lotId: "l3",  lotNumber: "3",  reservationId: null },
  { lotId: "l22", lotNumber: "22", reservationId: null },
];

describe("THE CARDINAL RULE: never recover more than was paid", () => {
  it("holds on a bill that does not divide evenly", () => {
    // $100 / 3 = 33.333… Rounding to nearest bills $100.02 — over-recovery,
    // for a cent, on every odd bill forever.
    const a = allocateCost({
      amountPaid: 100,
      method: "per_lot",
      lots: HAVEN.slice(0, 3),
    });
    expect(a.shares.every((s) => s.amount === 33.33)).toBe(true);
    expect(a.allocated).toBe(99.99);
    expect(a.allocated).toBeLessThanOrEqual(100);
    expect(a.parkAbsorbs).toBe(0.01);
  });

  it("holds across a thousand awkward amounts and lot counts", () => {
    for (let cents = 1; cents <= 1000; cents++) {
      for (const n of [1, 2, 3, 7, 19, 23]) {
        const paid = cents / 7;                       // deliberately ugly
        const a = allocateCost({
          amountPaid: paid,
          method: "per_lot",
          lots: HAVEN.slice(0, n),
        });
        expect(a.allocated).toBeLessThanOrEqual(paid + 1e-9);
      }
    }
  });

  it("holds for a metered split too", () => {
    const lots: CostLot[] = [
      { lotId: "a", lotNumber: "1", reservationId: "r1", reading: 7 },
      { lotId: "b", lotNumber: "2", reservationId: "r2", reading: 11 },
      { lotId: "c", lotNumber: "3", reservationId: "r3", reading: 13 },
    ];
    const a = allocateCost({ amountPaid: 100, method: "metered", lots });
    expect(a.allocated).toBeLessThanOrEqual(100);
    expect(a.shares).toHaveLength(3);
    // Bigger reading, bigger share.
    expect(a.shares[2].amount).toBeGreaterThan(a.shares[0].amount);
  });
});

describe("who pays", () => {
  it("splits The Haven's water bill across the 19 occupied lots only", () => {
    const a = allocateCost({ amountPaid: 380, method: "per_lot", lots: HAVEN });
    expect(a.occupiedCount).toBe(19);
    expect(a.vacantCount).toBe(2);
    expect(a.shares).toHaveLength(19);
    expect(a.shares[0].amount).toBe(20);
    expect(a.allocated).toBe(380);
    expect(a.parkAbsorbs).toBe(0);
  });

  it("makes the cost of an empty lot visible", () => {
    const a = allocateCost({ amountPaid: 210, method: "per_lot", lots: HAVEN.slice(0, 21) });
    // 19 occupied of 21 → the two empties are the park's to carry.
    expect(a.vacantCount).toBe(2);
    expect(a.parkAbsorbs).toBeGreaterThan(0);
  });

  it("charges a vacant lot nothing at all", () => {
    const a = allocateCost({ amountPaid: 100, method: "per_lot", lots: HAVEN });
    const ids = a.shares.map((s) => s.lotId);
    expect(ids).not.toContain("l3");
    expect(ids).not.toContain("l22");
  });

  it("splits nothing when the park is empty", () => {
    const a = allocateCost({
      amountPaid: 100, method: "per_lot",
      lots: [{ lotId: "x", lotNumber: "1", reservationId: null }],
    });
    expect(a.problem).toBe("no_occupied_lots");
    expect(a.shares).toHaveLength(0);
    expect(a.parkAbsorbs).toBe(100);
  });

  it("REFUSES a metered split with no readings rather than quietly splitting evenly", () => {
    // He chose "metered" because he believed there were meters. Silently
    // changing the method produces a bill nobody can explain.
    const a = allocateCost({
      amountPaid: 100, method: "metered",
      lots: [{ lotId: "a", lotNumber: "1", reservationId: "r1", reading: 0 }],
    });
    expect(a.problem).toBe("no_readings");
    expect(a.shares).toHaveLength(0);
  });

  it("records a basis a resident can read", () => {
    const a = allocateCost({ amountPaid: 380, method: "per_lot", lots: HAVEN });
    expect(a.shares[0].basis).toBe("1 of 19 occupied lots");
  });
});

describe("what the owner reads", () => {
  it("leads with the per-lot number and names what he carries", () => {
    const a = allocateCost({ amountPaid: 400, method: "per_lot", lots: HAVEN });
    const s = allocationSummary(a, "water");
    expect(s).toContain("Water");
    expect(s).toContain("across 19 lots");
    expect(s).toMatch(/\$\d+\.\d{2} each/);
  });

  it("says so plainly when there is nobody to split across", () => {
    const a = allocateCost({
      amountPaid: 100, method: "per_lot",
      lots: [{ lotId: "x", lotNumber: "1", reservationId: null }],
    });
    expect(allocationSummary(a, "water")).toMatch(/nothing to split/i);
  });
});

describe("am I recovering what the proforma promised", () => {
  it("ALLOCATED IS NOT RECOVERED — splitting a bill is not billing it", () => {
    // This test used to assert net === -6115, i.e. allocated minus paid, and
    // it was encoding the bug: nothing billed from `lot_cost_shares` at all,
    // so the screen told the owner he had passed on $2,185 that no household
    // had been asked for. With nothing billed, what he is carrying is the
    // whole $8,300 — and that is the number he needs to see.
    const r = recoveryByCategory([
      { category: "water" as CostCategory, amountPaid: 1200, allocatedTotal: 1140 },
      { category: "water" as CostCategory, amountPaid: 1100, allocatedTotal: 1045 },
      { category: "grounds" as CostCategory, amountPaid: 6000, allocatedTotal: 0 },
    ]);
    expect(r.paid).toBe(8300);
    expect(r.allocated).toBe(2185);
    expect(r.billed).toBe(0);
    expect(r.net).toBe(-8300);          // carrying ALL of it, because none was billed
    expect(r.lines[0].category).toBe("grounds");   // biggest cost first
    expect(r.lines.find((l) => l.category === "water")!.paid).toBe(2300);
  });

  it("nets against what actually reached a bill", () => {
    const r = recoveryByCategory([
      { category: "water" as CostCategory, amountPaid: 1200, allocatedTotal: 1140, billedTotal: 1140 },
      { category: "water" as CostCategory, amountPaid: 1100, allocatedTotal: 1045, billedTotal: 0 },
    ]);
    expect(r.allocated).toBe(2185);
    expect(r.billed).toBe(1140);
    // Only the billed half comes off what he is carrying.
    expect(r.net).toBe(-1160);
  });

  it("a share allocated but not yet billed is visible as the gap", () => {
    const r = recoveryByCategory([
      { category: "water" as CostCategory, amountPaid: 1200, allocatedTotal: 1140, billedTotal: 600 },
    ]);
    expect(r.allocated - r.billed).toBe(540);
  });
});

// ---------------------------------------------------------------------------
// A HOME THE PARK OWNS IS NOT THE RESIDENTS' COST.
//
// `unit_electric` was live in the costs dropdown and split across every
// long-term resident — roughly $7,200–$10,800/yr at five park-owned homes,
// moving off the park's short-term-rental P&L and onto nineteen households.
// Its own column comment had warned against exactly this since 0069.
// ---------------------------------------------------------------------------
describe("what may be split at all", () => {
  it("refuses to divide a park-owned home's power across the lots", () => {
    expect(canSplit("unit_electric")).toBe(false);
    expect(whyNotSplit("unit_electric")).toMatch(/belongs against that home/i);
  });

  it("still splits everything the whole park uses", () => {
    for (const c of ["water", "sewer", "trash", "common_electric", "grounds", "other"] as const) {
      expect(canSplit(c)).toBe(true);
      expect(whyNotSplit(c)).toBe("");
    }
  });
});
