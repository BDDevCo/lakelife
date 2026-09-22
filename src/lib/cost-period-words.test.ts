import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { costPeriodInWords } from "./cost-period-words";

/**
 * THE PERIOD A COST COVERED, ON THE MOST-READ SENTENCE IN THE PRODUCT.
 *
 * A resident's bill line read "Sewer — your share · for 2027-02-01 to
 * 2027-03-01" beside "Lot rent · for the month", and the basis is frozen
 * into park_charges.lines at raise time, so it had to be right before the
 * first run. These pin the three shapes the product actually produces and
 * the one shape an owner types by hand.
 */

describe("costPeriodInWords", () => {
  it("names a whole month by its month — the exclusive [1st, 1st) shape billPeriod emits", () => {
    expect(costPeriodInWords("2027-02-01", "2027-03-01")).toBe("for February 2027");
    // Across the turn of the year, where the month arithmetic is easiest to
    // get wrong.
    expect(costPeriodInWords("2026-12-01", "2027-01-01")).toBe("for December 2026");
  });

  it("names a calendar year as the year — the property-tax share", () => {
    expect(costPeriodInWords("2027-01-01", "2028-01-01")).toBe("for 2027");
  });

  it("names twelve months that are not a calendar year by their months, not by a year", () => {
    // "for 2027" here would be a claim about a period the cost does not
    // cover: March 2027 to February 2028 is not the year 2027.
    expect(costPeriodInWords("2027-03-01", "2028-03-01")).toBe("for March 2027 to February 2028");
  });

  it("names a quarter by its first and last month, the way billPeriod does", () => {
    expect(costPeriodInWords("2027-01-01", "2027-04-01")).toBe("for January 2027 to March 2027");
    expect(costPeriodInWords("2026-11-01", "2027-02-01")).toBe("for November 2026 to January 2027");
  });

  it("says the days an owner typed, in words, and never rounds them up to a month", () => {
    // The cost form is two free date inputs with no prefill, validated only
    // as end > start. "for February 2027" over dates he did not enter would
    // be a claim nobody made, frozen onto a bill.
    expect(costPeriodInWords("2027-02-01", "2027-02-28")).toBe("for February 1, 2027 to February 28, 2027");
    expect(costPeriodInWords("2027-02-03", "2027-03-01")).toBe("for February 3, 2027 to March 1, 2027");
  });

  it("a period with no dates, or dates it cannot read, is 'as allocated' — never a guessed month", () => {
    expect(costPeriodInWords(null, "2027-03-01")).toBe("as allocated");
    expect(costPeriodInWords("2027-02-01", null)).toBe("as allocated");
    expect(costPeriodInWords(undefined, undefined)).toBe("as allocated");
    expect(costPeriodInWords("", "")).toBe("as allocated");
    expect(costPeriodInWords("February 2027", "2027-03-01")).toBe("as allocated");
    expect(costPeriodInWords("2027-13-01", "2027-14-01")).toBe("as allocated");
  });

  it("an end before the start falls to the days, not to a negative month count", () => {
    expect(costPeriodInWords("2027-03-01", "2027-02-01")).toBe("for March 1, 2027 to February 1, 2027");
    expect(costPeriodInWords("2027-03-01", "2027-03-01")).toBe("for March 1, 2027 to March 1, 2027");
  });

  it("holds no ISO date of its own — the defect was a raw YYYY-MM-DD in a sentence", () => {
    const RAW_DATE = /\$\{\s*(start|end|cost\.period_\w+)\s*\}/;
    // Non-vacuous: the template that printed "for 2027-02-01 to
    // 2027-03-01" onto a resident's bill matches this, so the scan below
    // is known to be capable of failing.
    expect("for ${cost.period_start} to ${cost.period_end}").toMatch(RAW_DATE);
    const src = readFileSync(fileURLToPath(new URL("./cost-period-words.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain("prettyMonth");
    expect(src).toContain("dayInWords");
    expect(src).not.toMatch(RAW_DATE);
  });
});
