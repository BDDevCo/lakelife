import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * "CHOOSE FILE | NO FILE CHOSEN" WAS A CREW'S FIRST TWO ACTIONS.
 *
 * `globals.css` DELIBERATELY excludes `[type="file"]` from the base input
 * rule, alongside checkbox, radio and range — `design-system-holds.test.ts`
 * asserts that exclusion on purpose, because a bordered, padded checkbox is
 * worse than a bare one. The consequence nobody followed up on is that a raw
 * file input is then the ONE control on a screen with no styling at all, and
 * every surface has to solve it itself.
 *
 * By 20 October 2026 they had solved it four different ways:
 *
 *   hidden + styled trigger ... VendorJobPanel, VendorStopCard — the
 *                               prototype's own pattern, which hides every
 *                               file input (lakelife.html :1321, :1375)
 *   styled visible + echo ..... VendorDocs, deliberately, reasoning in a comment
 *   sized to 16px ............. ParkImportPaste, to stop Safari zooming on focus
 *   raw ....................... VendorStorage, ParkDocuments
 *
 * So the same crew got a styled control for job photos and a browser default
 * for their insurance certificate. `FilePicker` in `wizard-controls.tsx` is
 * now the one home, and the two raw ones use it.
 *
 * THE TWO DELIBERATE ONES ARE LEFT ALONE AND LISTED BELOW. Both carry their
 * reasoning in a comment, and overruling a documented decision because it is
 * inconsistent with a newer one is how the reasoning gets lost. They are
 * named here so the divergence is visible rather than forgotten.
 */

const COMPONENTS = fileURLToPath(new URL(".", import.meta.url));
const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Blank out comments, keeping offsets so line numbers still line up.
 *
 * NARROW ON PURPOSE. The first version stripped any `/* ... *\/` and
 * CORRUPTED THE SOURCE IT WAS SCANNING: `accept="image/*"` opens what looks
 * like a block comment, so everything up to the next `*\/` was blanked —
 * including the `style={{ display: "none" }}` two lines below it. The scan
 * then reported VendorJobPanel and VendorStopCard, the two files that have
 * always done this correctly, as raw file inputs.
 *
 * So: JSX comments `{/* ... *\/}` and block comments that START a line. A
 * `/*` in the middle of an attribute value is left alone.
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { tsxFiles(p, out); continue; }
    if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** Deliberately visible, each with its reasoning in the file. */
const DELIBERATELY_VISIBLE = [
  "VendorDocs.tsx",      // styled to match its siblings + echoes the filename
  "ParkImportPaste.tsx", // fontSize 16 so Safari does not zoom on focus
];

const picker = readFileSync(join(COMPONENTS, "wizard-controls.tsx"), "utf8");

describe("the one home for picking a file", () => {
  it("hides the native input and drives it from a label", () => {
    const fp = picker.slice(picker.indexOf("export function FilePicker"));
    expect(fp, "the native control is visible again").toMatch(/style=\{\{ display: "none" \}\}/);
    // A <label htmlFor> rather than a button with onClick: it opens the picker
    // from the keyboard and reads correctly to a screen reader, with no
    // handler at all.
    expect(fp).toMatch(/<label\s+htmlFor=\{id\}/);
    expect(fp, "a click handler crept back in place of the label").not.toMatch(/onClick=.*click\(\)/);
  });

  it("ALWAYS SAYS BACK WHAT WAS PICKED", () => {
    // Hiding the native control without replacing what it told you would be
    // the worse bug — the native one at least said "No file chosen".
    const fp = picker.slice(picker.indexOf("export function FilePicker"));
    expect(fp).toMatch(/\{fileName \?\? "No file chosen yet"\}/);
    expect(fp).toMatch(/Choose a different file/);
  });

  it("and a long filename cannot scroll the page sideways at 375px", () => {
    // A real certificate is called something like
    // Certificate_of_Insurance_Northshore_2027.pdf, which has nowhere to wrap.
    const fp = picker.slice(picker.indexOf("export function FilePicker"));
    expect(fp).toMatch(/overflowWrap: "anywhere"/);
    expect(fp).toMatch(/minWidth: 0/);
  });

  it("hands back the FILE, not just its name", () => {
    // The first draft passed only the name, which is enough to render and
    // useless to upload — ParkDocuments keeps the File to enable its submit.
    const fp = picker.slice(picker.indexOf("export function FilePicker"));
    expect(fp).toMatch(/onPick: \(file: File \| null\) => void/);
    expect(fp).toMatch(/onPick\(e\.target\.files\?\.\[0\] \?\? null\)/);
  });

  it("keeps a 44px target, which is the rest of the product's floor", () => {
    const fp = picker.slice(picker.indexOf("export function FilePicker"));
    expect(fp).toMatch(/minHeight: 44/);
  });
});

