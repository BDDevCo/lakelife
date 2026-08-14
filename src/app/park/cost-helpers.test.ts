import { describe, it, expect } from "vitest";
import {
  allocateCost, allocationSummary, recoveryByCategory,
  type CostLot, type CostCategory, canSplit, whyNotSplit,
  carriedLine,
  buildCostScheduleRow, SCHEDULABLE_CATEGORIES, type CostScheduleInput,

  carryFromRow,} from "./cost-helpers";

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

describe("who pays, and who carries the rest", () => {
  // THE DENOMINATOR IS EVERY RENTABLE LOT. $380 / 21 = $18.09 each (floored),
  // 19 payers = $343.71, and the park carries $36.29 for its two empties.
  // This test used to assert $20.00 each and $0.00 carried — dividing by the
  // 19 OCCUPIED lots, which quietly made vacancy the neighbours' problem.
  it("divides by every rentable lot, not just the occupied ones", () => {
    const a = allocateCost({ amountPaid: 380, method: "per_lot", lots: HAVEN });
    expect(a.denominatorLots).toBe(21);
    expect(a.payerLots).toBe(19);
    expect(a.shares).toHaveLength(19);
    expect(a.shares[0].amount).toBe(18.09);
    expect(a.allocated).toBe(343.71);
    expect(a.parkAbsorbs).toBe(36.29);
  });

  // THE ONE THE RESIDENT NOTICES. Same bill, same month, same water — four
  // neighbours leave. Under the old divisor their share went $60.00 -> $76.00.
  it("does not move a household's share when their neighbours leave", () => {
    const full = allocateCost({ amountPaid: 1140, method: "per_lot", lots: HAVEN });
    const emptier = allocateCost({
      amountPaid: 1140, method: "per_lot",
      lots: HAVEN.map((l, i) => (i < 4 ? { ...l, reservationId: null } : l)),
    });
    expect(full.shares[0].amount).toBe(54.28);
    expect(emptier.shares[0].amount).toBe(54.28);
    // The difference lands on the park, which is where the risk sits.
    expect(full.parkAbsorbs).toBe(108.68);
    expect(emptier.parkAbsorbs).toBe(325.8);
  });

  // The old version of this asserted only `parkAbsorbs > 0`, which passed for
  // a ONE-CENT rounding reason while the vacancy cost was in fact zero. That
  // looseness is how the bug survived being tested.
  it("carries exactly the empty lots' share, not a rounding crumb", () => {
    const a = allocateCost({ amountPaid: 210, method: "per_lot", lots: HAVEN });
    expect(a.shares[0].amount).toBe(10);
    expect(a.allocated).toBe(190);
    expect(a.parkAbsorbs).toBe(20);       // 2 empty lots x $10, to the penny
    expect(a.vacantCount).toBe(2);
  });

  it("charges a vacant lot nothing at all", () => {
    const a = allocateCost({ amountPaid: 100, method: "per_lot", lots: HAVEN });
    const ids = a.shares.map((s) => s.lotId);
    expect(ids).not.toContain("l3");
    expect(ids).not.toContain("l22");
  });

  // A HOME THE PARK OWNS IS IN THE DENOMINATOR AND NEVER A PAYER. Its guests
  // use the well; a three-night guest is not sent a month of park water. So
  // the park carries it — which is what stops the long-term residents
  // subsidising the short-term business.
  it("counts a park-owned home in the divisor but never bills it", () => {
    const withStr: CostLot[] = [
      ...HAVEN,
      { lotId: "str1", lotNumber: "30", reservationId: "g1", parkOwned: true },
      { lotId: "str2", lotNumber: "31", reservationId: "g2", parkOwned: true },
    ];
    const a = allocateCost({ amountPaid: 1150, method: "per_lot", lots: withStr });
    expect(a.denominatorLots).toBe(23);
    expect(a.payerLots).toBe(19);
    expect(a.shares.map((x) => x.lotId)).not.toContain("str1");
    expect(a.shares[0].amount).toBe(50);          // 1150 / 23
    expect(a.parkAbsorbs).toBe(200);              // 4 lots x $50
  });

  // A pad that is planned, being renovated or retired has no pedestal to
  // serve, so it cannot dilute anybody's share.
  it("leaves lots that are not rentable out of the divisor entirely", () => {
    const withDead: CostLot[] = [
      ...HAVEN,
      { lotId: "d1", lotNumber: "40", reservationId: null, rentable: false },
      { lotId: "d2", lotNumber: "41", reservationId: null, rentable: false },
    ];
    const a = allocateCost({ amountPaid: 380, method: "per_lot", lots: withDead });
    expect(a.denominatorLots).toBe(21);
    expect(a.shares[0].amount).toBe(18.09);
  });

  // NOT AN ERROR ANY MORE. The bill is real and the park carries all of it —
  // which is the sentence he most needs on a park nobody lives in yet.
  it("records the bill and carries all of it when nobody is on a lot", () => {
    const a = allocateCost({
      amountPaid: 100, method: "per_lot",
      lots: [{ lotId: "x", lotNumber: "1", reservationId: null }],
    });
    expect(a.problem).toBeUndefined();
    expect(a.shares).toHaveLength(0);
    expect(a.parkAbsorbs).toBe(100);
  });

  // Having nothing to divide BY is still a refusal.
  it("refuses when there is no rentable lot at all", () => {
    const a = allocateCost({
      amountPaid: 100, method: "per_lot",
      lots: [{ lotId: "x", lotNumber: "1", reservationId: null, rentable: false }],
    });
    expect(a.problem).toBe("no_rentable_lots");
    expect(a.parkAbsorbs).toBe(100);
  });

  it("REFUSES a metered split with no readings rather than quietly splitting evenly", () => {
    const a = allocateCost({
      amountPaid: 100, method: "metered",
      lots: [{ lotId: "a", lotNumber: "1", reservationId: "r1", reading: 0 }],
    });
    expect(a.problem).toBe("no_readings");
    expect(a.shares).toHaveLength(0);
  });

  it("records a basis a resident can read, naming the denominator", () => {
    const a = allocateCost({ amountPaid: 380, method: "per_lot", lots: HAVEN });
    expect(a.shares[0].basis).toBe("1 of 21 rentable lots");
  });
});

