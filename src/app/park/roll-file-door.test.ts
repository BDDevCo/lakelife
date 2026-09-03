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

  it("accepts the text formats and not the ones we refuse", () => {
    const accept = src.match(/accept="[^"]*"/)?.[0] ?? "";
    expect(accept, "no accept list — the picker offers him every file on the phone")
      .not.toBe("");
    expect(accept).toMatch(/\.csv/);
    expect(accept).toMatch(/\.tsv/);
    // Offering .xlsx in the picker would invite the one file we cannot read.
    expect(accept).not.toMatch(/\.xlsx/);
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
