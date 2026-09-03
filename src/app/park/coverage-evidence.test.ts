import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCoverage, coverageSummary } from "./fee-helpers";

/**
 * THE SENTENCE THAT DECIDES WHETHER HE CHANGES THE FEE.
 *
 * `coverageSummary`'s own docstring says exactly that, and The Haven is about
 * to lock $142.53 into twenty leases for a year. So the panel around it has to
 * be honest about two things the headline number cannot carry on its own:
 *
 *   1. WHICH CATEGORIES ARE NOT IN IT. The fee claims water, sewer, trash,
 *      common electric, grounds and other; only four of those have a bill. A
 *      cheerful "ahead by $48 a lot" computed over four of six categories is
 *      the copy-that-lies class, in the most expensive place to have it.
 *   2. HOW MANY MONTHS IT RESTS ON. Over two or more the panel said "averaged
 *      over N months"; at exactly ONE it said nothing at all — so the thinnest
 *      possible evidence was the only case with no caveat on it.
 *
 * These are source scans for the panel and real arithmetic for the helper.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PANEL = "src/components/ParkFees.tsx";

describe("the coverage panel says what is missing from the number", () => {
  it("renders the unverified categories — computing them and not showing them would be worse than not computing them", () => {
    const s = read(PANEL);
    expect(s, "c.unverified is computed by checkCoverage; a reader must exist")
      .toMatch(/c\.unverified\.length > 0/);
    expect(s, "and it must name them, not just count them")
      .toMatch(/c\.unverified\.map/);
  });

  it("renders the uncovered categories too — a cost no fee covers is the other half", () => {
    const s = read(PANEL);
    expect(s).toMatch(/c\.uncovered\.length > 0/);
  });

  it("says how many months the figure rests on, INCLUDING when it is one", () => {
    const s = read(PANEL);
    // The bug this replaces: `monthsObserved > 1 &&` meant one month — the
    // weakest evidence there is — was the single case shown bare.
    expect(s, "a bare `monthsObserved > 1 &&` gate leaves one month unqualified")
      .not.toMatch(/\{page\.monthsObserved > 1 && \(/);
    expect(s, "the one-month case must say so in words")
      .toMatch(/one month of bills/);
    expect(s, "and the multi-month case must keep its count")
      .toMatch(/Averaged over \$\{page\.monthsObserved\} months/);
  });

  it("does not claim a sample size when there are no bills at all", () => {
    // With no costs entered the headline already says "nothing to check this
    // against". Adding "from one month of bills" under it would be inventing
    // a month nobody entered.
    const s = read(PANEL);
    expect(s).toMatch(/c\.actualCost > 0 &&/);
  });
});

describe("The Haven's actual numbers, as recorded today", () => {
  // The four rows on file, all sharing one period_start (June 2026).
  const COSTS = [
    { category: "sewer" as const, amountPaid: 1405.36 },
    { category: "grounds" as const, amountPaid: 198.08 },
    { category: "common_electric" as const, amountPaid: 144.02 },
    { category: "other" as const, amountPaid: 140.00 },
  ];
  const FEE = {
    id: "f1",
    label: "Grounds fee",
    amount: 142.53,
    cadence: "monthly" as const,
    applies_to: "long_term" as const,
    covers: ["water", "sewer", "trash", "common_electric", "grounds", "other"] as const,
    active: true,
  };
  const fees = [FEE as unknown as Parameters<typeof checkCoverage>[0][number]];

  it("the fee is ahead on what is recorded — by $48.16 a lot", () => {
    const c = checkCoverage(fees, new Map([["f1", 20]]), COSTS, 1);
    expect(c.feeIncome).toBe(2850.6);   // 20 × $142.53
    expect(c.actualCost).toBe(1887.46); // the four rows
    expect(c.margin).toBe(963.14);
    expect(coverageSummary(c, 20, 1)).toContain("ahead by $48.16 a lot");
  });

  it("but water and trash are not in that number at all", () => {
    // This is the point. Two of the six categories the fee claims have no
    // bill behind them, and both are real: he decided the park pays a trash
    // hauler, and the water is wells — pumps, maintenance, inspections.
    const c = checkCoverage(fees, new Map([["f1", 20]]), COSTS, 1);
    expect(c.unverified.sort()).toEqual(["trash", "water"]);
  });

  it("and nothing recorded is uncovered — the fee's own list is the wider one", () => {
    const c = checkCoverage(fees, new Map([["f1", 20]]), COSTS, 1);
    expect(c.uncovered).toEqual([]);
  });

  it("with nobody on the roll it collects nothing, and says so rather than reading as a shortfall", () => {
    // The Haven's state today: a saved fee, real bills, zero households.
    const c = checkCoverage(fees, new Map([["f1", 0]]), COSTS, 1);
    expect(c.feeIncome).toBe(0);
    expect(coverageSummary(c, 0, 1)).toBe("Nobody is on a lot yet, so this fee is collecting nothing.");
  });

  it("$48.16 of headroom is what has to absorb trash and the wells", () => {
    // Stated as arithmetic so the number is checkable rather than asserted:
    // if trash and wells together run more than this per lot, the fee is short
    // and he will not find out from the recorded rows, because they are absent.
    const c = checkCoverage(fees, new Map([["f1", 20]]), COSTS, 1);
    expect(c.margin / 20).toBeCloseTo(48.157, 2);
    expect(c.margin).toBeLessThan(FEE.amount * 20 - 1405.36); // sewer alone is 74% of cost
  });
});
