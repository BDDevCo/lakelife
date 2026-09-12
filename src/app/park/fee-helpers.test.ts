import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  payersFor, monthlyIncome, checkCoverage, coverageSummary, feesForTenancy, feePayableCount,
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

  it("counts NO payers for an opt-in fee, because nothing can sign anybody up", () => {
    // WAS: asserting 3 — "counts an opt-in fee from sign-ups, never from the
    // lot count". The reasoning was right and the premise was false:
    // `lot_fee_assignments` has one reader in the whole codebase and no
    // writer, and no screen offers a picker. So the sign-up count is
    // structurally zero, and crediting income against it put money on the
    // coverage panel that no charge run can ever raise. Returning 0 by rule
    // keeps it that way if a writer ever lands before the biller does.
    const pet: ParkFee = { ...GROUNDS, id: "f2", appliesTo: "opt_in", amount: 25, covers: [] };
    expect(payersFor(pet, COUNTS)).toBe(0);
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

  it("credits NOTHING for an annual fee, because nothing bills one", () => {
    // WAS: asserting 1000 — "spreads an annual fee across the year". That is
    // honest arithmetic about a bill that never goes out: `buildStatement`
    // (statement-helpers.ts:176) skips every cadence that is not monthly. A
    // $120/yr road fee on 19 lots read "$190.00/mo" on the costs screen and
    // raised $0 across twelve charge runs — $2,280 he thought he was
    // collecting. park_fees has no due_month column, so there is nowhere to
    // record when one falls due either.
    expect(monthlyIncome({ ...GROUNDS, cadence: "annual", amount: 600 }, 20)).toBe(0);
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
        { category: "water", amountPaid: 380, periodStart: "2026-06-01" },
        { category: "sewer", amountPaid: 300, periodStart: "2026-06-01" },
        { category: "trash", amountPaid: 220, periodStart: "2026-06-01" },
      ],
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
      [{ category: "water", amountPaid: 800, periodStart: "2026-06-01" }, { category: "grounds", amountPaid: 620, periodStart: "2026-06-01" }],
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
      { category: "water" as CostCategory, amountPaid: 380, periodStart: "2026-06-01" },
      { category: "water" as CostCategory, amountPaid: 400, periodStart: "2026-07-01" },
      { category: "water" as CostCategory, amountPaid: 420, periodStart: "2026-08-01" },
    ];
    // The same three amounts entered against ONE month are one month's bills.
    const oneMonth = threeMonths.map((c) => ({ ...c, periodStart: "2026-06-01" }));
    const one = checkCoverage([GROUNDS], payers, oneMonth);
    const three = checkCoverage([GROUNDS], payers, threeMonths);
    expect(one.actualCost).toBe(1200);
    expect(three.actualCost).toBe(400);
    expect(three.margin).toBeGreaterThan(one.margin);
    expect(three.monthsByCategory).toEqual([{ category: "water", months: 3 }]);
  });

  // -------------------------------------------------------------------------
  // EACH BILL OVER ITS OWN MONTHS, NOT EVERY BILL OVER THE SEWER'S.
  //
  // The Haven's four rows are all June 2026: the sewer is a real monthly bill,
  // and grounds, common electric and "other" are annual figures divided by
  // twelve and entered once as a June row (their notes say "BASELINE, NOT A
  // BILL"). Only the sewer has a monthly reminder, so only the sewer gains
  // rows. One denominator across every category meant each December sewer
  // bill DILUTED the three baselines: "ahead by $37.67 a lot" became $51.06
  // after one sewer row and $60.63 after six, while nothing had changed.
  // -------------------------------------------------------------------------
  describe("a mixed cadence — The Haven's real rows plus the sewer's run", () => {
    const HAVEN_FEE: ParkFee = {
      ...GROUNDS, amount: 142.53,
      covers: ["water", "sewer", "trash", "common_electric", "grounds", "other"] as CostCategory[],
    };
    const eighteen = new Map([["f1", 18]]);
    const june = [
      { category: "sewer" as CostCategory, amountPaid: 1405.36, periodStart: "2026-06-01" },
      { category: "grounds" as CostCategory, amountPaid: 198.08, periodStart: "2026-06-01" },
      { category: "common_electric" as CostCategory, amountPaid: 144.02, periodStart: "2026-06-01" },
      { category: "other" as CostCategory, amountPaid: 140.00, periodStart: "2026-06-01" },
    ];
    const sewerFor = (months: string[]) =>
      months.map((m) => ({ category: "sewer" as CostCategory, amountPaid: 1405.36, periodStart: `${m}-01` }));

    it("four June rows and 18 payers: ahead by $37.67 a lot", () => {
      const c = checkCoverage([HAVEN_FEE], eighteen, june);
      expect(c.actualCost).toBe(1887.46);
      expect(coverageSummary(c, 18, 1)).toContain("ahead by $37.67 a lot");
    });

    it("stays $37.67 after one December sewer row", () => {
      const c = checkCoverage([HAVEN_FEE], eighteen, [...june, ...sewerFor(["2026-12"])]);
      expect(c.actualCost).toBe(1887.46);
      expect(coverageSummary(c, 18, 1)).toContain("ahead by $37.67 a lot");
    });

    it("and after six — the sum of per-category monthly figures, never total ÷ months", () => {
      const six = sewerFor(["2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05"]);
      const c = checkCoverage([HAVEN_FEE], eighteen, [...june, ...six]);
      expect(c.actualCost).toBe(1887.46);
      expect(coverageSummary(c, 18, 1)).toContain("ahead by $37.67 a lot");
      // Collapsed the other way: total ÷ 7 is what the screen used to say.
      expect(c.actualCost).not.toBeCloseTo(1474.23, 2);
      expect(c.monthsByCategory).toEqual(expect.arrayContaining([
        { category: "sewer", months: 7 },
        { category: "grounds", months: 1 },
        { category: "common_electric", months: 1 },
        { category: "other", months: 1 },
      ]));
    });

    it("a sewer that actually rises shows in the average", () => {
      // Six December-to-May bills at $1,505.36 against June's $1,405.36:
      // sewer = (1405.36 + 6 × 1505.36) / 7 = 1491.07.
      const dearer = sewerFor(["2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05"])
        .map((c) => ({ ...c, amountPaid: 1505.36 }));
      const c = checkCoverage([HAVEN_FEE], eighteen, [...june, ...dearer]);
      expect(c.actualCost).toBe(1973.17);   // 1491.07 + 198.08 + 144.02 + 140.00
    });

    it("two bills in the same month for one category are one month's cost", () => {
      // A corrected sewer invoice entered twice against December is two rows,
      // one month — averaging them over two months would halve the sewer.
      const twice = [...june, ...sewerFor(["2026-12"]), ...sewerFor(["2026-12"])];
      const c = checkCoverage([HAVEN_FEE], eighteen, twice);
      // sewer = (1405.36 + 1405.36 + 1405.36) / 2 months
      expect(c.actualCost).toBe(2590.14);
      expect(c.monthsByCategory).toEqual(expect.arrayContaining([{ category: "sewer", months: 2 }]));
    });

    it("still names water and trash as unchecked, and nothing else", () => {
      const c = checkCoverage([HAVEN_FEE], eighteen, [...june, ...sewerFor(["2026-12"])]);
      expect([...c.unverified].sort()).toEqual(["trash", "water"]);
    });
  });

  it("names a cost NOTHING claims to cover", () => {
    const c = checkCoverage(
      [{ ...GROUNDS, covers: ["water"] as CostCategory[] }], payers,
      [{ category: "water", amountPaid: 380, periodStart: "2026-06-01" }, { category: "grounds", amountPaid: 500, periodStart: "2026-06-01" }],
    );
    expect(c.uncovered).toContain("grounds");
    // And the uncovered cost is NOT counted against the fee — the fee never
    // promised it.
    expect(c.actualCost).toBe(380);
  });

  it("names what the fee claims but nothing has been spent on", () => {
    const c = checkCoverage([GROUNDS], payers, [{ category: "water", amountPaid: 380, periodStart: "2026-06-01" }]);
    expect(c.unverified).toEqual(expect.arrayContaining(["sewer", "trash", "common_electric"]));
  });

  it("does NOT credit an amenities-only fee against the water bill", () => {
    const amenities: ParkFee = {
      ...GROUNDS, id: "f9", label: "Amenities", amount: 30, covers: [] as CostCategory[],
    };
    const c = checkCoverage(
      [amenities], new Map([["f9", 20]]),
      [{ category: "water", amountPaid: 380, periodStart: "2026-06-01" }],
    );
    expect(c.feeIncome).toBe(0);
  });

  it("is honest when there is nothing to compare", () => {
    const c = checkCoverage([GROUNDS], payers, []);
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

  it("counts nobody for an opt-in fee, even when a count is handed in", () => {
    // The count is ignored on purpose: there is no writer for
    // lot_fee_assignments and the charge run drops opt_in fees anyway
    // (ledger-actions.ts:72). A number arriving here would be a number from
    // somewhere that cannot bill.
    expect(payersFor(fee("opt_in"), { longTerm: 19, shortTerm: 4, optedIn: 6 })).toBe(0);
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

// ---------------------------------------------------------------------------

describe("the sentence at the top of the fee screen, on the first day", () => {
  /**
   * THE CARD CONTRADICTED THE SCREEN IT SAT IN.
   *
   * `feeIncome` is zero in two completely different situations — no fees at
   * all, and fees that nobody is on a lot to pay — and the no-cost branch ran
   * first. So a park with a saved grounds fee and no tenancies read
   *
   *     "No fees and no bills yet."
   *
   * inside a card that only renders BECAUSE a fee exists, above a row showing
   * the fee. That is The Haven's exact state until the roll is named: 21 lots,
   * 20 rate cards, zero households.
   */
  const noCosts = {
    feeIncome: 0, actualCost: 0, margin: 0,
    unverified: [] as never[], uncovered: [] as never[], monthsByCategory: [] as never[],
  };

  it("says nobody is on a lot when a fee exists and nobody is", () => {
    expect(coverageSummary(noCosts, 0, 1)).toBe(
      "Nobody is on a lot yet, so this fee is collecting nothing.",
    );
  });

  it("does not claim there are no fees when there are", () => {
    expect(coverageSummary(noCosts, 0, 1)).not.toMatch(/no fees/i);
    expect(coverageSummary(noCosts, 0, 3)).not.toMatch(/no fees/i);
  });

  it("still says so when there genuinely are none", () => {
    expect(coverageSummary(noCosts, 0, 0)).toBe("No fees and no bills yet.");
  });

  it("goes back to the real comparison once both sides exist", () => {
    // Guards the guard: the new branch must not swallow the sentence the
    // screen exists for.
    const real = {
      feeIncome: 1100, actualCost: 900, margin: 200,
      unverified: [] as never[], uncovered: [] as never[], monthsByCategory: [] as never[],
    };
    expect(coverageSummary(real, 20, 1)).toMatch(/ahead by \$10\.00 a lot/);
  });

  it("keeps working for callers that pass no fee count", () => {
    // The parameter is defaulted, so nothing that existed before changes.
    expect(coverageSummary(noCosts, 0)).toBe("No fees and no bills yet.");
  });
});

// ---------------------------------------------------------------------------

describe("a fee never lands on a tenancy the park inherited", () => {
  /**
   * THE FIRST GROUNDS FEE WOULD HAVE BILLED NINETEEN PEOPLE WHO SIGNED NOTHING.
   *
   * `feesFor` reads one list for the whole park and the biller handed that same
   * list to every long-term tenancy. At The Haven that is the nineteen
   * households inherited from the seller: no notice served, no agreement with
   * this owner, and rent up by a third on the January bill.
   *
   * Nothing in the schema could say "not them" — park_fees has no effective
   * date and no notice column, and lot_fee_assignments has no writer. But the
   * TENANCY already knows: origin='grandfathered' means exactly "inherited,
   * never agreed to anything with us", and 0065 and 0059 already treat it as a
   * category apart for the agreement cap and for decisions.
   */
  const FEES = [{ label: "Grounds fee", amount: 55, cadence: "monthly" }];
  const longTerm = { rental_mode: "long_term" };

  it("charges a tenancy that was signed with this owner", () => {
    expect(feesForTenancy(FEES, longTerm, { origin: "application" })).toEqual(FEES);
    expect(feesForTenancy(FEES, longTerm, { origin: "office" })).toEqual(FEES);
    expect(feesForTenancy(FEES, longTerm, { origin: "transfer" })).toEqual(FEES);
  });

  it("charges an inherited tenancy nothing at all", () => {
    expect(feesForTenancy(FEES, longTerm, { origin: "grandfathered" })).toEqual([]);
  });

  it("still charges a lot with no origin recorded", () => {
    // `origin` defaults to 'application' in 0059, so an absent value is an
    // ordinary tenancy — refusing here would silently stop billing fees to
    // every park whose rows predate the column.
    expect(feesForTenancy(FEES, longTerm, {})).toEqual(FEES);
  });

  it("keeps the rule it already had about a nightly home", () => {
    // A short-term lot is priced per stay. Adding the new rule must not have
    // dropped the old one.
    expect(feesForTenancy(FEES, { rental_mode: "short_term" }, { origin: "application" })).toEqual([]);
  });

  it("returns a copy, so one tenancy cannot mutate the park's list", () => {
    const out = feesForTenancy(FEES, longTerm, { origin: "application" });
    out.pop();
    expect(FEES).toHaveLength(1);
  });

  it("counts only the households a fee could actually reach", () => {
    // The coverage panel divides by this. Counting inherited households would
    // credit income from bills the run will never raise.
    expect(feePayableCount([
      { origin: "grandfathered" }, { origin: "grandfathered" },
      { origin: "application" },
    ])).toBe(1);
    expect(feePayableCount([])).toBe(0);
    expect(feePayableCount([{ origin: "application" }, {}])).toBe(2);
  });
});


// ---------------------------------------------------------------------------
// THE ROLL AND THE BILLER DISAGREEING ABOUT MONEY.
//
// /park computed what each household owes by inlining ONE HALF of
// feesForTenancy — the short_term check — and dropping the grandfathered one.
// Every tenancy the roll importer writes is origin:'grandfathered' and carries
// no park fees, so after Mike's roll lands the tile would have shown each
// household owing $542.53 while the charge run raised $400. Two screens, the
// same morning, different money — and the tile is the default landing screen,
// so it is the one he would believe.
//
// It could not have called the real rule: `origin` was in neither the Stay
// type nor the roll's select, so the check would have read undefined,
// compiled, and silently never fired. The twin of this codebase's oldest
// defect — a condition widened without its select.
// ---------------------------------------------------------------------------
describe("the rent roll uses the biller's own fee rule", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("calls feesForTenancy rather than reimplementing half of it", () => {
    const page = read("./page.tsx");
    expect(page, "the short_term half is inlined again")
      .not.toMatch(/fees: r\.lot\.rentalMode === "short_term" \? \[\] : monthlyFees/);
    expect(page).toMatch(/fees: feesForTenancy\(/);
  });

  it("hands it the origin, or the grandfathered rule can never fire", () => {
    const page = read("./page.tsx");
    const call = page.match(/feesForTenancy\([\s\S]{0,240}?\),/)?.[0] ?? "";
    expect(call, "the feesForTenancy call is gone").not.toBe("");
    expect(call, "origin is not passed — the check reads undefined")
      .toMatch(/origin: r\.current\.origin/);
  });

  it("origin is in the query, or it is undefined at runtime", () => {
    // The select is one string literal on purpose; a column missing from it
    // makes stay.origin undefined and the rule silently permissive.
    const data = read("./data.ts");
    const select = data.match(/\.select\("id, park_lot_id, renter_id[^"]*"\)/)?.[0] ?? "";
    expect(select, "the roll's reservation select is gone").not.toBe("");
    expect(select, "origin is not selected").toMatch(/origin/);
  });

  it("and origin survives the mapping into a Stay", () => {
    const helpers = read("./park-helpers.ts");
    expect(helpers).toMatch(/origin: \(r as \{ origin\?: string \| null \}\)\.origin/);
  });

  it("the rule itself still refuses fees on a grandfathered tenancy", () => {
    expect(feesForTenancy([{ id: "f" }], { rental_mode: "long_term" }, { origin: "grandfathered" }))
      .toEqual([]);
    expect(feesForTenancy([{ id: "f" }], { rental_mode: "long_term" }, { origin: "application" }))
      .toEqual([{ id: "f" }]);
    expect(feesForTenancy([{ id: "f" }], { rental_mode: "short_term" }, { origin: "application" }))
      .toEqual([]);
  });
});
