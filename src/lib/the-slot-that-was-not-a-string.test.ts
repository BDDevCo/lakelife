import { describe, it, expect } from "vitest";
import { slotLabel } from "./shot-list";
import { photoStripHtml } from "./photo-strip";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE ONE THING THE WEB-PAGE AUDIT FOUND, AND IT IS NOT AN INJECTION.
 *
 * 174 interpolations across every HTML-serving page were traced to their
 * source. The escaping holds: one shared `escapeHtml` covering all five
 * characters serves the four token routes, and every user-typed value that
 * reaches those pages goes through it into a text node or a quoted attribute.
 * No XSS.
 *
 * What it found instead is a CRASH on the customer's only complaint channel.
 *
 *   `KNOWN` in shot-list.ts is an object literal, so it inherits from
 *   Object.prototype. `slotLabel("constructor")` hits the unguarded
 *   `if (KNOWN[key])`, finds the inherited Object constructor — truthy — and
 *   returns a FUNCTION from a function whose signature says string. The photo
 *   strip then calls `esc(label)` and dies with "s.replace is not a function".
 *
 *   `photoStripHtml` runs inside GET on /c/[token]/issue and, via htmlPage, on
 *   /c/[token]/good. Those are the 👍 and 👎 links in the completion text —
 *   the ONLY channel a customer has to say the work was wrong. Route handlers
 *   here have no error boundary, so it is a bare 500 on their phone, on every
 *   tap, permanently, for somebody with no session and nowhere else to go.
 *
 * AND THE COMMENT ABOVE THE WRITER SAYS IT CANNOT HAPPEN. uploadJobPhoto's
 * comment reads "Free text is refused rather than stored: a typo'd slot is
 * worse than none". The code clamps to 40 characters and stores whatever it
 * was given. Copy that lies, on a validation claim, guarding an evidence
 * column — and the value it admits is the one that breaks the page.
 */

describe("a slot is a string, whatever the caller sent", () => {
  it("returns a string for an inherited key instead of Object's own machinery", () => {
    // The two that survive `.trim().toLowerCase()`. (`toString`/`valueOf`/
    // `hasOwnProperty` are camelCased on the prototype, so lowercasing already
    // misses them — which is why this hid.)
    for (const key of ["constructor", "__proto__"]) {
      expect(typeof slotLabel(key), `slotLabel(${key}) is not a string`).toBe("string");
    }
  });

  it("de-slugs them like any other unknown slot", () => {
    // The header calls KNOWN "NOT a whitelist" on purpose: an unknown slot is
    // de-slugged rather than dropped, because dropping it would show a crew a
    // shorter walk-around than the service asks for. That must still hold.
    expect(slotLabel("constructor")).toBe("Constructor");
    expect(slotLabel("__proto__")).toBe("Proto");
    expect(slotLabel("fuel_line")).toBe("Fuel line");
  });

  it("still labels the slots it knows", () => {
    // The other half of the mutation: hardening the lookup must not break it.
    expect(slotLabel("hull")).toBe("Hull");
    expect(slotLabel("cover_or_wrap")).toBe("Cover / wrap");
    expect(slotLabel("  Starboard_Side  ")).toBe("Starboard side");
  });
});

describe("the customer's complaint door survives a crew's photo", () => {
  const photo = (slot: string) => ({ url: "https://example.invalid/p.jpg", slot });

  it("renders rather than throwing", () => {
    // photoStripHtml is called inside GET with no error boundary above it.
    // A throw here is a 500 on the phone of somebody trying to tell us the
    // work was wrong.
    for (const slot of ["constructor", "__proto__", "hull", "fuel_line"]) {
      expect(() => photoStripHtml([photo(slot) as never]), `slot=${slot} threw`).not.toThrow();
    }
  });

  it("escapes what it renders", () => {
    // Unchanged by the fix, and worth pinning while we are here: the label
    // lands in a text node and in a quoted alt attribute, and `esc` covers
    // all five characters.
    const out = photoStripHtml([photo(`x" onerror="alert(1)`) as never]);
    expect(out).not.toContain('onerror="alert(1)"');
    expect(out).toContain("&quot;");
  });
});

describe("the comment above the writer tells the truth now", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = readFileSync(
    fileURLToPath(new URL("../app/vendor/actions.ts", import.meta.url)), "utf8",
  );

  it("actually refuses a slot that is not a slug", () => {
    // The comment claimed "Free text is refused rather than stored" while the
    // code clamped to 40 characters and stored anything. Either the code or
    // the sentence had to move; the code moved.
    // MATCHING THE CALL, NOT THE MENTION. An earlier version of this
    // assertion looked for the name `SLOT_SHAPE` anywhere in the file, so
    // reverting the writer to the old clamp — leaving the constant declared
    // and unused — sailed straight past it.
    expect(strip(src), "SLOT_SHAPE is declared but nothing tests against it")
      .toMatch(/SLOT_SHAPE\.test\(/);
    expect(strip(src), "the slot is still stored by a bare length clamp")
      .not.toMatch(/rawSlot\.trim\(\)\.slice\(0,\s*40\)/);
  });

  it("no longer claims a refusal it does not perform", () => {
    expect(src).not.toContain("Free text is refused rather than stored");
  });
});