describe("what the owner reads", () => {
  it("names the divisor he can walk the park and count", () => {
    const a = allocateCost({ amountPaid: 400, method: "per_lot", lots: HAVEN });
    expect(allocationSummary(a, "water")).toBe(
      "Water: $19.04 each across 19 of 21 rentable lots. You carry $38.24 — 2 empty lots.",
    );
  });

  it("says plainly that he carries the lot when nobody is on it", () => {
    const a = allocateCost({
      amountPaid: 100, method: "per_lot",
      lots: [{ lotId: "x", lotNumber: "1", reservationId: null }],
    });
    expect(allocationSummary(a, "water")).toBe(
      "Water: nobody is on a lot, so you carry all $100.00 — 1 rentable lot.",
    );
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

describe("what the park carried", () => {
  /**
   * 0112 wrote park_absorbed / denominator_lots / payer_lots and NOTHING read
   * them. The row said "$343.71 across 19 lots" — true, and it hides both the
   * 21-lot denominator and the $36.29 the owner paid for the two empty pads.
   * He saw that figure once, in the preview before saving, and never again.
   */
  const HAVEN = {
    allocatedTotal: 343.71, amountPaid: 380,
    absorbed: 36.29, denominatorLots: 21, payerLots: 19,
    carry: "split" as const,
  };

  it("names the denominator, the payers, and the money", () => {
    const line = carriedLine(HAVEN);
    expect(line).toContain("$343.71");
    expect(line).toContain("19 of 21");
    expect(line).toContain("$36.29");
  });

  it("adds up: what was split plus what he carried is what he paid", () => {
    expect(HAVEN.allocatedTotal + HAVEN.absorbed).toBeCloseTo(HAVEN.amountPaid, 2);
  });

  it("says nothing about dollars for a row with no snapshot", () => {
    // THE ONE THAT MATTERS. `park_absorbed` is NOT NULL DEFAULT 0, so a bill
    // written before 0112 reads exactly 0.00 — indistinguishable from a bill
    // that genuinely recovered in full if you test on the amount. Announcing
    // "$0.00 carried" about something nobody measured is the confident wrong
    // number this whole module exists to avoid.
    const line = carriedLine({
      ...HAVEN, absorbed: null, denominatorLots: null, payerLots: null,
      carry: "unrecorded",
    });
    expect(line).not.toMatch(/\$/);
    expect(line).toContain("can't say");
  });

  it("explains a bill a fee already covers instead of calling it unsplit", () => {
    const line = carriedLine({
      allocatedTotal: 0, amountPaid: 380, absorbed: 380,
      denominatorLots: null, payerLots: null, carry: "covered_by_fee",
    });
    expect(line).toContain("already covers");
    expect(line).not.toContain("carried nothing");
  });

  it("puts the thousands separator in, like the rest of the screen", () => {
    // Rendered "$1433.17" directly under a column reading "$1,433.17".
    const line = carriedLine({
      allocatedTotal: 0, amountPaid: 1433.17, absorbed: 1433.17,
      denominatorLots: 21, payerLots: 0, carry: "split",
    });
    expect(line).toContain("$1,433.17");
  });

  it("says he carried all of it when there was nobody to bill", () => {
    const line = carriedLine({
      allocatedTotal: 0, amountPaid: 380, absorbed: 380,
      denominatorLots: 21, payerLots: 0, carry: "split",
    });
    expect(line).toContain("nobody to bill");
    expect(line).toContain("$380.00");
  });

  it("says he carried nothing when every lot paid", () => {
    const line = carriedLine({
      allocatedTotal: 380, amountPaid: 380, absorbed: 0,
      denominatorLots: 21, payerLots: 21, carry: "split",
    });
    expect(line).toContain("all 21 lots");
    expect(line).toContain("carried nothing");
  });

  it("counts unmeasured rows instead of totalling them as zero", () => {
    const r = recoveryByCategory([
      { category: "water", amountPaid: 380, allocatedTotal: 343.71, billedTotal: 343.71, absorbed: 36.29 },
      { category: "water", amountPaid: 400, allocatedTotal: 400, billedTotal: 400, absorbed: null },
    ]);
    expect(r.absorbed).toBeCloseTo(36.29, 2);
    // Not 0 — a count, so the screen can say the total is understated.
    expect(r.absorbedUnknown).toBe(1);
  });

  it("leaves `net` alone — absorbed decomposes paid, not billed", () => {
    const r = recoveryByCategory([
      { category: "water", amountPaid: 380, allocatedTotal: 343.71, billedTotal: 343.71, absorbed: 36.29 },
    ]);
    expect(r.net).toBeCloseTo(343.71 - 380, 2);
  });
});

describe("a reminder for a bill that arrives every month", () => {
  /**
   * 0114 created park_cost_schedules, /park/today read it, and NOTHING wrote a
   * row — so the list was empty for every park and always would be. These pin
   * the validator that now stands between the form and the table, including the
   * two categories 0117 refuses at the database.
   */
  const input = (over: Partial<CostScheduleInput> = {}): CostScheduleInput => ({
    category: "sewer", dueDay: "5", typicalAmount: "1430", label: "", ...over,
  });

  it("builds the row the reader expects", () => {
    const r = buildCostScheduleRow(input());
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({
      category: "sewer", due_day: 5, typical_amount: 1430,
      label: null, cadence: "monthly", active: true,
    });
  });

  it("refuses a day February does not have, in a sentence", () => {
    // The DB CHECK would refuse 31 too; this is so he reads English, not a
    // constraint name.
    const r = buildCostScheduleRow(input({ dueDay: "31" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("February");
  });

  it("takes a blank amount and refuses a zero one", () => {
    // Blank is an honest "I don't know yet". Zero is not an amount, and the
    // column's CHECK agrees.
    expect(buildCostScheduleRow(input({ typicalAmount: "" })).row?.typical_amount).toBe(null);
    expect(buildCostScheduleRow(input({ typicalAmount: "0" })).ok).toBe(false);
  });

  it("strips the dollar sign and commas a person actually types", () => {
    expect(buildCostScheduleRow(input({ typicalAmount: "$1,430.17" })).row?.typical_amount).toBe(1430.17);
  });

  it("refuses unit_electric — recordCost would refuse the bill it asks for", () => {
    // A reminder pointing at /park/costs, where the category is not in the
    // dropdown and the action declines it, is a door that does not open.
    const r = buildCostScheduleRow(input({ category: "unit_electric" }));
    expect(r.ok).toBe(false);
    expect(canSplit("unit_electric")).toBe(false);
  });

  it("refuses 'other' — two of them would satisfy each other's reminder", () => {
    // One active row per category. The property tax and the insurance binder
    // would share a single reminder, and either would clear it.
    expect(buildCostScheduleRow(input({ category: "other" })).ok).toBe(false);
  });

  it("only offers categories recordCost can actually write", () => {
    // The invariant behind 0117: if these ever drift, the reminder leads
    // somewhere the costs screen cannot follow.
    for (const c of SCHEDULABLE_CATEGORIES) {
      expect(canSplit(c)).toBe(true);
      expect(buildCostScheduleRow(input({ category: c })).ok).toBe(true);
    }
  });

  it("keeps a long name out of the table", () => {
    expect(buildCostScheduleRow(input({ label: "x".repeat(61) })).ok).toBe(false);
    expect(buildCostScheduleRow(input({ label: "  LaGrange County sewer  " })).row?.label)
      .toBe("LaGrange County sewer");
  });
});

describe("a cost the park carries on purpose", () => {
  /**
   * THE HAVEN COMES WITH A BOAT, and it is bookable by short-stay guests only.
   * Winterizing it is a cost of the nightly business, not of living on lot 14.
   * Before 0118 it would have been entered as `other` — which `canSplit`
   * allows — and divided across all twenty-one rentable lots, billing nineteen
   * households a share of a boat they cannot book.
   */
  it("reads park_only off the row rather than guessing from the numbers", () => {
    expect(carryFromRow({ allocation_method: "park_only", denominator_lots: null, park_absorbed: 640 }))
      .toBe("park_only");
  });

  it("says it is his, without calling it a failure to split", () => {
    const line = carriedLine({
      allocatedTotal: 0, amountPaid: 640, absorbed: 640,
      denominatorLots: null, payerLots: null, carry: "park_only",
    });
    expect(line).toContain("$640.00");
    expect(line).toContain("carrying this one");
    expect(line).not.toContain("nobody to bill");   // that is a different fact
  });

  it("tells a fee-covered bill from one recorded before we tracked any of it", () => {
    // THE INFERENCE THIS REPLACES. Both shapes have a NULL denominator; the old
    // code separated them by asking whether park_absorbed was above zero, which
    // collides on a $0 bill and says nothing about intent.
    expect(carryFromRow({ allocation_method: "fee_covered", denominator_lots: null, park_absorbed: 380 }))
      .toBe("covered_by_fee");
    expect(carryFromRow({ allocation_method: "per_lot", denominator_lots: null, park_absorbed: 0 }))
      .toBe("unrecorded");
    // The case that used to be ambiguous: a $0 fee-covered bill.
    expect(carryFromRow({ allocation_method: "fee_covered", denominator_lots: null, park_absorbed: 0 }))
      .toBe("covered_by_fee");
  });

  it("still calls a real split a split", () => {
    expect(carryFromRow({ allocation_method: "per_lot", denominator_lots: 21, park_absorbed: 36.29 }))
      .toBe("split");
  });

  it("defaults a row with no method at all to the old inference", () => {
    // Rows predate the column's meaning; absent must not become "park_only".
    expect(carryFromRow({ denominator_lots: 21, park_absorbed: 0 })).toBe("split");
    expect(carryFromRow({ denominator_lots: null, park_absorbed: 0 })).toBe("unrecorded");
  });
});
