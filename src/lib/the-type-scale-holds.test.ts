import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * THE TYPE SCALE, PINNED — because deciding it was not enough.
 *
 * On 11 September 2026 the owner asked for "fonts, formatting and all the UI
 * cohesive", and the scale was settled against `lakelife.html`, which CLAUDE.md
 * makes the authority:
 *
 *     page title .................. 26   (prototype .sec-title override, :506/:699)
 *     heading INSIDE a .ll-card ... 16   (prototype :539,:557,:602,:614,:705,:731 —
 *                                         seven `<b style="font-size:16px">`, and
 *                                         the prototype's only 18s are a route-stat
 *                                         number and an emoji, neither a heading)
 *     section heading BETWEEN cards 20   (prototype .sec-title default)
 *
 * The park module was realigned and the matter was considered closed.
 *
 * IT WAS NOT. On 20 October 2026 a sweep found THIRTY-ONE in-card headings at
 * 18 against eighty-nine already at 16 — and the offenders were NEW:
 * ParkDials and OpsToday (14 Oct), ParkMoneyInFlight (17 Oct). Every card
 * written after the sweep drifted straight back, because the rule lived in a
 * memory and a commit message and nothing in the suite could see it.
 *
 * The proof that nothing could see it: changing all thirty-one left 8,012
 * tests green.
 *
 * The clearest evidence a person would notice: `VendorStorage.tsx:210` and
 * `VendorOnboarding.tsx:342` were the IDENTICAL `h3 / margin: 0 / flex: 1`
 * pattern, both crew-facing, one at 16 and one at 18.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT PIN
 * ---------------------------------------------------------------------------
 * SECTION headings — the ones that sit BETWEEN cards rather than inside one.
 * The prototype says 20, but that sweep was never run and several candidates
 * were refuted at the time as "reads as hierarchy". Nine of them sit at 18
 * today. Forcing them here would be this test inventing a decision rather than
 * holding one, so the scanner classifies them and leaves them alone — and the
 * count is asserted below, so if somebody converts one it has to be deliberate.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { tsxFiles(p, out); continue; }
    if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(p);
  }
  return out;
}

const indentOf = (s: string) => s.length - s.replace(/^\s*/, "").length;

/**
 * Is this line's heading inside a `.ll-card`?
 *
 * By INDENTATION, walking out to each ancestor opening tag and reading its
 * whole attribute block. The first version of this scanner looked for
 * `ll-card` and `<div` on the SAME line and got three of the first three spot
 * checks wrong, because `className` very often sits on its own line:
 *
 *     <div
 *       className="ll-card ll-card-pad"
 *       style={{ ... }}
 *     >
 *
 * It called ParkMoneyInFlight and OpsToday section headings when both are in
 * cards. A classifier that is wrong is worse than no classifier, because it
 * would have rewritten twenty-five headings nobody asked it to touch.
 */
function insideCard(lines: string[], idx: number): boolean {
  let i = idx;
  let want = indentOf(lines[idx]);
  while (i > 0) {
    i -= 1;
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) >= want) continue;
    if (/<(div|section|main|article|form|aside)\b/.test(l)) {
      let block = l;
      for (let j = i; j < idx && j - i < 12 && !block.split("<").slice(1).join("<").includes(">"); ) {
        j += 1; block += " " + lines[j];
      }
      if (block.includes("ll-card")) return true;
      want = indentOf(l);
    } else if (/<>|<React\.Fragment/.test(l)) {
      want = indentOf(l);
    }
  }
  return false;
}

interface Heading { file: string; line: number; tag: string; size: number; inCard: boolean; text: string }

const headings: Heading[] = [];
for (const file of tsxFiles(SRC)) {
  const raw = readFileSync(file, "utf8");
  // Comments can carry example markup; strip them before scanning.
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = stripped.split("\n");
  lines.forEach((l, i) => {
    const tag = /<(h[1-6])\b/.exec(l);
    const size = /fontSize:\s*(\d+)/.exec(l);
    if (!tag || !size) return;
    headings.push({
      file: file.replace(SRC, ""), line: i + 1, tag: tag[1], size: Number(size[1]),
      inCard: insideCard(lines, i), text: l.trim().slice(0, 70),
    });
  });
}

const inCard = headings.filter((h) => h.inCard);
const sections = headings.filter((h) => !h.inCard);

describe("the scanner is actually finding things", () => {
  it("finds a realistic number of headings, or everything below is vacuous", () => {
    // Every assertion in this file is "none of them is wrong". That passes
    // triumphantly over an empty list, which is how a source scan dies quietly.
    expect(headings.length, "the heading scanner found almost nothing — repoint it")
      .toBeGreaterThan(100);
    expect(inCard.length, "the in-card classifier matched nothing").toBeGreaterThan(80);
    expect(sections.length, "the classifier thinks every heading is in a card")
      .toBeGreaterThan(5);
  });

  it("and it classifies the three cases that were checked BY HAND on 20 Oct", () => {
    // Two in cards whose className sits on its own line, one real <section>.
    // These are the exact three that broke the first classifier.
    const at = (f: string, n: number) => headings.find((h) => h.file.includes(f) && h.line === n);
    expect(at("ParkMoneyInFlight", 86)?.inCard, "ParkMoneyInFlight:86 is inside a card").toBe(true);
    expect(at("OpsToday", 59)?.inCard, "OpsToday:59 is inside a card").toBe(true);
    expect(at("ParkFees", 125)?.inCard, "ParkFees:125 is a <section>, not a card").toBe(false);
  });
});

