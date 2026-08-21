import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstBillablePeriod, periodIsBillable } from "@/lib/billing-start";
import { rangeForTerm } from "./import-helpers";

/**
 * THE IMPORTER MUST BE ABLE TO SAY "THE 15th".
 *
 * The paste screen used to offer a list of MONTHS and write the 1st of the one
 * he chose. Two readers take that value and a month-start is wrong for both —
 * `rangeForTerm` wants the day the park actually changed hands, and
 * `firstBillablePeriod` reads the day to decide whether the month is his.
 *
 * The Haven closes 15 December 2026. Answering the old question truthfully —
 * "December" — wrote 2026-12-01, which is the claim "December is mine to bill
 * in full". The seller collected December on the 1st. Nineteen households
 * would have been billed for it twice.
 */

const root = join(__dirname, "..", "..", "..");
const code = (p: string) =>
  readFileSync(join(root, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PASTE = "src/components/ParkImportPaste.tsx";

describe("The Haven's closing, 15 December 2026", () => {
  const CLOSING = "2026-12-15";

  it("does not bill December — the seller already collected it", () => {
    expect(periodIsBillable("2026-12", CLOSING)).toBe(false);
  });

  it("bills January 2027 first", () => {
    expect(firstBillablePeriod(CLOSING)).toBe("2027-01");
    expect(periodIsBillable("2027-01", CLOSING)).toBe(true);
  });

  it("would have billed December had the day been rounded to the 1st", () => {
    // The defect, kept as a test so nobody reintroduces the rounding.
    expect(periodIsBillable("2026-12", "2026-12-01")).toBe(true);
  });

  it("still lets a park that genuinely starts on the 1st claim that month", () => {
    expect(firstBillablePeriod("2027-01-01")).toBe("2027-01");
  });

  it("dates grandfathered tenancies from the real closing day", () => {
    const range = rangeForTerm("monthly", CLOSING, null);
    expect(range).toEqual({ start: "2026-12-15", end: "2027-12-15" });
  });
});

describe("the paste screen asks for a day", () => {
  const src = code(PASTE);

  it("reads the file it thinks it reads", () => {
    expect(src).toContain("ParkImportPaste");
  });

  it("offers a date control, not a list of months", () => {
    expect(src).toContain('type="date"');
    expect(src).not.toContain("<select");
  });

  it("no longer builds month options that are always the 1st", () => {
    expect(src).not.toContain("monthOptions");
  });

  it("tells him which month he will actually bill first", () => {
    expect(src).toContain("firstBillablePeriod");
  });

  it("will not submit without a takeover day", () => {
    expect(src).toContain("!cutover");
  });
});
