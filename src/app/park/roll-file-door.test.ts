import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { whyNotReadable } from "./import-helpers";

/**
 * THE ROLL ARRIVES AS A FILE, AND THERE WAS ONLY A PASTE BOX.
 *
 * `/park/import` rendered exactly one control: a textarea. It was built for a
 * real moment — him on his phone at a closing table, reading a list off a
 * page — and it is the wrong door for the one that actually matters. Mike
 * sends the roll by email, as a file.
 *
 * His standing rule, verbatim: "I dont ever want to copy paste. I will screw
 * something up." Selecting a spreadsheet and pasting it into a box on a phone
 * is precisely that act, and it fails SILENTLY — a selection that stops short
 * reads as a shorter roll, not as an error. Twenty-one households becoming
 * fourteen is not something the screen can tell him about, because from its
 * side that is simply what he pasted.
 *
 * `readPaste` takes TEXT, so the file door changes no parsing whatsoever. The
 * only new judgement is which files can be read as text at all — and refusing
 * the rest in words he can act on, rather than filling the box with binary and
 * letting the parser find nothing in it.
 */

/** A NUL byte, written as an escape so it cannot be lost in a copy. */
const NUL = "\u0000";

describe("which files we can read", () => {
  it("takes a CSV", () => {
    expect(whyNotReadable("haven roll.csv", "Lot,Tenant,Rent")).toBeNull();
  });

  it("takes a TSV and a plain text list", () => {
    expect(whyNotReadable("roll.tsv", "Lot\tTenant")).toBeNull();
    expect(whyNotReadable("notes.txt", "Lot 1 Wexler 385")).toBeNull();
  });

  it("refuses an .xlsx by its BYTES, not just its name", () => {
    // The likeliest thing Mike sends. A .xlsx is a ZIP, so read as text it is
    // line noise — and line noise in a paste box looks like our bug, not his
    // file.
    const why = whyNotReadable("Rent Roll.xlsx", "PK");
    expect(why).toMatch(/Save As/);
    expect(why).toMatch(/CSV/);
  });

  it("catches a spreadsheet hiding behind the wrong extension", () => {
    // Renaming a file does not change what it is, and the sniff runs first.
    expect(whyNotReadable("roll.csv", "PK")).toMatch(/Excel or Numbers/);
    expect(whyNotReadable("roll.txt", "%PDF-1.7")).toMatch(/PDF/);
  });

  it("refuses a PDF, and says what to ask for instead", () => {
    const why = whyNotReadable("rent roll.pdf", "%PDF-1.4");
    expect(why).toMatch(/no columns/);
    expect(why).toMatch(/ask for the spreadsheet/);
  });

  it("refuses a photo of a roll without pretending it might work", () => {
    expect(whyNotReadable("IMG_4021.HEIC", "junk")).toMatch(/photo/i);
    expect(whyNotReadable("roll.jpg", "junk")).toMatch(/photo/i);
  });

  it("catches binary whatever it is called", () => {
    expect(whyNotReadable("roll.csv", `Lot${NUL}${NUL}`)).toMatch(/isn't text/);
  });

  it("says an empty file is empty rather than reading nothing", () => {
    expect(whyNotReadable("roll.csv", "   \n  ")).toMatch(/empty/);
  });

  it("names a next step in EVERY refusal — never just 'unsupported'", () => {
    // He is not a developer. A refusal with no next step is a dead end, and
    // this screen is one he opens the day the roll lands.
    const refusals = [
      whyNotReadable("a.xlsx", "junk"),
      whyNotReadable("b.pdf", "junk"),
      whyNotReadable("c.numbers", "junk"),
      whyNotReadable("d.docx", "junk"),
      whyNotReadable("e.png", "junk"),
      whyNotReadable("f.pages", "junk"),
      whyNotReadable("g.ods", "junk"),
    ];
    for (const r of refusals) {
      expect(r, "a refusal with nothing to do about it").toMatch(/CSV|type what you can/);
    }
  });
});

describe("the screen is wired to it", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkImportPaste.tsx", import.meta.url)),
    "utf8",
  );

  it("offers a file input at all — this is the whole point", () => {
    expect(src, "the paste box is the only door again").toMatch(/type="file"/);
  });

  it("lets him PICK the files we refuse, so the refusal can actually be said", () => {
    // THIS TEST ONCE ASSERTED THE OPPOSITE, and the opposite was a bug.
    //
    // A narrow accept list greys .xlsx out in the file picker. He taps "Choose
    // the file", cannot select the Rent Roll.xlsx Mike emailed him, and gets
    // no explanation at all — while whyNotReadable's careful "File → Save As →
    // CSV" sentence could only ever fire for a file that lied about its own
    // extension. A refusal you cannot reach is not a refusal.
    const accept = src.match(/accept="[^"]*"/)?.[0] ?? "";
    expect(accept, "no accept list at all").not.toBe("");
    expect(accept).toMatch(/\.csv/);
    expect(accept).toMatch(/\.tsv/);
    expect(accept, "the likeliest file Mike sends is greyed out with no advice")
      .toMatch(/\.xlsx/);
    expect(accept, "and a PDF, which gets its own sentence").toMatch(/\.pdf/);
  });

  it("sniffs the bytes before filling the box", () => {
    expect(src).toMatch(/whyNotReadable\(file\.name/);
  });

  it("leaves the box ALONE when it refuses a file", () => {
    // Two ways to be wrong here: fill the box with binary, or wipe work he had
    // already typed. The refusal branch must return before touching setText.
    const fn = src.match(/async function pickFile[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(fn, "pickFile is gone — this scan is measuring nothing").not.toBe("");
    const refusal = fn.match(/if \(why\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
    expect(refusal, "the refusal branch is gone").not.toBe("");
    expect(refusal, "a refused file still writes into the box").not.toMatch(/setText\(/);
    expect(refusal, "the refusal must stop there").toMatch(/return;/);
  });

  it("still goes through the same readPaste — no second parser", () => {
    // The file door is additive on purpose. A separate parsing path for files
    // would be two implementations of the hardest code in the product.
    expect(src).toMatch(/readPaste\(parkId, text, cutover/);
    expect((src.match(/readPaste\(/g) ?? []).length,
      "a second call site means the file has its own intake path").toBe(1);
  });

  it("shows him what it read, because he has to be able to check it", () => {
    expect(src).toMatch(/\{fileName\}/);
    expect(src).toMatch(/nothing is saved yet/i);
  });
});


describe("the day he takes over is the park's, not today", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkImportPaste.tsx", import.meta.url)),
    "utf8",
  );
  const page = readFileSync(
    fileURLToPath(new URL("./import/page.tsx", import.meta.url)),
    "utf8",
  );

  /**
   * THE WORST DEFAULT IN THE PRODUCT, because of what reads it.
   *
   * `rangeForTerm` dates EVERY tenancy this import writes as
   * {start: cutover, end: cutover + 1 year}. The box defaulted to TODAY and
   * never consulted parks.cutover_date, which is already set — The Haven's is
   * 2027-01-01. Accepting the default on 4 September files all 21 households
   * as resident from September 2026, three months before he owns the park.
   *
   * And then `lot_no_double_booking`, an EXCLUDE constraint, refuses the real
   * 1 January lease on every one of those lots — so the mistake surfaces in
   * December as a wall of failures with no obvious cause.
   */
  it("seeds the box from the park's stored cutover date", () => {
    const init = src.match(/useState\(parkCutover[^)]*\)/)?.[0] ?? "";
    expect(init, "the box no longer prefers the park's own answer").not.toBe("");
    expect(init).toMatch(/parkCutover \?\? todayISO/);
  });

  it("falls back to today only for a park that has not set one", () => {
    expect(src).toMatch(/todayISO/);
  });

  it("the page actually hands it over — a prop nothing passes is no default", () => {
    expect(page, "import/page.tsx does not pass parkCutover").toMatch(/parkCutover=\{park\.cutoverDate\}/);
  });

  it("and getMyPark reads the column, or the prop is always null", () => {
    const data = readFileSync(
      fileURLToPath(new URL("./data.ts", import.meta.url)),
      "utf8",
    );
    // INSIDE THE SELECT, not merely somewhere in the file. My first version
    // matched the mapping line `cutoverDate: (park.cutover_date ...)` and so
    // passed with the column deleted from the query — the same shape as the
    // bug it is guarding: a name that appears, and a reader that gets nothing.
    const select = data.match(/\.select\("id, name, slug[^"]*"\)/)?.[0] ?? "";
    expect(select, "getMyPark's park select is gone — this scan measures nothing")
      .not.toBe("");
    expect(select, "cutover_date is not in the query, so the prop is always null")
      .toMatch(/cutover_date/);
    expect(data).toMatch(/cutoverDate: \(park\.cutover_date/);
  });
});
