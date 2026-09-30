import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NOTHING IN THIS TREE MAY PROMISE A TEXT THAT WILL NOT ARRIVE.
 *
 * There was already a scanner for this — public-pages-claim-only-what-is-built
 * — and it is a good one: it strips comments, normalises &apos; and line
 * wraps, and proves against the live string that it would have caught the
 * sentence it was written for. But it reads ELEVEN FILES, held as a literal
 * PUBLIC_PAGES list, because "public" is not a property of a path. That was
 * the right shape for the question it asked. It leaves 522 of the 533
 * non-test files in src unread, and the promise reopened in four of them.
 *
 * WHAT REOPENED IT. "You'll get a text either way" sat on three crew screens
 * at once — the arrival sheet's notice, its toast, and `completionBlock`,
 * which is drawn on the route card, the job page and the server's refusal —
 * and "we'll text the customer that you're coming back" on the make-it-right
 * page. app/approvals/actions.ts admits the shape in its own header: every
 * screen in the arrival flow promised a text and nothing sent one. The SEND
 * was added; the CHANNEL WORD was never taken out. So the crew was told to
 * stand in a driveway and wait for a message that carriers drop.
 *
 * 0 of 81 texts delivered since 19 July. The A2P Brand was approved 24 Sep
 * 2026; there is STILL NO CAMPAIGN, and carriers route on the campaign, so a
 * brand alone delivers nothing. Approval is not delivery.
 *
 * ============ WHAT THIS BANS, AND WHAT IT DELIBERATELY DOES NOT ============
 *
 * ONLY A PROMISE THAT A TEXT WILL ARRIVE. Not "Text messages" as the name of
 * a channel, not a preference row offering a text switch, not "we verify by
 * text" (Verify rides Twilio's managed pool and genuinely works), and not
 * "we will never phone or text you asking for this code", which is the
 * sentence that protects a resident from the person who does.
 *
 * AND NOT CONSENT-MOMENT COPY. On 19 August the owner was asked and said no:
 * do not rewrite consent language for a temporary outage. "We'll text you
 * about your lot and your rent" describes what somebody is agreeing to and
 * becomes true when registration clears. Those files are in ALLOWED with that
 * reason, in code, so the next audit reads the decision instead of
 * re-proposing the change.
 *
 * ============ WHEN TEXTS ARE REALLY WORKING ============
 *
 * Delete a phrase from PROMISED and say so in the commit message. The bar is
 * a delivered message this product can evidence — a row in sms_receipts whose
 * carrier status says delivered — not a green console. Nothing here should be
 * relaxed by adding a file to ALLOWED: that list is for copy whose SUBJECT is
 * texting or consent, not for copy that happened to promise one.
 */

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** Comments describe what the code should do, and several of them quote these
 *  exact phrases to explain why they must not ship. Only what renders counts. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * WHAT THE READER SEES, NOT WHAT THE SOURCE HOLDS. JSX writes an apostrophe as
 * &apos; and the formatter wraps prose wherever it likes: the live sentence hid
 * as "you&apos;ll get a text either\n      way", which matches nothing at all
 * as source.
 */
