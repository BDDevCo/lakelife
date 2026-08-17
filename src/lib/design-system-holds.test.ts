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
  it("is DISPLAY:BLOCK in the stylesheet, so no component has to remember", () => {
    // 115 of 187 uses put `className="ll-field"` on the <label> itself, and a
    // <label> is inline by default. An inline box discards vertical margin and
    // max-width — so `.ll-field { margin-bottom: 14px }` did nothing on those,
    // and neither did any marginBottom or maxWidth the component asked for.
    // TextOptIn wanted a 300px mobile field and got one the full card width.
    // 27 components had worked this out and said display:"block" inline; the
    // other 88 had not. It belongs in the class.
    const block = CSS.slice(CSS.indexOf(".ll-field {"), CSS.indexOf(".ll-field label"));
    expect(block).toMatch(/display: block/);
    expect(block).toMatch(/margin-bottom: 14px/);
  });

  it("has NO bare <span> caption left on a .ll-field label, app-wide", () => {
    // `.ll-field label { font-size: 12.5px; font-weight: 700; color: var(--sub) }`
    // needs a NESTED label. Where the label IS the .ll-field the rule can never
    // match, so a caption in a classless <span> rendered as plain body text —
    // 15px, full dark ink, indistinguishable from content. Measured on
    // /park/amenities before the fix: 15px / 400 / rgb(32,52,61).
    // 22 of them, across ParkAmenities, ParkCostSchedules, ParkImportPaste and
    // ParkImportRead. The other 89 captions already carried className="mut".
    const offenders: string[] = [];
    for (const p of SOURCES) {
      const s = readFileSync(p, "utf8");
      for (const m of s.matchAll(/<label[^>]*className="ll-field[^"]*"[^>]*>\s*<span>/g)) {
        offenders.push(`${p.replace(/.*\/src\//, "src/")}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does NOT blanket-style every direct span — three of them are not captions", () => {
    // The tempting one-line fix is `.ll-field label, .ll-field > span { … }`.
    // It is wrong: ParkDials and ParkOnlineRent put THREE direct spans in the
    // label — the caption, a flex row that CONTAINS THE INPUT, and a hint. The
    // selector would make the input's wrapper 12.5px bold grey with a 6px
    // bottom margin, and turn every hint bold. Measured before rejecting it.
    expect(CSS).not.toMatch(/\.ll-field\s*>\s*span\s*\{/);
    expect(CSS).not.toMatch(/\.ll-field label,\s*\.ll-field\s*>\s*span/);
  });
});

describe("every control has a box", () => {
  it("styles bare inputs, not only the ones inside a .ll-field", () => {
    // Tailwind v4's preflight resets controls to `border:0; padding:0;
    // background:transparent`, and the only input rule here was scoped to
    // `.ll-field input`. Measured on /park/onboard — the screen where a new
    // owner types in every household by hand — twelve fields rendered with
    // computed border 0px, padding 0px, transparent background, 23px tall.
    // Nothing on screen said they were fields.
    const base = CSS.slice(CSS.indexOf("input:not([type=\"checkbox\"])"));
    expect(CSS).toMatch(/^input:not\(\[type="checkbox"\]\)/m);
    expect(base).toMatch(/border: 1\.5px solid var\(--line\)/);
    expect(base).toMatch(/font-size: 16px/);   // the same iOS-zoom floor
  });

  it("leaves checkboxes and radios alone", () => {
    // A bordered, padded checkbox is worse than a bare one.
    const sel = CSS.slice(CSS.indexOf("input:not("), CSS.indexOf("select,\ntextarea {"));
    for (const t of ["checkbox", "radio", "range", "file"]) {
      expect(sel, t).toContain(`:not([type="${t}"])`);
    }
  });

  it("keeps the code box's own size — the base padding would squeeze the digit", () => {
    const block = CSS.slice(CSS.indexOf(".ll-code-box {"), CSS.indexOf(".ll-code-box:focus"));
    expect(block).toMatch(/padding: 0/);
  });
});
