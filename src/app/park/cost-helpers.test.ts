import { describe, it, expect } from "vitest";
import {
  costCategoryForService, COST_CATEGORY_LABEL,
  allocateCost, allocationSummary, recoveryByCategory,
  type CostLot, type CostCategory, canSplit, whyNotSplit,
  carriedLine,
  buildCostScheduleRow, SCHEDULABLE_CATEGORIES, type CostScheduleInput,
  carryFromRow, billPeriod,
} from "./cost-helpers";
import { addDays } from "./today-helpers";
import { overlaps } from "@/lib/parks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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
    category: "sewer", cadence: "monthly", dueMonth: "",
    dueDay: "5", typicalAmount: "1430", label: "", ...over,
  });

  it("builds the row the reader expects", () => {
    const r = buildCostScheduleRow(input());
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({
      category: "sewer", due_day: 5, due_month: null, typical_amount: 1430,
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

describe("the audit's confirmed wrong numbers", () => {
  /**
   * Six independent lenses, each finding adversarially refuted by three
   * skeptics. These are the ones that survived.
   */

  it("does not blame a rounding remainder on lots that are all let", () => {
    // allocateCost floors each share to the cent on purpose, so a bill that
    // does not divide evenly leaves the park a few cents even at FULL
    // occupancy. The old sentence read "you carried $0.13 for the 0 with
    // nobody in them" — a vacancy explanation for arithmetic.
    const line = carriedLine({
      allocatedTotal: 1433.04, amountPaid: 1433.17, absorbed: 0.13,
      denominatorLots: 21, payerLots: 21, carry: "split",
    });
    expect(line).not.toContain("the 0 with");
    expect(line).toContain("wouldn't divide evenly");
    expect(line).toContain("$0.13");
  });

  it("keeps a park-carried and a fee-covered bill out of the vacancy total", () => {
    // THE ONE THAT MATTERED MOST. park_absorbed on those rows is the WHOLE
    // bill, not a share of empty pads — so the guest boat and a fee-covered
    // mow were being totalled under "you carried for the empty lots", the
    // number he uses to judge what vacancy costs him.
    const asListCostsSends = (absorbed: number, carry: string) =>
      ({ category: "water" as const, amountPaid: 640, allocatedTotal: 0, billedTotal: 0,
         absorbed: carry === "split" ? absorbed : 0 });

    const r = recoveryByCategory([
      { category: "water", amountPaid: 380, allocatedTotal: 343.71, billedTotal: 343.71, absorbed: 36.29 },
      asListCostsSends(640, "park_only"),      // the guest boat
      asListCostsSends(658, "covered_by_fee"), // a mow the grounds fee covers
    ]);
    expect(r.absorbed).toBeCloseTo(36.29, 2);   // was $1,334.29
    expect(r.absorbedUnknown).toBe(0);
  });

  it("still counts a row with no snapshot as unknown, not as zero", () => {
    const r = recoveryByCategory([
      { category: "water", amountPaid: 400, allocatedTotal: 400, billedTotal: 400, absorbed: null },
    ]);
    expect(r.absorbed).toBe(0);
    expect(r.absorbedUnknown).toBe(1);
  });
});

describe("bills that don't come every month", () => {
  /**
   * 0114 allowed one cadence. The Haven's biggest non-sewer bills are annual —
   * property tax $3,559, insurance $797 — and the trash invoice is quarterly.
   * The whole point of `billPeriod` is that a task keyed on the calendar month
   * nags twelve times a year about a bill that arrives once.
   */

  it("gives a monthly bill the month", () => {
    const p = billPeriod("monthly", null, 5, "2026-08-14");
    expect(p.key).toBe("2026-08");
    expect(p.label).toBe("August 2026");
    expect(p.dueOn).toBe("2026-08-05");
    expect([p.from, p.to]).toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("rolls a monthly window over the year end", () => {
    const p = billPeriod("monthly", null, 5, "2026-12-20");
    expect([p.from, p.to]).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it("gives an annual bill ONE key for the whole year", () => {
    // The property tax lands in November. Asked in March, in November and in
    // December, it must be the SAME task — otherwise it is twelve tasks.
    const march = billPeriod("annual", 11, 10, "2026-03-02");
    const nov = billPeriod("annual", 11, 10, "2026-11-30");
    const dec = billPeriod("annual", 11, 10, "2026-12-31");
    expect(march.key).toBe("2026");
    expect(nov.key).toBe("2026");
    expect(dec.key).toBe("2026");
    expect(nov.label).toBe("2026");
    expect(nov.dueOn).toBe("2026-11-10");
    // ...and the window is the whole year, so a bill entered in December
    // still answers November's reminder.
    expect([nov.from, nov.to]).toEqual(["2026-01-01", "2027-01-01"]);
  });

  it("starts a new task in the new year", () => {
    expect(billPeriod("annual", 11, 10, "2027-01-02").key).toBe("2027");
  });

  it("anchors a quarterly cycle to the month it starts in", () => {
    // Trash, first invoice in February: Feb, May, Aug, Nov.
    const feb = billPeriod("quarterly", 2, 10, "2026-02-14");
    const mar = billPeriod("quarterly", 2, 10, "2026-03-31");
    const apr = billPeriod("quarterly", 2, 10, "2026-04-01");
    const may = billPeriod("quarterly", 2, 10, "2026-05-01");

    // February, March and April are ONE quarter — one task, one key.
    expect(feb.key).toBe(mar.key);
    expect(mar.key).toBe(apr.key);
    expect([feb.from, feb.to]).toEqual(["2026-02-01", "2026-05-01"]);
    // May starts the next one.
    expect(may.key).not.toBe(feb.key);
    expect([may.from, may.to]).toEqual(["2026-05-01", "2026-08-01"]);
  });

  it("rolls a quarterly window backwards over the year end", () => {
    // Anchored to February, January belongs to the November quarter.
    const jan = billPeriod("quarterly", 2, 10, "2027-01-15");
    expect([jan.from, jan.to]).toEqual(["2026-11-01", "2027-02-01"]);
  });

  it("never asks for a day February does not have", () => {
    // The column caps at 28 and so does this — a due day of 31 must not
    // produce 2026-02-31, which is not a date.
    expect(billPeriod("monthly", null, 31, "2026-02-10").dueOn).toBe("2026-02-28");
    expect(billPeriod("annual", 2, 31, "2026-06-10").dueOn).toBe("2026-02-28");
  });

  it("survives a leap year", () => {
    expect(billPeriod("monthly", null, 28, "2028-02-29").dueOn).toBe("2028-02-28");
    expect(billPeriod("monthly", null, 5, "2028-02-29").key).toBe("2028-02");
  });
});

describe("saying how often a bill comes", () => {
  const base = { category: "tax", dueDay: "10", typicalAmount: "", label: "" };

  it("takes the property tax once a year, in its month", () => {
    const r = buildCostScheduleRow({ ...base, cadence: "annual", dueMonth: "11" });
    expect(r.ok).toBe(true);
    expect(r.row).toMatchObject({ category: "tax", cadence: "annual", due_month: 11, due_day: 10 });
  });

  it("refuses an annual bill with no month — that is a shrug, not a reminder", () => {
    const r = buildCostScheduleRow({ ...base, cadence: "annual", dueMonth: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Which month");
  });

  it("refuses a month on a monthly bill", () => {
    // Every month is the month; storing one would be a fact with two readings.
    const r = buildCostScheduleRow({ ...base, cadence: "monthly", dueMonth: "3" });
    expect(r.ok).toBe(false);
  });

  it("refuses a cadence nobody wrote a reader for", () => {
    expect(buildCostScheduleRow({ ...base, cadence: "fortnightly", dueMonth: "1" }).ok).toBe(false);
  });

  it("lets tax and insurance be scheduled at all, which they could not be", () => {
    // They lived in `other`, and one reminder slot per category meant the tax
    // bill and the insurance premium could not both be watched for.
    for (const c of ["tax", "insurance"]) {
      expect(SCHEDULABLE_CATEGORIES).toContain(c);
      expect(buildCostScheduleRow({ ...base, category: c, cadence: "annual", dueMonth: "6" }).ok).toBe(true);
      expect(canSplit(c as never)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the one-tap 'pass this on' period", () => {
  /**
   * `billableParkJobs` builds the two dates that `ParkCosts.fillFrom` submits
   * with no chance to edit them. It used to end the period ON the job date,
   * which is wrong twice over under half-open ranges:
   *
   *   * a job on the 1st gave start === end — an empty range that recordCost
   *     refuses, so the button was permanently dead for that job
   *   * every other job excluded the day the work happened
   *
   * The builder is inside a server action, so this pins the arithmetic it uses
   * and the guard that rejected the degenerate case.
   */
  const periodFor = (date: string) => ({
    periodStart: `${date.slice(0, 7)}-01`,
    periodEnd: addDays(date, 1),
  });

  it("a job on the 1st is no longer an empty period", () => {
    const p = periodFor("2027-03-01");
    expect(p).toEqual({ periodStart: "2027-03-01", periodEnd: "2027-03-02" });
    expect(p.periodEnd > p.periodStart).toBe(true);
  });

  it("the old shape is exactly what recordCost refuses", () => {
    // start === end, the condition behind "The period has to end after it starts"
    expect("2027-03-01" > "2027-03-01").toBe(false);
  });

  it("covers the day the work happened", () => {
    const p = periodFor("2027-03-15");
    // Half-open: a tenancy starting the morning of the mow overlaps only if
    // the period runs past it.
    expect(overlaps({ start: "2027-03-15", end: "2027-04-15" }, { start: p.periodStart, end: p.periodEnd })).toBe(true);
    // and the old end date did not
    expect(overlaps({ start: "2027-03-15", end: "2027-04-15" }, { start: p.periodStart, end: "2027-03-15" })).toBe(false);
  });

  it("crosses a month end correctly", () => {
    expect(periodFor("2027-01-31")).toEqual({ periodStart: "2027-01-01", periodEnd: "2027-02-01" });
    expect(periodFor("2028-02-29")).toEqual({ periodStart: "2028-02-01", periodEnd: "2028-03-01" });
  });

  it("the builder really uses this shape", () => {
    const src = readFileSync(
      join(__dirname, "cost-actions.ts"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain("periodEnd: addDays(date, 1)");
    expect(src).not.toMatch(/periodEnd: date,/);
  });
});

describe("a park job files itself under the work it actually was", () => {
  /**
   * 0144 ADDED `snow` SO A BILL COULD CARRY IT, AND MISSED THE FIFTH LIST.
   *
   * Its own commit says the point was making snow "mean the same thing in all
   * four places", and warns that "a category nothing can file is a column with
   * no writer." It widened both dropdowns, the label map and the fee vocabulary
   * — and left the ONE-TAP writer passing a hardcoded literal:
   *
   *     recordCost(parkId, "grounds", j.periodStart, ...)
   *
   * That button is the path the screen pushes hardest ("nothing to retype"), and
   * `BillableParkJob` carries the service NAME but no category, so every park
   * job filed through it — a mow, a leaf haul, a whole-park plough — was
   * recorded as `grounds`.
   *
   * WHY THAT IS MONEY, not tidiness. The Haven's only active fee is the $142.53
   * Grounds fee, and its `covers` array is
   *   [water, sewer, trash, common_electric, grounds, other]
   * — `grounds` yes, `snow` NO. `recordCost` asks `feeCovering(parkId, category)`:
   * a hit writes allocation_method 'fee_covered', park_absorbed = the whole
   * amount, and NO lot_cost_shares. So every plough all winter is absorbed
   * 100% by the park. Typing the same bill into the form below and choosing
   * "Snow clearing" finds no covering fee and splits it across 21 households.
   * One tap versus one dropdown.
   *
   * And it silences the warning he most needs: `checkCoverage` reports
   * categories the park pays for that NO fee claims. Snow filed as grounds can
   * never appear there — on the screen built to answer "is my $142.53 right?",
   * weeks before that number goes into twenty leases.
   */
  it("sends a whole-park plough to snow, not grounds", () => {
    expect(costCategoryForService("Snow clearing — roads & common drives")).toBe("snow");
  });

  it("keeps mowing and the two cleanups on grounds", () => {
    for (const name of [
      "Park grounds mowing & trim",
      "Common-area spring cleanup",
      "Common-area fall cleanup & leaf haul",
    ]) {
      expect(costCategoryForService(name), name).toBe("grounds");
    }
  });

  it("files a pier or a lift as other, which is where the park's own pier bill already sits", () => {
    // A park can buy these too (park_bookable). There is no pier category, and
    // the existing Haven park_costs row for the pier says so in its own note.
    for (const name of ["Pier install / removal", "Boat lift set / pull", "PWC lift set / pull"]) {
      expect(costCategoryForService(name), name).toBe("other");
    }
  });

  it("never guesses a service it has not been taught", () => {
    // `other` and `grounds` are BOTH covered by The Haven's fee, so either
    // default would be absorbed — the difference is that `other` does not
    // claim the bill was groundskeeping. The screen names the category on the
    // button, so a wrong guess is visible before it is committed.
    expect(costCategoryForService("Something we added next year")).toBe("other");
    expect(costCategoryForService("")).toBe("other");
  });

  it("only ever returns a category the database will accept", () => {
    const legal: CostCategory[] = [
      "water", "sewer", "trash", "common_electric", "grounds", "snow",
      "unit_electric", "other", "tax", "insurance",
    ];
    for (const name of [
      "Snow clearing — roads & common drives", "Park grounds mowing & trim",
      "Common-area spring cleanup", "Common-area fall cleanup & leaf haul",
      "Pier install / removal", "anything at all",
    ]) {
      expect(legal, name).toContain(costCategoryForService(name));
    }
  });
});

describe("the one-tap button asks the mapper, and says what it is filing", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkCosts.tsx", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("no longer passes a hardcoded category", () => {
    const fn = src.match(/function fillFrom[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(fn, "fillFrom is gone — this scan measures nothing").not.toBe("");
    expect(fn, 'every park job is still filed as "grounds", whatever it was')
      .not.toMatch(/recordCost\(\s*\n?\s*parkId,\s*"grounds"/);
    expect(fn, "nothing derives the category from the service").toMatch(/costCategoryForService\(/);
  });

  it("names the category on the button, so a wrong guess is visible first", () => {
    // The mapping cannot know a service added next year. Printing what it is
    // about to file turns a silent misfiling into something he can see.
    expect(src, "the button still says only 'Split across the lots'")
      .toMatch(/COST_CATEGORY_LABEL\[/);
  });
});
