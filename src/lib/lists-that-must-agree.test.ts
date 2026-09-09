import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORRECTABLE, FIELD_LABEL } from "./arrival";

/**
 * FOUR LISTS, AND THE ONE THAT GETS FORGOTTEN.
 *
 * Migration 0144 added the `snow` cost category, widened four lists, and
 * missed a fifth writer that hardcoded "grounds". Every park job filed under
 * the wrong category for weeks, with no error on any screen. That is the
 * failure this file exists to make impossible for the profile facts a crew can
 * correct — because those facts SET THE PRICE, so a list left behind is money.
 *
 * The lists, and what happens when one is missed:
 *
 *   CORRECTABLE          (lib/arrival.ts)          the correction is not
 *                                                  summarised for the owner
 *   FIELD_LABEL          (lib/arrival.ts)          it is summarised as a
 *                                                  column name
 *   WHAT_CHANGED         (ArrivalSheet.tsx)        a crew cannot raise it from
 *                                                  the Today card
 *   FLAG_TYPES           (VendorStopCard.tsx)      ...or from the stop card.
 *                                                  This file's own header
 *                                                  promises "one wording, one
 *                                                  sanitizer" — that promise
 *                                                  is only true if both agree
 *   sanitizeProposed     (vendor/actions.ts)       the server silently DROPS
 *                                                  the key and files a bare
 *                                                  note instead
 *   apply_flag_change    (0159, SQL)               the flag reads approved and
 *                                                  the profile never changes
 *
 * The last one is checked in invariants.test.ts against the migration text;
 * the five in TypeScript are checked here.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const arrivalSheet = strip(read("../components/ArrivalSheet.tsx"));
const stopCard = strip(read("../components/VendorStopCard.tsx"));
const vendorActions = strip(read("../app/vendor/actions.ts"));

/** Every `field: "x"` in ArrivalSheet's WHAT_CHANGED list. */
const sheetFields = new Set(
  [...arrivalSheet.matchAll(/\bfield:\s*"(\w+)"/g)].map((m) => m[1]),
);
/** Every countField/bandField in VendorStopCard's FLAG_TYPES list. */
const cardFields = new Set(
  [...stopCard.matchAll(/\b(?:countField|bandField):\s*"(\w+)"/g)].map((m) => m[1]),
);

describe("the scanners found real lists", () => {
  it("read both crew flag forms", () => {
    // Without this every set comparison below is empty-vs-empty and passes.
    expect(sheetFields.size, "ArrivalSheet's WHAT_CHANGED did not parse").toBeGreaterThan(4);
    expect(cardFields.size, "VendorStopCard's FLAG_TYPES did not parse").toBeGreaterThan(3);
    expect(CORRECTABLE.length).toBeGreaterThan(5);
  });

  it("still finds the field the whole mechanism was built for", () => {
    expect(sheetFields.has("pier_sections")).toBe(true);
    expect(cardFields.has("pier_sections")).toBe(true);
  });
});

describe("every list of correctable facts agrees", () => {
  it("the Today card offers nothing the server would drop", () => {
    // A correction a crew can submit and the sanitizer discards is filed as a
    // bare note: the price never moves and nobody is told why.
    const extra = [...sheetFields].filter((f) => !CORRECTABLE.includes(f as never));
    expect(extra, "ArrivalSheet offers corrections CORRECTABLE does not know").toEqual([]);
  });

  it("the stop card offers nothing the server would drop", () => {
    const extra = [...cardFields].filter((f) => !CORRECTABLE.includes(f as never));
    expect(extra, "VendorStopCard offers corrections CORRECTABLE does not know").toEqual([]);
  });

  it("the two crew forms offer the same facts as each other", () => {
    // VendorStopCard's own header promises the crew flags "through the exact
    // same form the Today card uses — one wording, one sanitizer". Two lists,
    // one promise.
    const onlySheet = [...sheetFields].filter((f) => !cardFields.has(f));
    const onlyCard = [...cardFields].filter((f) => !sheetFields.has(f));
    expect(
      { onlySheet, onlyCard },
      "a crew can correct a fact from one screen and not the other",
    ).toEqual({ onlySheet: [], onlyCard: [] });
  });

  it("every correctable fact has words a homeowner reads", () => {
    // The approval screen falls back to the column name otherwise — the
    // homeowner authorises "Drive band: large".
    const unlabelled = CORRECTABLE.filter((f) => !FIELD_LABEL[f]);
    expect(unlabelled).toEqual([]);
    for (const f of CORRECTABLE) {
      expect(FIELD_LABEL[f], `${f} is labelled with its own column name`).not.toContain("_");
    }
  });

  it("the server accepts every fact the forms offer", () => {
    // The sanitizer is the last gate; a field missing here is dropped after a
    // crew has already typed it.
    for (const f of CORRECTABLE) {
      expect(vendorActions, `sanitizeProposed does not accept ${f}`).toContain(f);
    }
  });
});

describe("a wall of glass fits through the sanitizer", () => {
  it("does not clamp every count at the pier-section ceiling", () => {
    // 99 was chosen for pier sections and boat lifts. A lakefront routinely
    // runs past 99 panes, and the shared clamp DROPPED the key — silently,
    // after the crew had counted them.
    expect(vendorActions, "the 99 clamp is still global").toMatch(/COUNT_MAX/);
    expect(vendorActions).toMatch(/panes:\s*999/);
  });

  it("still holds equipment counts to a sane number", () => {
    expect(vendorActions).toMatch(/pier_sections:\s*99/);
  });
});

describe("both unit-noun tables know the same counts", () => {
  // There are TWO. `unitNounFor` labels the crew's rate card; the table in
  // lake-pages.ts labels the PUBLIC lake page. Both default to a pier — so a
  // service counting something unlisted advertises itself, on the open
  // internet, as priced "per pier section".
  const rates = strip(read("../app/vendor/rates-helpers.ts"));
  const lakePages = strip(read("./lake-pages.ts"));

  it("found both tables", () => {
    expect(rates).toMatch(/unitNounFor/);
    expect(lakePages).toMatch(/per pier section/);
  });

  it("both know what a pane is", () => {
    expect(rates, "the crew's rate card would say 'per unit' for windows").toMatch(/"panes"/);
    expect(lakePages, "the public lake page would advertise windows per pier section")
      .toMatch(/per pane/);
  });

  it("the public table no longer calls a park lot a pier section", () => {
    expect(lakePages).toMatch(/per lot/);
  });
});
