import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rentForPeriod, lastDayOfMonth } from "./rerate-helpers";

/**
 * ONE RENT HISTORY, OR THE CONFIRM SCREEN LIES.
 *
 * `previewChargeRun` and `runCharges` both have to answer "what was this
 * household paying in this month?". They used to answer it from two different
 * queries resolved at two different instants, and both halves of the mismatch
 * billed somebody wrongly:
 *
 *   - the preview looked for increases due by TODAY; the run resolved at the
 *     END OF THE MONTH. Billing January on the 2nd with a rise due the 15th,
 *     he approved nineteen bills at the old rent and nineteen households were
 *     charged the new one.
 *   - the run read every non-cancelled change with no notice filter at all, so
 *     an increase `scheduleReRate` had written with `notice_given_on` NULL —
 *     which is every increase, until he records that notice went out — was
 *     billed to people nobody had told.
 *
 * The arithmetic was never the bug, so a test of `rentForPeriod` alone cannot
 * catch this. What has to hold is structural: ONE query, carrying the notice
 * filter, resolved at the same instant by both callers.
 */

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments describe the bug; they must never be what satisfies the test. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const LEDGER = "src/app/park/ledger-actions.ts";
const RENT_CHANGES = "src/lib/rent-changes.ts";

describe("the comment stripper", () => {
  it("removes both comment forms and keeps the code", () => {
    const stripped = code(`const a = 1; // lot_rent_changes\n/* lot_rent_changes */\nconst b = 2;`);
    expect(stripped).not.toContain("lot_rent_changes");
    expect(stripped).toContain("const a = 1;");
    expect(stripped).toContain("const b = 2;");
  });

  it("still finds a string that really is in the billing file", () => {
    // Proves the scanner reads the file it thinks it reads — otherwise every
    // assertion below would pass against an empty string.
    expect(code(read(LEDGER))).toContain("runCharges");
  });
});

describe("the billing paths share one rent history", () => {
  it("neither preview nor run queries lot_rent_changes directly", () => {
    const src = code(read(LEDGER));
    expect(src).not.toContain("lot_rent_changes");
  });

  it("both call servedRentHistory", () => {
    const src = code(read(LEDGER));
    const calls = src.match(/servedRentHistory\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("both resolve the rate at the end of the month being billed", () => {
    const src = code(read(LEDGER));
    const resolved = src.match(/rentForPeriod\(/g) ?? [];
    expect(resolved.length).toBe(2);
    // Every rentForPeriod call takes lastDayOfMonth(month) as its instant. A
    // caller reaching for todayLakeDate() here is the old divergence returning.
    const atMonthEnd = src.match(/rentForPeriod\([\s\S]{0,200}?lastDayOfMonth\(month\)/g) ?? [];
    expect(atMonthEnd.length).toBe(2);
  });
});

describe("servedRentHistory", () => {
  const src = code(read(RENT_CHANGES));

  it("excludes increases whose notice was never served", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).toContain('.not("notice_given_on", "is", null)');
  });

  it("excludes cancelled changes, which are not history", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).toContain('.is("cancelled_at", null)');
  });

  it("does NOT filter applied_at — a past month needs applied changes", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    expect(fn).not.toContain("applied_at");
  });

  it("reports a failed read instead of returning an empty history", () => {
    const fn = src.slice(src.indexOf("export async function servedRentHistory"));
    // An empty map reads as "nobody's rent ever changed", which bills every
    // month at today's rate.
    expect(fn).toMatch(/if \(res\.error\) return \{ byRes, error: res\.error \}/);
  });
});

describe("rentForPeriod, resolved at month end", () => {
  const JAN = lastDayOfMonth("2027-01");

  it("bills January at January's rent when the rise lands in February", () => {
    const changes = [{ effective_on: "2027-02-01", from_amount: 272, to_amount: 400 }];
    expect(rentForPeriod(changes, JAN, 400)).toBe(272);
  });

  it("bills January at the new rent once the rise has taken effect", () => {
    const changes = [{ effective_on: "2027-01-01", from_amount: 272, to_amount: 400 }];
    expect(rentForPeriod(changes, JAN, 400)).toBe(400);
  });

  it("falls back to today's rent only when nothing ever changed", () => {
    expect(rentForPeriod([], JAN, 272)).toBe(272);
  });

  it("lastDayOfMonth knows February, including a leap year", () => {
    expect(lastDayOfMonth("2027-02")).toBe("2027-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2027-01")).toBe("2027-01-31");
  });
});
