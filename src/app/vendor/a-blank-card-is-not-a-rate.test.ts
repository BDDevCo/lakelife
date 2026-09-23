import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRealRate, computeRateRow } from "./rates-helpers";
import { LAKE_GATE_SENTENCE, parkClause, parkNote } from "@/lib/lake-gate";

/**
 * "PRICED" MEANT FOUR DIFFERENT THINGS IN FOUR DOORWAYS, AND THREE OF THEM
 * WERE WRONG ABOUT WHAT DISPATCH ACTUALLY DEMANDS.
 *
 *   ops/crews-data.ts      four shapes, roughly right
 *   vendor/needs-you-data  a rate ROW EXISTS
 *   vendor/onboarding-props a rate ROW EXISTS
 *   vendor/rates-data      `!!existing` — a rate ROW EXISTS
 *
 * `decideDispatch` drops a crew whose rate is not `> 0` (`no_qualifying_rate`)
 * and `isEligible` blocks them (`no_rate`). A blank Save writes a row of zeros
 * ON PURPOSE — `coerceRate("")` is `{ ok: true, value: 0 }` — so Josh could
 * tick Lawn mowing, open Rates, tap Save without typing, see "Rate set ✓",
 * read "jobs for the work you've priced start reaching you", go live, and be
 * refused by every job with nothing anywhere saying why.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(join(process.cwd(), "src", rel), "utf8"));

describe("hasRealRate asks the question the gates ask", () => {
  it("a row of zeros is not a rate", () => {
    expect(hasRealRate({ base: 0, unit_rate: 0, band_pricing: null })).toBe(false);
    expect(hasRealRate({ base: 0, unit_rate: 0, band_pricing: { small: 0, medium: 0, large: 0 } })).toBe(false);
    expect(hasRealRate({ base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: null, price: 0 }] } })).toBe(false);
    expect(hasRealRate(null)).toBe(false);
    expect(hasRealRate(undefined)).toBe(false);
  });

  it("but every shape that CAN price something is", () => {
    // Collapsed the other way. A predicate that answered false to everything
    // would pass the block above and call every crew on the platform unpriced.
    expect(hasRealRate({ base: 125, unit_rate: 0, band_pricing: null })).toBe(true);
    expect(hasRealRate({ base: 0, unit_rate: 55, band_pricing: { count_field: "pier_sections", min_count: 1 } })).toBe(true);
    expect(hasRealRate({ base: 0, unit_rate: 0, band_pricing: { small: 45, medium: 59, large: 77 } })).toBe(true);
    expect(hasRealRate({ base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 0 }, { max: null, price: 84 }] } })).toBe(true);
  });

  it("agrees with the four rows production actually holds", () => {
    // Traced to live rows, not invented: every vendor_rates row on the
    // platform on 23 Sep 2026 carries base = 0, and three of the four price
    // entirely through band_pricing. A naive `base > 0 || unit_rate > 0`
    // would have called three real rate cards blank and told those crews they
    // had priced nothing.
    const live = [
      { base: 0, unit_rate: 0, band_pricing: { large: 77, small: 45, medium: 59 } },
      { base: 0, unit_rate: 55, band_pricing: { min_count: 1, count_field: "pier_sections" as const } },
      { base: 0, unit_rate: 52, band_pricing: { min_count: 1, count_field: "pier_sections" as const } },
      { base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 56 }, { max: 2800, price: 67 }, { max: null, price: 84 }] } },
    ];
    for (const row of live) expect(hasRealRate(row)).toBe(true);
  });

  it("the blank Save really does produce a row this refuses", () => {
    // NOT a hand-written zero row: run the real writer with an empty payload,
    // the way tapping Save on an untouched form does, and feed what it
    // produces straight to the predicate. If `computeRateRow` ever stops
    // accepting blanks, this goes red and the whole finding is moot.
    const out = computeRateRow(
      { pricing_model: "band", band_pricing: { small: 0, medium: 0, large: 0 } },
      { band: { small: "", medium: "", large: "" } },
    );
    expect(out.ok).toBe(true);
    expect(hasRealRate(out.ok ? out.row : null)).toBe(false);

    const flat = computeRateRow({ pricing_model: "flat", band_pricing: null }, { base: "" });
    expect(flat.ok).toBe(true);
    expect(hasRealRate(flat.ok ? flat.row : null)).toBe(false);
  });
});

describe("one predicate, every doorway that asks", () => {
  for (const file of [
    "app/vendor/onboarding-props.ts",
    "app/vendor/needs-you-data.ts",
    "app/vendor/rates-data.ts",
    "app/ops/crews-data.ts",
  ]) {
    it(`${file} asks hasRealRate`, () => {
      expect(src(file), `${file} answers "has this crew priced it?" its own way`).toMatch(/hasRealRate\(/);
    });
  }

  it("and none of them is back to testing row existence", () => {
    // The exact expressions that were there. A doorway that reverts fails here
    // even if it also happens to import the helper.
    expect(src("app/vendor/rates-data.ts")).not.toMatch(/hasRate:\s*!!existing/);
    expect(src("app/vendor/needs-you-data.ts")).not.toMatch(/new Set\(\(myRates \?\? \[\]\)\.map/);
    expect(src("app/vendor/onboarding-props.ts")).not.toMatch(/new Set\(\(myRates \?\? \[\]\)\.map/);
  });

  it("and the rate reads carry the amounts, or the predicate has nothing to read", () => {
    // A column with no reader's twin: a predicate with no column. Both of
    // these used to select `service_id` alone.
    for (const file of ["app/vendor/onboarding-props.ts", "app/vendor/needs-you-data.ts"]) {
      const code = src(file);
      const at = code.indexOf('from("vendor_rates")');
      expect(at, `${file} no longer reads vendor_rates`).toBeGreaterThan(-1);
      const sel = code.slice(at, at + 300);
      expect(sel).toMatch(/base/);
      expect(sel).toMatch(/unit_rate/);
      expect(sel).toMatch(/band_pricing/);
    }
  });
});

describe("the lake gate is said on BOTH lake doors", () => {
  it("the sentence has one home", () => {
    expect(LAKE_GATE_SENTENCE).toMatch(/untapped lake is one you never hear about/i);
  });

  for (const file of ["components/VendorOnboarding.tsx", "app/vendor/availability/page.tsx"]) {
    it(`${file} shows it`, () => {
      const code = src(file);
      // RENDERED, NOT MERELY IMPORTED. A first cut of this test grepped for
      // the identifier and passed against a file that imported it and dropped
      // it from the JSX — the same substring-pin weakness this suite exists to
      // call out elsewhere. Pin the interpolation.
      expect(
        code,
        `this is a door where a crew sets which lakes they work, and it does ` +
          `not RENDER the sentence saying an untapped lake is silent`,
      ).toMatch(/\{LAKE_GATE_SENTENCE\}/);
      expect(code, "and it does not render the derived park clause")
        .toMatch(/parkClause\(/);
      expect(code, "the park clause is computed and then not shown")
        .toMatch(/\{parks && /);
    });
  }

  it("the availability page is not back to its old sentence", () => {
    expect(src("app/vendor/availability/page.tsx"))
      .not.toMatch(/Tap the lakes your crew works\.\s*New lakes/);
  });

  it("the park clause is derived, and silent when there is nothing to derive", () => {
    const lakes = [{ id: "lake-pretty", name: "Pretty Lake" }, { id: "lake-turkey", name: "Big Turkey Lake" }];
    expect(parkClause(lakes, { "lake-pretty": ["The Haven"] }))
      .toBe("Mobile-home and RV parks count too: Pretty Lake includes The Haven.");
    // Two parks on two lakes, both named.
    expect(parkClause(lakes, { "lake-pretty": ["The Haven"], "lake-turkey": ["Shady Pines"] }))
      .toBe("Mobile-home and RV parks count too: Pretty Lake includes The Haven; Big Turkey Lake includes Shady Pines.");
    // No park anywhere -> no clause at all, rather than "no parks here".
    expect(parkClause(lakes, {})).toBeNull();
    // A FAILED READ IS NOT "NO PARKS".
    expect(parkClause(lakes, null)).toBeNull();
    expect(parkNote("Pretty Lake", "lake-pretty", null)).toBeNull();
  });

  it("no park is named in the code — every name comes from the rows", () => {
    for (const file of ["components/VendorOnboarding.tsx", "app/vendor/availability/page.tsx", "lib/lake-gate.ts"]) {
      const code = src(file);
      // "The Haven" may appear in prose we stripped, never in a rendered string.
      expect(code, `${file} hardcodes a park name`).not.toMatch(/["'`][^"'`]*The Haven/);
    }
  });
});
