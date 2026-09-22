import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dayInWords } from "@/app/park/park-helpers";
import { lakeDateOf } from "@/lib/booking";

/**
 * THE DAY THE NOTICE HOLD WENT ON, PRINTED ONCE.
 *
 * The setup screen shows the readiness row and this card one above the other.
 * The row converts parks.notices_held_at with lakeDateOf and prints it with
 * dayInWords; the card sliced the raw stamp to ten characters. So one screen
 * carried two spellings of one fact — "Notices on hold since December 20,
 * 2026" and, inches below, "On hold · since 2026-12-21" — and on any hold set
 * after 7pm in Indiana the card's was the wrong day.
 *
 * These run the card's OWN expression, lifted out of the component, against
 * the real helpers, and compare it with the row's.
 */

const src = readFileSync(fileURLToPath(new URL("./NoticeHold.tsx", import.meta.url)), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * What the card renders after "since ", run rather than restated — the real
 * expression, handed the real helpers.
 */
function cardSince(): (heldAt: string) => string {
  const expr = src.match(/since \{([^\n]+)\}\s*\n/)?.[1] ?? "";
  expect(expr, "the card's 'since' line is gone — this scan measures nothing").not.toBe("");
  const compiled = new Function("heldAt", "dayInWords", "lakeDateOf", `return ${expr};`) as (
    heldAt: string,
    d: typeof dayInWords,
    l: typeof lakeDateOf,
  ) => string;
  return (heldAt: string) => compiled(heldAt, dayInWords, lakeDateOf);
}

/** What the readiness row renders for the same column (readiness.ts). */
const rowSince = (heldAt: string) => dayInWords(lakeDateOf(heldAt) ?? "");

describe("the hold's 'since' day agrees with the readiness row above it", () => {
  const card = cardSince();

  it("an evening hold in Indiana is TODAY, not tomorrow in UTC", () => {
    // 9pm on 20 December at the lakes.
    expect(card("2026-12-21T02:00:00Z")).toBe("December 20, 2026");
    expect(card("2026-12-21T02:00:00Z")).toBe(rowSince("2026-12-21T02:00:00Z"));
    // Closing evening.
    expect(card("2026-12-16T03:30:00Z")).toBe("December 15, 2026");
    expect(card("2026-12-16T03:30:00Z")).toBe(rowSince("2026-12-16T03:30:00Z"));
  });

  it("a daytime hold, where the slice happened to agree, still reads in words", () => {
    expect(card("2026-08-26T04:14:00Z")).toBe("August 26, 2026");
    expect(card("2026-08-26T14:14:00Z")).toBe("August 26, 2026");
  });

  it("a stamp that will not parse still prints something rather than nothing", () => {
    // dayInWords hands back what it cannot read, so the ten-character
    // fallback survives as itself rather than becoming a blank.
    expect(card("not-a-date")).toBe("not-a-date");
  });

  it("no ISO string reaches the screen — a date a person reads is words", () => {
    for (const stamp of ["2026-12-21T02:00:00Z", "2026-08-26T04:14:00Z"]) {
      expect(card(stamp)).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(src).not.toMatch(/since \{heldAt\.slice\(0, 10\)\}/);
  });

  it("collapsed back to the slice, the evening hold names the wrong day", () => {
    // Non-vacuous: the pre-fix expression on the same stamps.
    const sliced = (heldAt: string) => heldAt.slice(0, 10);
    expect(sliced("2026-12-21T02:00:00Z")).toBe("2026-12-21");
    expect(sliced("2026-12-21T02:00:00Z")).not.toBe(rowSince("2026-12-21T02:00:00Z"));
  });
});
