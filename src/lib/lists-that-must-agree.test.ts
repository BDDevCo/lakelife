import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORRECTABLE, FIELD_LABEL } from "./arrival";
import { crewListsService } from "./crew-services";

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

/**
 * A CREW WHO LISTS NOTHING IS OFFERED NOTHING.
 *
 * Three places believed an empty `service_types` meant "generalist — does
 * everything", and the router believed the opposite. dispatch pools only crews
 * whose service_types INCLUDES the job's service name, so an empty list is
 * offered nothing, ever:
 *
 *   CrewBoard.tsx      pill: "generalist (all work)"   <- flat lie to ops
 *   ops/data.ts        service_ok = true               <- annotation, uncalled
 *   JobFile.tsx        serviceOk() = true              <- a SECOND copy
 *   JobBoard.tsx       serviceOk() = true              <- the LIVE one, missed
 *
 * The fourth copy was missed because this suite never read the file, and the
 * copy it DID read — ops/data.ts — had no caller at all, so going green there
 * proved nothing about what ops sees. That file's copy has since been deleted
 * with the dead function around it, and the two live boards now import ONE
 * helper, lib/crew-services.ts. That is why the assertions below ask for the
 * import rather than for the rule written out again: a fifth copy is the
 * failure mode, so the test refuses to accept one.
 *
 * Live in production when this was written: one active vendor with
 * service_types = [] carrying the "generalist (all work)" pill while being
 * dispatchable to nothing. Ops read that they do everything; the router gave
 * them none. It also silently contradicted the new coverage card on the SAME
 * TAB, which counts that crew as covering nothing — correctly.
 */
describe("what an empty service list means", () => {
  const crewBoard = strip(read("../components/ops/CrewBoard.tsx"));
  const jobFile = strip(read("../components/ops/JobFile.tsx"));
  const jobBoard = strip(read("../components/ops/JobBoard.tsx"));
  const opsData = strip(read("../app/ops/data.ts"));
  const dispatch = strip(read("./dispatch.ts"));

  it("found all five files", () => {
    expect(crewBoard.length).toBeGreaterThan(500);
    expect(jobFile.length).toBeGreaterThan(500);
    expect(jobBoard.length).toBeGreaterThan(500);
    expect(opsData.length).toBeGreaterThan(500);
    expect(dispatch).toMatch(/serviceTypes/);
  });

  it("is the router's rule that everything else must match", () => {
    // The one that actually decides. If this stops being an includes() the
    // three assertions below are pinned to a rule that no longer exists.
    expect(dispatch, "dispatch no longer gates on the service list")
      .toMatch(/serviceTypes\.includes/);
  });

  it("the crews board no longer calls an empty list 'all work'", () => {
    expect(crewBoard, "ops is told a crew who can be dispatched nothing does everything")
      .not.toMatch(/generalist \(all work\)/);
    expect(crewBoard).toMatch(/cannot be dispatched/);
  });

  it("the rule itself answers the empty list with nothing", () => {
    // THE ASSEMBLY, NOT A COPY OF IT. The one function both boards call, run
    // for real — a scan for the words could pass on a helper nobody calls.
    expect(crewListsService([], "Weekly mow & blow")).toBe(false);
    expect(crewListsService(null, "Weekly mow & blow")).toBe(false);
    expect(crewListsService(["mow"], "Weekly mow & blow")).toBe(true);
    expect(crewListsService(["pier"], "Weekly mow & blow")).toBe(false);
  });

  it("both live annotations call it, and neither keeps its own copy", () => {
    // POINTED AT THE LIVE DOORWAYS. This used to read ops/data.ts, where the
    // rule sat in a function nothing called, so it went green while the
    // annotation ops actually reads still answered true for a crew who lists
    // nothing. A file that grows its own `serviceOk` back has left the list.
    for (const [name, src] of [["the jobs board", jobBoard], ["the job file", jobFile]] as const) {
      expect(src, `${name} no longer imports the one copy of the rule`)
        .toMatch(/import \{ crewListsService \} from "@\/lib\/crew-services";/);
      expect(src, `${name} has grown a second copy of the rule`)
        .not.toMatch(/function serviceOk/);
      expect(src).toMatch(/crewListsService\(v\.service_types,/);
    }
  });

  it("the jobs board says which kind of nothing it is, too", () => {
    // Same two-way label as the job file: "doesn't list this service" and
    // "lists no services at all" are different problems with different fixes.
    expect(jobBoard).toMatch(/lists no services at all/);
  });

  it("says which kind of nothing it is", () => {
    // "doesn't list this service" is true but unhelpful for a crew who lists
    // none at all — the remedy is different, so the sentence should be too.
    expect(jobFile).toMatch(/lists no services at all/);
  });
});