describe("nothing inside a card is 18", () => {
  /**
   * THE ASSERTION IS "NOT 18", NOT "ALWAYS 16", AND THE DIFFERENCE IS THE POINT.
   *
   * The first draft of this file asserted every in-card heading is 16 and
   * immediately caught ten headings at 17, 20 and 22 — "Please sign in",
   * "Sign in to see this", "Set up your place first". Those are not headings
   * above content; they are EMPTY-STATE AND GATE CARDS where the heading IS
   * the card's whole message, plus a couple of nav tiles at 17.
   *
   * Whether those should be 16 is a hierarchy question that was never settled
   * — the 11 Sep audit explicitly refuted several candidates as "reads as
   * hierarchy" — and a test is the wrong place to settle it. So this holds the
   * line that IS settled, the one the memory states categorically and the
   * prototype supports: **nothing in a card is 18.**
   */
  it("NO HEADING INSIDE A .ll-card IS 18", () => {
    const wrong = inCard.filter((h) => h.size === 18);
    expect(
      wrong.map((h) => `${h.file}:${h.line} — ${h.text}`).join("\n"),
      "an in-card heading is back at 18; the prototype's seven card headings are all 16, " +
      "and its only 18s are a route-stat number and an emoji",
    ).toBe("");
  });

  it("and 16 is the MODE by a clear margin, so the convention is real", () => {
    /**
     * Measured 20 Oct 2026, after the fix:
     *
     *     16px  111   <- the convention
     *     22px   42   \  empty-state and gate cards, where the heading IS the
     *     20px   34   /  card's whole message ("Please sign in")
     *     17px   22      a sub-heading family
     *     26px    3      page titles that happen to sit in a card
     *     15px    6 · 24px 2 · 14px 1
     *     18px    0   <- was 31
     *
     * So 16 is half of all in-card headings and more than double the next
     * value. A share threshold would be the wrong assertion — this is a
     * multi-valued distribution on purpose — but the MODE is the real claim,
     * and if 16 ever stops being it then "not 18" is holding a line nobody
     * else is standing on and this whole file should be revisited.
     */
    const counts = new Map<number, number>();
    for (const h of inCard) counts.set(h.size, (counts.get(h.size) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0], "16 is no longer the most common in-card heading size").toBe(16);
    expect(ranked[0][1]).toBeGreaterThan(100);
    expect(ranked[0][1], "16 is no longer a clear mode").toBeGreaterThan(ranked[1][1] * 2);
  });
});

describe("an APP page title is 26", () => {
  /**
   * TWO FAMILIES, and conflating them was the first draft's other mistake.
   *
   * App screens are 26 — the prototype's .sec-title override at :506 ("The
   * logistics brain") and :699 ("Today's route"), both app screens. Thirty-odd
   * already are.
   *
   * The PUBLIC and LEGAL pages are 28 to 32: the marketing landing pages, the
   * lake and park directories, terms, privacy, SMS and referral terms. Those
   * are hero titles on pages a stranger lands on, they are consistent among
   * themselves, and the prototype's app-screen override says nothing about
   * them. Left alone.
   *
   * Three app screens were found at 24 on 20 Oct — the crew's job detail,
   * MyAgreements and RenterHome — the same drift the park had before ae65356.
   */
  const PUBLIC = /^app\/(for-parks|lakes|parks|privacy|terms|sms|referral-terms)\//;

  it("every app-screen h1 with an explicit size is 26", () => {
    const wrong = headings.filter(
      (h) => h.tag === "h1" && h.size !== 26 && !PUBLIC.test(h.file.replace(/^\//, "")),
    );
    expect(
      wrong.map((h) => `${h.file}:${h.line} is ${h.size} — ${h.text}`).join("\n"),
      "an app page title is not 26",
    ).toBe("");
  });

  it("there ARE app h1s, so the rule is not passing over an empty list", () => {
    const app = headings.filter((h) => h.tag === "h1" && !PUBLIC.test(h.file.replace(/^\//, "")));
    expect(app.length, "no app h1s found — repoint this").toBeGreaterThan(20);
  });

  it("and the public pages are left at their own larger scale", () => {
    // Asserted so that "fixing" them to 26 has to be a decision made here,
    // not a side effect of someone widening the rule above.
    const pub = headings.filter((h) => h.tag === "h1" && PUBLIC.test(h.file.replace(/^\//, "")));
    expect(pub.length).toBeGreaterThan(4);
    for (const h of pub) {
      expect(h.size, `${h.file}:${h.line} left the public 28-32 band`).toBeGreaterThanOrEqual(28);
      expect(h.size).toBeLessThanOrEqual(32);
    }
  });
});

describe("the section headings are left alone ON PURPOSE", () => {
  it("they still exist, and this test is not quietly converting them", () => {
    // The prototype says 20 and that sweep was never run; several candidates
    // were refuted as "reads as hierarchy". If somebody later decides it, this
    // number moves and they have to come here and say so.
    const eighteens = sections.filter((h) => h.size === 18);
    expect(eighteens.length, "section headings at 18 changed count — was that deliberate?")
      .toBeGreaterThan(0);
    expect(eighteens.length).toBeLessThanOrEqual(12);
  });
});
