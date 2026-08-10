import { describe, it, expect } from "vitest";
import {
  payersFor, monthlyIncome, checkCoverage, coverageSummary,
  type ParkFee,
} from "./fee-helpers";
import type { CostCategory } from "./cost-helpers";

/** The Haven's grounds fee: one flat charge covering the lot. */
const GROUNDS: ParkFee = {
  id: "f1",
  label: "Grounds fee",
  amount: 55,
  cadence: "monthly",
  appliesTo: "long_term",
  covers: ["water", "sewer", "trash", "common_electric", "grounds"] as CostCategory[],
  active: true,
};

const COUNTS = { longTerm: 20, shortTerm: 4, optedIn: 3 };

describe("who pays a fee", () => {
  it("lands a grounds fee on the lots people live on", () => {
    expect(payersFor(GROUNDS, COUNTS)).toBe(20);
  });

  it("counts an OPT-IN fee from sign-ups, never from the lot count", () => {
    // Assuming everybody has a pet overstates income by exactly the amount
    // that makes a proforma wrong.
    const pet: ParkFee = { ...GROUNDS, id: "f2", appliesTo: "opt_in", amount: 25, covers: [] };
    expect(payersFor(pet, COUNTS)).toBe(3);
  });

  it("can land on everything, including nightly homes", () => {
    expect(payersFor({ ...GROUNDS, appliesTo: "all_lots" }, COUNTS)).toBe(24);
  });
});

describe("what a fee brings in", () => {
  it("multiplies a monthly fee by its payers", () => {
    expect(monthlyIncome(GROUNDS, 20)).toBe(1100);
  });

  it("spreads an annual fee across the year", () => {
    expect(monthlyIncome({ ...GROUNDS, cadence: "annual", amount: 600 }, 20)).toBe(1000);
  });

  it("refuses to invent a monthly figure for a per-stay fee", () => {
    // Without turnover there is no honest number, and a guess would inflate
    // the only figure he's using to judge whether the fee covers his costs.
    expect(monthlyIncome({ ...GROUNDS, cadence: "per_stay", amount: 75 }, 20)).toBe(0);
    expect(monthlyIncome({ ...GROUNDS, cadence: "one_time", amount: 75 }, 20)).toBe(0);
  });

  it("brings in nothing when switched off", () => {
    expect(monthlyIncome({ ...GROUNDS, active: false }, 20)).toBe(0);
  });
});

describe("IS THE GROUNDS FEE SET RIGHT", () => {
  const payers = new Map([["f1", 20]]);

  it("says AHEAD when the fee covers the real cost", () => {
    // One month of bills totalling $900 against $1,100 of fee.
    const c = checkCoverage(
      [GROUNDS], payers,
      [
        { category: "water", amountPaid: 380 },
        { category: "sewer", amountPaid: 300 },
        { category: "trash", amountPaid: 220 },
      ],
      1,
    );
    expect(c.feeIncome).toBe(1100);
    expect(c.actualCost).toBe(900);
    expect(c.margin).toBe(200);
    expect(coverageSummary(c, 20)).toMatch(/ahead by \$10\.00 a lot/);
  });

  it("says SHORT, per lot, when it does not", () => {
    // $71 a lot of real cost against a $55 fee.
    const c = checkCoverage(
      [GROUNDS], payers,
      [{ category: "water", amountPaid: 800 }, { category: "grounds", amountPaid: 620 }],
      1,
    );
    expect(c.margin).toBeLessThan(0);
    const s = coverageSummary(c, 20);
    expect(s).toContain("SHORT");
    expect(s).toMatch(/\$16\.00 a lot/);
  });

  it("DIVIDES BY THE MONTHS OBSERVED — three months of bills is not one month", () => {
    // Getting this wrong tells him he is losing money at three times the real
    // rate, and a wrong alarm is worse than no alarm.
    const threeMonths = [
      { category: "water" as CostCategory, amountPaid: 380 },
      { category: "water" as CostCategory, amountPaid: 400 },
      { category: "water" as CostCategory, amountPaid: 420 },
    ];
    const one = checkCoverage([GROUNDS], payers, threeMonths, 1);
    const three = checkCoverage([GROUNDS], payers, threeMonths, 3);
    expect(one.actualCost).toBe(1200);
    expect(three.actualCost).toBe(400);
    expect(three.margin).toBeGreaterThan(one.margin);
  });

  it("names a cost NOTHING claims to cover", () => {
    const c = checkCoverage(
      [{ ...GROUNDS, covers: ["water"] as CostCategory[] }], payers,
      [{ category: "water", amountPaid: 380 }, { category: "grounds", amountPaid: 500 }],
      1,
    );
    expect(c.uncovered).toContain("grounds");
    // And the uncovered cost is NOT counted against the fee — the fee never
    // promised it.
    expect(c.actualCost).toBe(380);
  });

  it("names what the fee claims but nothing has been spent on", () => {
    const c = checkCoverage([GROUNDS], payers, [{ category: "water", amountPaid: 380 }], 1);
    expect(c.unverified).toEqual(expect.arrayContaining(["sewer", "trash", "common_electric"]));
  });

  it("does NOT credit an amenities-only fee against the water bill", () => {
    const amenities: ParkFee = {
      ...GROUNDS, id: "f9", label: "Amenities", amount: 30, covers: [] as CostCategory[],
    };
    const c = checkCoverage(
      [amenities], new Map([["f9", 20]]),
      [{ category: "water", amountPaid: 380 }], 1,
    );
    expect(c.feeIncome).toBe(0);
  });

  it("is honest when there is nothing to compare", () => {
    const c = checkCoverage([GROUNDS], payers, [], 1);
    expect(coverageSummary(c, 20)).toMatch(/no bills entered/i);
  });
});