const asRendered = (s: string) =>
  s
    .replace(/&apos;|&rsquo;|&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .toLowerCase();

const PROMISED = [
  "we'll text",
  "we will text",
  "you'll get a text",
  "you will get a text",
  "get a text when",
  "send you a text",
  "text you when",
  "text you the moment",
  "texts you when",
  "text them when",
  "text the customer",
  // THE SENTENCE SAID IT THE OTHER WAY ROUND TWICE. Neither "you'll get a text
  // either way" nor "the text the moment they answer" is caught by a list of
  // only the head-on phrasings, and both shipped. Proven below.
  "a text either way",
  "text the moment",
];

/**
 * Paths relative to src, with the reason in words. A TODO is not a reason.
 */
const ALLOWED: Record<string, string> = {
  "components/TextOptIn.tsx":
    "Consent moment. 'We'll text you about your lot and your rent' is what the " +
    "resident is agreeing to, and it becomes true when registration clears. " +
    "Asked on 19 Aug 2026, the owner said not to rewrite consent copy for a " +
    "temporary outage.",
  "lib/sms-consent.ts":
    "The other half of the same consent moment — what the screen says back " +
    "when the resident turns texts on or off. Same decision, 19 Aug 2026.",
  "app/ops/texting/page.tsx":
    "Ops-only, and the sentence is ABOUT this rule: it tells whoever switches " +
    "sending on that every sentence claiming we will text somebody has to be " +
    "read again on the day it ships.",
};

const rel = (f: string) => f.slice(SRC.length + 1);

const offences = (f: string) => {
  const text = asRendered(stripComments(readFileSync(f, "utf8")));
  return PROMISED.filter((p) => text.includes(p));
};

const FILES = sources(SRC);

describe("the scanner is reading the whole tree", () => {
  it("found the source files at all", () => {
    // If a refactor moves src or breaks the walker, every assertion below
    // passes against nothing. 533 non-test files on 30 Sep 2026.
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.some((f) => rel(f) === "lib/arrival.ts")).toBe(true);
    expect(FILES.some((f) => rel(f) === "components/ArrivalSheet.tsx")).toBe(true);
  });

  it("catches each of the four sentences that were actually live", () => {
    // Verbatim, escaped apostrophes and line wrap and all, from 30 Sep 2026.
    const shipped = [
      "<b>Don&apos;t start until they answer</b> — you&apos;ll get a text either\n      way.",
      "Sent. Don't start until they say yes — you'll get a text.",
      "Waiting on the owner to approve what you found. You'll get a text the moment they answer.",
      "Pick a day — we'll text the customer that you're coming back, no charge.",
    ];
    for (const s of shipped) {
      const t = asRendered(s);
      expect(
        PROMISED.filter((p) => t.includes(p)).length,
        `PROMISED does not match a sentence this test exists because of: ${s}`,
      ).toBeGreaterThan(0);
    }
  });

  it("does not count a phrase that only survives in a comment", () => {
    // ArrivalSheet keeps the old sentence in the comment explaining why it
    // went. Delete stripComments and this goes red, which is what keeps the
    // stripping honest.
    const f = join(SRC, "components/ArrivalSheet.tsx");
    expect(
      asRendered(readFileSync(f, "utf8")),
      "the comment this proof relies on was edited away",
    ).toContain("you'll get a text either way");
    expect(
      asRendered(stripComments(readFileSync(f, "utf8"))),
      "stripComments is not removing comments",
    ).not.toContain("you'll get a text either way");
  });

  it("keeps the allow-list honest", () => {
    for (const k of Object.keys(ALLOWED)) {
      expect(existsSync(join(SRC, k)), `${k} is gone — repoint ALLOWED`).toBe(true);
      expect(ALLOWED[k].length, `${k} is allow-listed with no reason in words`)
        .toBeGreaterThan(40);
    }
    // Otherwise ALLOWED could be pure decoration and nobody would know.
    const offending = Object.keys(ALLOWED).filter((k) => offences(join(SRC, k)).length > 0);
    expect(
      offending.length,
      "no allow-listed file carries a promised-text phrase any more — ALLOWED may be dead",
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("no screen, message body or token page promises a text", () => {
  const guilty = FILES.map((f) => ({ f: rel(f), hits: offences(f) })).filter((x) => x.hits.length > 0);

  it("only the allow-listed files say it, and they say it on purpose", () => {
    const unexpected = guilty.filter((x) => !(x.f in ALLOWED));
    expect(
      unexpected.map((x) => `${x.f} → ${x.hits.join(", ")}`),
      "A file promises a text. None has been delivered since 19 July 2026 — the " +
        "A2P brand is approved but no campaign exists, so carriers drop " +
        "everything. Name the mechanism instead (\"we'll let you know\"), or, if " +
        "this is consent copy describing what somebody is agreeing to, add it to " +
        "ALLOWED with the reason in words.",
    ).toEqual([]);
  });
});