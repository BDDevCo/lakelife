import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { csvCell, csvRow } from "./csv";

/**
 * THE FILE SOMEBODY ELSE OPENS.
 *
 * Three CSVs leave this product: the park's receipts (to an accountant), the
 * crew's earnings (to their bookkeeper), and the ACH export (to a bank). Each
 * had its own copy of the escaping rule, and the three had drifted apart.
 */

describe("the formula guard", () => {
  it("neutralises a leading =, +, - or @", () => {
    // Excel, Sheets and Numbers all evaluate a cell that opens with one of
    // these. The single quote is stripped on display.
    expect(csvCell("=cmd|' /c calc'!A1")).toBe("'=cmd|' /c calc'!A1");
    expect(csvCell("-Smith")).toBe("'-Smith");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@here")).toBe("'@here");
    // A tab needs the guard but not RFC 4180 quoting — it is not a
    // separator in a comma-separated file.
    expect(csvCell("\tlead")).toBe("'\tlead");
  });

  it("guards a formula that ALSO needs quoting, in that order", () => {
    // Quote first and the guard lands outside the quotes, where it does
    // nothing at all.
    expect(csvCell("=SUM(A1,B2)")).toBe("\"'=SUM(A1,B2)\"");
  });

  it("leaves a NEGATIVE NUMBER alone", () => {
    // THIS IS WHY THE GUARD IS SHARED AND NOT COPIED. A refund clawback is
    // -45.00 and a reversed receipt is -1200.00; prefixing either sends the
    // accountant a column that imports as TEXT, so nothing sums. Both files
    // exist to be imported.
    expect(csvCell("-45.00")).toBe("-45.00");
    expect(csvCell("-1200")).toBe("-1200");
    expect(csvCell(-45.5)).toBe("-45.5");
    expect(csvCell("0.00")).toBe("0.00");
  });

  it("still guards anything that only LOOKS numeric", () => {
    // The exemption is a whole-string match, so a formula cannot smuggle
    // itself in behind a digit.
    expect(csvCell("-45.00+cmd")).toBe("'-45.00+cmd");
    expect(csvCell("-")).toBe("'-");
    expect(csvCell("-45.00 (partial)")).toBe("'-45.00 (partial)");
    expect(csvCell("=1")).toBe("'=1");
    // A leading + is NOT how a number is written in these files, and "+1"
    // is far more likely to be a phone number than an amount.
    expect(csvCell("+45.00")).toBe("'+45.00");
  });
});

describe("RFC 4180 quoting", () => {
  it("passes plain values through unquoted", () => {
    expect(csvCell("Pier install")).toBe("Pier install");
    expect(csvCell(120)).toBe("120");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes, newlines AND a lone carriage return", () => {
    expect(csvCell("123 Lake Rd, Angola")).toBe('"123 Lake Rd, Angola"');
    expect(csvCell('The "Big" Dock')).toBe('"The ""Big"" Dock"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    // The ACH export's private copy tested /[",\n]/ and missed this one. A
    // bare \r splits the record for a strict reader — in the bank's file.
    expect(csvCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("joins a full row, escaping each cell", () => {
    expect(csvRow(["2026-07-20", "Pier, install", 120, "Released"])).toBe(
      '2026-07-20,"Pier, install",120,Released',
    );
  });
});

// ---------------------------------------------------------------------------

describe("no CSV writer keeps its own escaping", () => {
  const code = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * THE RULE: a file that emits CSV must route every cell through src/lib/csv.
   * Stated as "no private escaper anywhere" rather than "these three files are
   * correct", because the defect was never that a copy was wrong on the day it
   * was written — it was that copies exist at all and drift silently.
   */
  const WRITERS: Array<[string, string]> = [
    ["the park receipts an accountant opens", "../app/park/receipts-helpers.ts"],
    ["the crew earnings file a bookkeeper opens", "../app/vendor/earnings-helpers.ts"],
    ["the ACH export a bank ingests", "../app/api/ops/payout-export/route.ts"],
  ];

  for (const [what, rel] of WRITERS) {
    it(`${what} uses the shared cell`, () => {
      expect(code(rel)).toMatch(/from "@\/lib\/csv"/);
    });

    it(`${what} defines no escaping of its own`, () => {
      const s = code(rel);
      // The guard, the quote-doubling, and the RFC 4180 character class are
      // the three tells. Any of them reappearing means a fourth copy.
      expect(s).not.toMatch(/\^\[=\+/);
      expect(s).not.toMatch(/replace\(\/"\/g, '""'\)/);
    });
  }

  it("the shared cell is the only place the guard is written", () => {
    // Guards the guard: if the assertions above were satisfied by the rule
    // simply disappearing, this catches it.
    expect(code("./csv.ts")).toMatch(/\^\[=\+\\-@/);
    expect(code("./csv.ts")).toMatch(/replace\(\/"\/g, '""'\)/);
  });
});
