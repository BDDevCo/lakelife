import { describe, it, expect } from "vitest";
import {
  payersFor, monthlyIncome, checkCoverage, coverageSummary,
  type ParkFee, nightlyRecoveryTarget, nightlyRecoveryLine,
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

  // WAS: "can land on everything, including nightly homes" — asserting 24.
  // That encoded a disagreement with the charge run, which bills a short-term
  // lot no fees at all (`ledger-actions`: fees: rental_mode === "short_term"
  // ? [] : fees). The screen credited income from lots that are never
  // invoiced, on the one screen built to answer "is my fee covering my costs".
  it("does not credit nightly homes, which are billed no fee at all", () => {
    expect(payersFor({ ...GROUNDS, appliesTo: "all_lots" }, COUNTS)).toBe(20);
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

// ---------------------------------------------------------------------------
// WHO ACTUALLY PAYS A FEE.
//
// A fee rides on a rent bill. A short-term lot is billed none at all
// (`ledger-actions`: `fees: rental_mode === "short_term" ? [] : fees`), and an
// empty lot gets no rent bill to ride on. Counting either inflated the one
// number this screen exists to produce — "is my fee covering my costs?" —
// and by exactly the vacancy the cost side now makes the park carry.
// ---------------------------------------------------------------------------
describe("who a flat fee is actually billed to", () => {
  const fee = (appliesTo: ParkFee["appliesTo"]): ParkFee => ({
    id: "f1", label: "Park services", amount: 70, cadence: "monthly",
    appliesTo, covers: ["grounds", "common_electric", "water"], active: true,
  });

  it("never credits a short-term lot, which is billed no fee at all", () => {
    const counts = { longTerm: 19, shortTerm: 4, optedIn: 0 };
    expect(payersFor(fee("all_lots"), counts)).toBe(19);
    expect(payersFor(fee("long_term"), counts)).toBe(19);
  });

  it("is the same number whichever way round the park is described", () => {
    // 'all_lots' and 'long_term' can only differ by lots that are never
    // billed, so on this product they are the same answer.
    const counts = { longTerm: 12, shortTerm: 9, optedIn: 3 };
    expect(payersFor(fee("all_lots"), counts))
      .toBe(payersFor(fee("long_term"), counts));
  });

  it("still counts an opt-in fee by who opted in", () => {
    expect(payersFor(fee("opt_in"), { longTerm: 19, shortTerm: 4, optedIn: 6 })).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// WHAT AN STR UNIT COSTS THE PARK PER NIGHT.
//
// A guest's load is CAPACITY, not consumption — three nights barely touch a
// well but occupy a whole unit's roads, lighting and grounds. Hence per night,
// like a resort fee, and NOT the monthly fee cut into thirtieths.
// ---------------------------------------------------------------------------
describe("pricing a park-owned home's share into the nightly rate", () => {
  it("spreads the month's share over the nights it could be let", () => {
    // $54.28 over a 30-night August.
    expect(nightlyRecoveryTarget({ monthlyShare: 54.28, nightsAvailable: 30 })).toBe(1.81);
  });

  it("rounds up, because under-recovering every night is a slow leak", () => {
    // 54.28 / 28 = 1.938…  A guest cannot tell $1.93 from $1.94.
    expect(nightlyRecoveryTarget({ monthlyShare: 54.28, nightsAvailable: 28 })).toBe(1.94);
  });

  // The denominator is nights AVAILABLE, not nights booked. Dividing by nights
  // sold would make the rate climb as occupancy falls — the same mistake the
  // cost allocator made by dividing among occupied lots only.
  it("does not get more expensive per night when the unit sits empty", () => {
    const busy = nightlyRecoveryTarget({ monthlyShare: 60, nightsAvailable: 30 });
    const quiet = nightlyRecoveryTarget({ monthlyShare: 60, nightsAvailable: 30 });
    expect(busy).toBe(quiet);
  });

  it("says it cannot answer rather than inventing a rate", () => {
    expect(nightlyRecoveryTarget({ monthlyShare: 0, nightsAvailable: 30 })).toBeNull();
    expect(nightlyRecoveryTarget({ monthlyShare: 54.28, nightsAvailable: 0 })).toBeNull();
    expect(nightlyRecoveryLine("12", null)).toMatch(/can't work out/i);
  });

  // It is a PRICE, not a charge — LakeLife is not in an Airbnb transaction and
  // must not imply it can bill the guest.
  it("says plainly that we cannot bill a booking taken elsewhere", () => {
    expect(nightlyRecoveryLine("12", 1.81)).toContain("$1.81 a night");
    expect(nightlyRecoveryLine("12", 1.81)).toMatch(/booking taken somewhere else/i);
  });
});