describe("no surface renders a raw, visible file input", () => {
  const offenders: string[] = [];
  const hidden: string[] = [];

  for (const file of tsxFiles(SRC)) {
    // STRIP COMMENTS FIRST. The first run of this test flagged
    // ParkDocuments as a raw file input and the offender was its own
    // comment — a `{/* ... <input type="file"> ... */}` explaining what the
    // code used to be. Blanked rather than deleted, so line numbers survive.
    const src = stripComments(readFileSync(file, "utf8"));
    const name = file.split("/").pop()!;
    let i = src.indexOf('type="file"');
    while (i !== -1) {
      // the enclosing <input ...> tag
      const open = src.lastIndexOf("<input", i);
      const close = src.indexOf("/>", i);
      const tag = src.slice(open, close === -1 ? i + 200 : close);
      const isHidden = /display:\s*"none"/.test(tag);
      (isHidden ? hidden : offenders).push(`${name}:${src.slice(0, i).split("\n").length}`);
      i = src.indexOf('type="file"', i + 1);
    }
  }

  it("the scanner finds the file inputs at all", () => {
    // Every assertion here is an absence. If the scan stops matching, they all
    // pass over an empty list.
    expect(hidden.length + offenders.length, "no file inputs found — repoint this")
      .toBeGreaterThanOrEqual(5);
    expect(hidden.length, "nothing is using the hidden pattern — did FilePicker go?")
      .toBeGreaterThanOrEqual(3);
  });

  it("EVERY VISIBLE ONE IS A NAMED, DELIBERATE EXCEPTION", () => {
    const unexplained = offenders.filter(
      (o) => !DELIBERATELY_VISIBLE.some((d) => o.startsWith(d)),
    );
    expect(
      unexplained.join("\n"),
      "a raw file input is back. globals.css excludes [type=\"file\"] from the base input rule " +
      "on purpose, so this renders as the one unstyled control on the screen. Use FilePicker " +
      "from wizard-controls, or add it to DELIBERATELY_VISIBLE with its reasoning in the file.",
    ).toBe("");
  });

  it("and the two exceptions still exist, so the list is not quietly stale", () => {
    // If one of them is converted later, this fails and whoever did it has to
    // come and remove it from the list rather than leaving a lie behind.
    for (const d of DELIBERATELY_VISIBLE) {
      expect(offenders.some((o) => o.startsWith(d)), `${d} no longer has a visible file input`)
        .toBe(true);
    }
  });
});

describe("two pickers on one page cannot share an id", () => {
  it("every FilePicker id is distinct", () => {
    // `htmlFor` finds the FIRST matching id, so a duplicate would silently
    // point the W-9 card's label at the COI card's input. DocStep renders
    // twice on the onboarding screen, which is exactly that risk.
    const ids: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const src = stripComments(readFileSync(file, "utf8"));
      // ONE scan, both quote styles. The first version ran two overlapping
      // regexes and counted the templated id twice, then reported it as a
      // duplicate of itself.
      for (const m of src.matchAll(/<FilePicker[\s\S]{0,200}?id=\{?["`]([^"`]+)["`]\}?/g)) {
        ids.push(m[1]);
      }
    }
    expect(ids.length, "no FilePicker usages found — repoint this").toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size, `duplicate FilePicker id among ${ids.join(", ")}`).toBe(ids.length);
  });

  it("and the one that renders twice derives its id from what it is picking", () => {
    const onboarding = readFileSync(join(COMPONENTS, "VendorOnboarding.tsx"), "utf8");
    // DocStep is rendered for both "coi" and "w9" on the same screen.
    expect(onboarding).toMatch(/id=\{`doc-file-\$\{kind\}`\}/);
  });
});
