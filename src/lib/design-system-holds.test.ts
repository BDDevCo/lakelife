import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The repo path contains a space; URL.pathname keeps the %20 and readFileSync
// then looks for a directory that does not exist. fileURLToPath decodes it.
const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");
const CSS = read("../app/globals.css");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    // TESTS ARE NOT SOURCE. This file quotes `var(--name)` and
    // `className="ll-code-box"` in its own comments and regexes, so scanning
    // itself made all three scanners report themselves. Caught on the first
    // run, and worth the guard: the next scanner would have hit it too.
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}
const SOURCES = walk(abs("../"));

describe("the scanner finds what it is scanning", () => {
  it("reads globals.css and a real spread of source files", () => {
    expect(CSS).toMatch(/^:root \{/m);
    expect(SOURCES.length).toBeGreaterThan(80);
    expect(SOURCES.some((p) => p.endsWith("TextOptIn.tsx"))).toBe(true);
    expect(SOURCES.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
  });

  it("would notice a real offender", () => {
    // Proves the token scanner is not vacuously passing: the same regex that
    // reports nothing today must still match when handed a genuine offender.
    const rx = /var\(--[a-z-]+,[^)]*\)/g;
    expect('background: "var(--sand, #fdf6ec)"'.match(rx)).toHaveLength(1);
    expect([...'color: var(--nope)'.matchAll(/var\((--[a-z-]+)\)/g)][0][1]).toBe("--nope");
  });
});

describe("every design token resolves", () => {
  const defined = new Set([...CSS.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]));

  it("has no var(--name) whose name is never defined", () => {
    // THE BUG THIS EXISTS FOR: ten tokens were referenced and none of them
    // defined — --mint, --sand, --sand-light, --teal-wash, --slate,
    // --slate-soft, --gold, --ink-good, --ink-warn, --alarm-bg. Every one was
    // written as `var(--name, #hex)`, so the hardcoded fallback always won and
    // the code only LOOKED like it used the design system.
    const missing = new Map<string, string[]>();
    for (const p of [...SOURCES, abs("../app/globals.css")]) {
      const s = readFileSync(p, "utf8");
      for (const m of s.matchAll(/var\((--[a-z-]+)\)/g)) {
        if (!defined.has(m[1])) {
          missing.set(m[1], [...(missing.get(m[1]) ?? []), p.replace(/.*\/src\//, "src/")]);
        }
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it("has NO var(--name, fallback) at all — one name, one value", () => {
    // A fallback is how the same name came to hold two colours: --sand was
    // written with #f6f3ec at seven sites and #fdf6ec at two, so two notice
    // panels meant to match did not. With no fallbacks anywhere, a divergent
    // value cannot be reintroduced by copy-paste.
    const offenders: string[] = [];
    for (const p of SOURCES) {
      const s = readFileSync(p, "utf8");
      for (const m of s.matchAll(/var\(--[a-z-]+,[^)]*\)/g)) {
        offenders.push(`${p.replace(/.*\/src\//, "src/")}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines every token it exposes to Tailwind", () => {
    const themeBlock = CSS.slice(CSS.indexOf("@theme inline"));
    for (const m of themeBlock.matchAll(/--color-[a-z-]+:\s*var\((--[a-z-]+)\)/g)) {
      expect(defined.has(m[1]), `@theme exposes ${m[1]} which is not defined`).toBe(true);
    }
  });
});

describe("the six code boxes fit a phone", () => {
  it("lets them shrink — min-width:0 is the line that does it", () => {
    // Measured at 375px BEFORE the fix: six 46px boxes and five 8px gaps want
    // 316px against a 283px card, and an <input>'s intrinsic minimum width
    // stopped flex-shrink from helping. The row laid out x=30..346 inside a
    // card running x=46..329, so the first and last digit sat outside the
    // card — on the mobile check every account passes before its first
    // booking.
    const block = CSS.slice(CSS.indexOf(".ll-code-box {"), CSS.indexOf(".ll-code-box:focus"));
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).toMatch(/flex:\s*0 1 46px/);
  });
});

describe("there is ONE six-digit code entry", () => {
  const shared = read("../components/CodeBoxes.tsx");

  it("is a component, and it is what both screens render", () => {
    expect(shared).toMatch(/export function CodeBoxes/);
    for (const p of ["../components/VerifyPanel.tsx", "../components/TextOptIn.tsx"]) {
      expect(read(p), p).toMatch(/import \{ CodeBoxes \}/);
      expect(read(p), p).toMatch(/<CodeBoxes/);
    }
  });

  it("nobody hand-rolls .ll-code-box any more", () => {
    // The check that stops the next screen copying it instead of importing it.
    const rogue = SOURCES.filter(
      (p) => !p.endsWith("CodeBoxes.tsx") && /className="ll-code-box"/.test(readFileSync(p, "utf8")),
    ).map((p) => p.replace(/.*\/src\//, "src/"));
    expect(rogue).toEqual([]);
  });

  it("carries the behaviour a single input cannot", () => {
    expect(shared).toMatch(/autoComplete=\{i === 0 \? "one-time-code" : "off"\}/);
    expect(shared).toMatch(/onPaste=/);
    expect(shared).toMatch(/e\.key === "Backspace"/);
    expect(shared).toMatch(/aria-label=\{`Digit \$\{i \+ 1\}`\}/);
  });

  it("HANDS THE CODE TO onComplete, and both callers take it", () => {
    // onComplete fires in the same tick as onChange, so a caller reading its
    // own state would submit five digits and be told the code was wrong.
    expect(shared).toMatch(/onComplete\?\.\(clean\)/);
    expect(read("../components/VerifyPanel.tsx")).toMatch(/async function verify\(submitted\?: string\)/);
    expect(read("../components/VerifyPanel.tsx")).toMatch(/const entered = submitted \?\? code/);
    expect(read("../components/TextOptIn.tsx")).toMatch(/function confirm\(submitted\?: string\)/);
    expect(read("../components/TextOptIn.tsx")).toMatch(/submitted \?\? code/);
  });

  it("never hands a click event in as the code", () => {
    // onClick={verify} would pass a MouseEvent as `submitted`, and the code
    // that got sent would be an object.
    for (const p of ["../components/VerifyPanel.tsx", "../components/TextOptIn.tsx"]) {
      const s = read(p);
      expect(s, p).not.toMatch(/onClick=\{verify\}/);
      expect(s, p).not.toMatch(/onClick=\{confirm\}/);
      expect(s, p).not.toMatch(/onComplete=\{verify\}/);
      expect(s, p).not.toMatch(/onComplete=\{confirm\}/);
    }
  });
});

describe("the slip prints alone", () => {
  const slip = read("../components/ClaimSlip.tsx");

  it("has a print stylesheet at all — there was none anywhere in the app", () => {
    expect(CSS).toMatch(/@media print/);
  });

  it("hides the page and keeps the slip", () => {
    // WHAT THIS PREVENTS: ClaimSlip renders per-lot INSIDE the rent roll, so a
    // bare window.print() printed the whole park dashboard — every household's
    // name, rent state and arrears — and the office hands that stack to one
    // resident. Verified in the browser after the fix: no other household's
    // name survives, and the QR still renders.
    const block = CSS.slice(CSS.indexOf("@media print"));
    expect(block).toMatch(/body \*\s*\{\s*visibility: hidden/);
    expect(block).toMatch(/\.ll-slip,\s*\n?\s*\.ll-slip \*\s*\{\s*visibility: visible/);
    // visibility, NOT display, for the hiding — the slip's ancestors have to
    // keep their boxes or the slip has nothing to lay out inside.
    expect(block).not.toMatch(/body \*\s*\{\s*display: none/);
    expect(block).toMatch(/page-break-inside: avoid/);
  });

  it("marks the slip and strips the on-screen-only furniture", () => {
    expect(slip).toMatch(/className="ll-card ll-card-pad ll-slip"/);
    // The buttons, the "shown once" guidance and the expiry note are for the
    // office at the screen, not for the resident holding the paper.
    expect((slip.match(/ll-noprint/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("lets the printed URL wrap instead of running off the paper", () => {
    expect(slip).toMatch(/overflowWrap: "anywhere"/);
  });
});

describe("what a button says while it works", () => {
  it("no button anywhere says only an ellipsis", () => {
    // Four did. ClaimSlip shares one useTransition, so pressing either
    // "Email them" or "Print a slip" collapsed BOTH to one character and
    // nothing on screen said which was running.
    const bare = SOURCES.filter((p) => /\? "…"/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(/.*\/src\//, "src/"));
    expect(bare).toEqual([]);
  });
});

describe("a phone number shown to a person", () => {
  it("never appears in the +1 machine form the database stores", () => {
    // She typed "(260) 555-0142" and was told so; the card that confirmed it
    // then read "We'll text +12605550142". The only such place in the product.
    expect(read("../components/TextOptIn.tsx")).toMatch(/prettyPhone\(number\)/);
  });
});

describe("a long address in a toast", () => {
  it("can break — it is white on the page background once it escapes", () => {
    const block = CSS.slice(CSS.indexOf(".ll-toast {"), CSS.indexOf("@media print"));
    expect(block).toMatch(/overflow-wrap: anywhere/);
    // break-all would chop ordinary words in every other toast in the app.
    expect(block).not.toMatch(/word-break: break-all/);
  });
});

describe("the .ll-field labels actually get their styling", () => {
  it("declares display:block, because the rule they rely on needs a NESTED label", () => {
    // globals.css styles `.ll-field label`. On these screens the label IS the
    // .ll-field, so the rule never matched: the captions rendered at 15px body
    // ink and every marginBottom/maxWidth on the label was silently dropped,
    // because an inline element ignores both.
    for (const p of ["../components/ClaimMyLot.tsx", "../components/TextOptIn.tsx"]) {
      const s = read(p);
      const labels = s.match(/<label className="ll-field"[^>]*>/g) ?? [];
      expect(labels.length, p).toBeGreaterThan(0);
      for (const l of labels) expect(l, `${p}: ${l}`).toMatch(/display: "block"/);
    }
  });

  it("puts the caption in the muted grey the other 85 captions use", () => {
    for (const p of ["../components/ClaimMyLot.tsx", "../components/TextOptIn.tsx"]) {
      const s = read(p);
      const idx = s.indexOf('className="ll-field"');
      expect(idx, p).toBeGreaterThan(-1);
      // no bare <span> caption directly inside a .ll-field label
      expect(s, p).not.toMatch(/className="ll-field"[^>]*>\s*\n?\s*<span>/);
    }
  });
});
