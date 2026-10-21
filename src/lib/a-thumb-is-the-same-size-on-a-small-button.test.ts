import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * THE 44px FLOOR EXISTS, IS COMMENTED, AND WAS BEING UNDONE INLINE IN 30 PLACES.
 *
 * `globals.css:312` gives `.ll-btn.sm` a `min-height: 44px` under a ten-line
 * comment that names the person it is for: the crew's route card is "SEVEN of
 * these in a wrapping row, tapped in a truck at 7am with gloves on", and a
 * miss "opens the camera instead of closing the job".
 *
 * An inline style beats a class rule. Measured live in a browser on 20 Oct
 * 2026, at 375px:
 *
 *     .ll-btn ......................................... 43.7px
 *     .ll-btn ghost ................................... 46.7px
 *     .ll-btn sm ...................................... 44.0px   <- the rule working
 *     .ll-btn ghost sm + style={{ minHeight: 36 }} .... 37.1px   <- undone
 *     .ll-btn ghost + fontSize 12 + padding 3px 8px ... 27.6px   <- undone another way
 *
 * TWENTY-SEVEN sites carried an inline `minHeight` of 36 to 40. Four were
 * DESTRUCTIVE Yes/No pairs 6px apart with Yes first — "Take them off lot 12?
 * If it's already billed, that bill is cancelled" — where a thumb aimed at No
 * cancels a household's bill.
 *
 * THREE MORE DEFEATED THE SAME FLOOR WITHOUT TOUCHING minHeight AT ALL, by
 * overriding padding, and they were the three controls that move real money:
 * "Refund to card", "Take it back", and the signing action beside them, all
 * at 27.6px — the smallest buttons in the product.
 *
 * So this file checks BOTH shapes. A rule that only looked at `minHeight`
 * would have passed the money buttons.
 *
 * AND THE HISTORY IS WHY THE TEST MATTERS MORE THAN THE 30 EDITS. Commit
 * 9748294 (10 Sep 2026) added the rule and its message says "Measured live
 * afterwards: ll-btn, ll-btn sm, ll-btn ghost sm and ll-btn gold sm all
 * report 44." Its diff touched ONE file — globals.css — and never opened a
 * component. ClaimSlip's 36s already existed and survived it, and
 * ParkRentRoll's four were added AFTER it, on 11 and 15 September. The rule
 * shipped, the claim was false, and new code kept copying the old pattern.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));
const CSS = readFileSync(join(SRC, "app/globals.css"), "utf8");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { tsxFiles(p, out); continue; }
    if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** JSX comments and line-leading block comments only — a `/*` inside an
 *  attribute value like `accept="image/*"` is not a comment. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

interface Btn { file: string; line: number; cls: string; tag: string }

/** Every JSX element whose className mentions ll-btn, with its whole tag. */
function buttons(): Btn[] {
  const found: Btn[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/<(?:button|a|label|div)\b[\s\S]{0,420}?>/g)) {
      const tag = m[0];
      const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(tag);
      const value = cls?.[1] ?? cls?.[2] ?? "";
      if (!/\bll-btn\b/.test(value)) continue;
      found.push({
        file: file.replace(SRC, ""),
        line: src.slice(0, m.index).split("\n").length,
        cls: value,
        tag,
      });
    }
  }
  return found;
}

const BTNS = buttons();

describe("the scanner sees the buttons at all", () => {
  it("finds a realistic number of .ll-btn elements", () => {
    // Every assertion below is an absence, and an absence over an empty list
    // is the quietest way for a source scan to die.
    expect(BTNS.length, "the .ll-btn scanner found almost nothing — repoint it")
      .toBeGreaterThan(80);
  });

  it("and the rule it is defending still exists in the stylesheet", () => {
    // If globals.css loses the floor, this whole file is guarding nothing and
    // should fail loudly rather than keep passing.
    const sm = CSS.slice(CSS.indexOf(".ll-btn.sm"), CSS.indexOf(".ll-btn.sm") + 900);
    expect(sm, "the 44px floor is gone from .ll-btn.sm").toMatch(/min-height:\s*44px/);
    expect(sm, "the comment explaining WHY is gone").toMatch(/truck at 7am/);
  });
});

describe("nothing undoes the floor with minHeight", () => {
  it("NO .ll-btn CARRIES AN INLINE minHeight BELOW 44", () => {
    const bad = BTNS.flatMap((b) => {
      const m = /minHeight:\s*(\d+)/.exec(b.tag);
      if (!m || Number(m[1]) >= 44) return [];
      return [`${b.file}:${b.line} minHeight ${m[1]} [${b.cls}]`];
    });
    expect(
      bad.join("\n"),
      "an inline minHeight is undoing globals.css:312's 44px floor. Delete it — `.sm` already " +
      "keeps the lighter 13px type and tighter sides, it just stops being harder to hit.",
    ).toBe("");
  });
});

describe("and nothing undoes it with padding, which is how the money buttons slipped through", () => {
  it("NO .ll-btn WITHOUT .sm CARRIES AN INLINE VERTICAL PADDING BELOW 11px", () => {
    /**
     * `.ll-btn` has NO min-height of its own — it reaches 43.7px from
     * `padding: 11px 20px` alone, which a smaller inline padding silently
     * removes. `.ll-btn.sm` is safe from this because its 44px floor wins
     * whatever the padding says, which is exactly why the fix for the three
     * money buttons was to add `sm` rather than to tune their padding.
     */
    const bad = BTNS.flatMap((b) => {
      if (/\bsm\b/.test(b.cls)) return [];
      const m = /padding:\s*"(\d+)px/.exec(b.tag);
      if (!m || Number(m[1]) >= 11) return [];
      return [`${b.file}:${b.line} padding ${m[1]}px [${b.cls}]`];
    });
    expect(
      bad.join("\n"),
      "an inline padding is shrinking a .ll-btn below the 44px a thumb needs, and there is no " +
      "min-height on plain .ll-btn to catch it. Add `sm` to the className instead.",
    ).toBe("");
  });

  it("the three money buttons are specifically .sm now", () => {
    // Named, because these are the ones that move real money out of a park
    // owner's own account and they were the smallest controls in the product.
    const statements = stripComments(readFileSync(join(SRC, "components/ParkStatements.tsx"), "utf8"));
    expect(statements, "a money button went back to an inline padding override")
      .not.toMatch(/ll-btn ghost"\s+style=\{\{\s*fontSize: 12, padding: "3px 8px"/);
    expect((statements.match(/className="ll-btn ghost sm"/g) ?? []).length)
      .toBeGreaterThanOrEqual(3);
  });
});

describe("the destructive pairs are the sharp end", () => {
  it("Yes/No confirmations are full-size, on both screens that cancel a bill", () => {
    // ClaimSlip detaches a resident's account; ParkRentRoll's reads "Take them
    // off lot 12? If it's already billed, that bill is cancelled." Both put
    // Yes FIRST, 6px from No. At 36px with a ~38px thumb, aiming at No and
    // landing on Yes cancels a household's bill.
    for (const f of ["components/ClaimSlip.tsx", "components/ParkRentRoll.tsx"]) {
      const src = stripComments(readFileSync(join(SRC, f), "utf8"));
      expect(src, `${f} has an inline minHeight on a confirmation again`)
        .not.toMatch(/minHeight: 3\d/);
    }
  });
});
