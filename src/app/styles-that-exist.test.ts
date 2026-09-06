import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A COLOUR THAT DOES NOT EXIST FAILS SILENTLY.
 *
 * `var(--bad)` with no `--bad` defined does not throw, does not warn, and does
 * not show up in a typecheck, a lint or a test. It renders the element with no
 * colour at all — which on a warning line means the sentence meant to be red
 * comes out as ordinary body text, on the screen where somebody is being told
 * their money did not arrive. `className="ll-pill rose"` is the same failure
 * wearing a class name: an unstyled pill that still says the words.
 *
 * Both of those were written in this repo while building the payout-return
 * screens, and both were caught by hand — `rose` because someone happened to
 * grep the stylesheet, `--bad` because they happened to do it twice. Nothing
 * in the toolchain was ever going to say so.
 *
 * globals.css is the only stylesheet in the project, so the set of real names
 * is knowable exactly. This asserts every name a component reaches for is in
 * it. The list starts at zero violations, so any failure here is new.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..");
const css = readFileSync(join(HERE, "globals.css"), "utf8");

/** `--teal: #137a8c;` — the definition side, not the usage side. */
const definedVars = new Set([...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
/** `.ll-pill.gold { … }` */
const definedTones = new Set([...css.matchAll(/\.ll-pill\.([a-z-]+)/g)].map((m) => m[1]));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => [p, readFileSync(p, "utf8")] as const);

/** Every `var(--x)` a component reaches for, and where. */
const usedVars = new Map<string, string[]>();
/** Every `ll-pill <tone>` a component asks for, and where. */
const usedTones = new Map<string, string[]>();
for (const [p, s] of files) {
  for (const m of s.matchAll(/var\((--[A-Za-z0-9-]+)/g)) {
    usedVars.set(m[1], [...(usedVars.get(m[1]) ?? []), p]);
  }
  for (const m of s.matchAll(/ll-pill\s+([a-z-]+)/g)) {
    usedTones.set(m[1], [...(usedTones.get(m[1]) ?? []), p]);
  }
}

const where = (m: Map<string, string[]>, k: string) =>
  [...new Set(m.get(k) ?? [])].map((p) => p.replace(SRC, "src")).join(", ");

describe("the scanner is reading real files", () => {
  it("found the stylesheet's own names", () => {
    // If globals.css moves or the patterns rot, every assertion below passes
    // against empty sets and this file becomes decoration.
    expect(definedVars.size, "no CSS variables found — globals.css moved?").toBeGreaterThan(40);
    expect(definedTones.size, "no pill tones found — the .ll-pill rules moved?").toBeGreaterThan(4);
    expect(definedVars.has("--danger")).toBe(true);
  });

  it("found the components that use them", () => {
    expect(files.length, "no source files walked").toBeGreaterThan(100);
    expect(usedVars.size, "no var(--…) usages found — the pattern stopped matching")
      .toBeGreaterThan(20);
    expect(usedTones.size, "no ll-pill tones found — the pattern stopped matching")
      .toBeGreaterThan(2);
  });
});

describe("every style a component asks for exists", () => {
  it("uses no undefined CSS variable", () => {
    const missing = [...usedVars.keys()]
      .filter((v) => !definedVars.has(v))
      .map((v) => `${v} (${where(usedVars, v)})`);
    expect(
      missing,
      "These render with no colour at all — silently, and only where somebody is looking. " +
        "Define them in globals.css or use a name that is already there.",
    ).toEqual([]);
  });

  it("asks for no pill tone that has no rule", () => {
    const missing = [...usedTones.keys()]
      .filter((t) => !definedTones.has(t))
      .map((t) => `${t} (${where(usedTones, t)})`);
    expect(
      missing,
      "These render as an unstyled pill — the words are right and the shape is missing.",
    ).toEqual([]);
  });
});
