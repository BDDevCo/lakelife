import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A PUBLIC PAGE MAY ONLY CLAIM WHAT THIS CODEBASE CAN BACK.
 *
 * Two rules, one defect class: a sentence a stranger reads that nothing in the
 * product can cash. A promised text, a photograph promised in the message, and
 * a stopwatch figure nobody ever ran are all the same mistake — copy written
 * about the product somebody hoped to have.
 *
 * Eighty-one texts were sent between 19 July and 16 August 2026 and not one of
 * them was delivered — sixty-six rejected 30034, an unregistered A2P sender.
 * `sendSms` returned `queued: true` for every one, because Twilio accepting a
 * message is not a carrier delivering it, and nothing in this app has ever
 * looked at what the carrier decided afterwards. For a month the product
 * believed it was talking to people.
 *
 * Meanwhile the per-lake landing page — public, indexed, cached hourly — told
 * strangers "you get a text when it's done, with photos". Two promises, both
 * false, sitting where nobody signed in had to read them to be misled. The
 * photographs were the quieter half and the older one: no completion message
 * has ever carried an image. It carries a count and a link to the job page.
 *
 * The campaign is approved now. THAT IS NOT WHY THIS TEST EXISTS, AND IT IS
 * NOT A REASON TO WEAKEN IT. Approval is not delivery: the sender has still to
 * be switched to the registered Messaging Service, and no message has yet
 * arrived on a real handset that this product can prove. Until a delivered
 * text can be pointed at, a page that promises one is guessing in public.
 *
 * WHY A SCANNER AND NOT A REVIEW. Copy like this is written in a hurry, by
 * whoever is nearest, in a component nobody thinks of as code. Four sentences
 * of it had to be found by hand on one page this week. A grep that runs on
 * every commit is the only reader guaranteed to look.
 *
 * ============ WHEN TEXTS ARE REALLY WORKING ============
 *
 * Delete the phrase from BANNED and say so in the commit message — the bar is
 * a delivered message the product can evidence, not a green console. Nothing
 * here should be relaxed by adding a page to ALLOWED: that list is for pages
 * whose subject IS texting, not for pages that happen to have promised one.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * The pages a stranger can read without signing in. Held as a list rather than
 * walked, because "public" is not a property of a file path: /verify and
 * /parks/my render nothing to an anonymous visitor but a sign-in card, and a
 * walker would have to guess. Each one below was opened and checked. A page
 * added here that does not exist fails the first block, so a rename cannot
 * quietly shrink the set to nothing.
 */
const PUBLIC_PAGES = [
  "page.tsx", // the front door
  "lakes/page.tsx",
  "lakes/[slug]/page.tsx",
  // The 404 body for that route. A stranger reads it — either because the slug
  // is nonsense, or because the lake exists but nobody at LakeLife has said we
  // serve it yet — so its sentences are under the same rules as the page it
  // stands in for.
  "lakes/[slug]/not-found.tsx",
  "for-parks/page.tsx",
  "sms/page.tsx",
  "privacy/page.tsx",
  "terms/page.tsx",
  "referral-terms/page.tsx",
  "parks/[slug]/page.tsx",
  "parks/claim/page.tsx",
];

/**
 * The two pages where the words are the subject rather than a promise.
 *
 * /sms is the messaging-terms page the carriers themselves read during A2P
 * vetting — it has to describe the programme, quote real message bodies, and
 * say how to stop them. /parks/claim carries the warning that we will never
 * ring or text somebody asking for their claim code, which is the sentence
 * that protects a resident from the person who does.
 */
const ALLOWED = new Set(["sms/page.tsx", "parks/claim/page.tsx"]);

/**
 * Lower case, because copy is sentence-cased and headline-cased in the same
 * file.
 */
const BANNED = [
  "text you",
  "we'll text",
  // THE SENTENCE THAT SHIPPED SAID IT THE OTHER WAY ROUND. "You get a text
  // when it's done, with photos" contains neither "text you" nor "we'll
  // text", so a list of only the obvious phrasings would have passed the
  // exact page this was written for. Proven below against the live string.
  "get a text",
  "with photos attached",
  "done, with photos",
  "our crews", // rule: independent local crews, never ours — we administer
];

/** Comments do not render. Every one of these phrases appears in prose in this
 *  repo explaining why it must not be published, and a scanner that counted
 *  those would fail on the files that fixed the problem. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * WHAT THE READER SEES, NOT WHAT THE SOURCE HOLDS.
 *
 * JSX writes an apostrophe as `&apos;` and wraps prose across lines wherever
 * the formatter feels like it, so "We&apos;ll text\n you" is one sentence on
 * screen and matches nothing at all as source. Both were true of the live
 * sentence this test was written for: a scanner without this normalisation
 * would have passed the page it was meant to catch.
 */
const asRendered = (s: string) =>
  s
    .replace(/&apos;|&rsquo;|&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .toLowerCase();

const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");
const rendered = (rel: string) => asRendered(stripComments(read(rel)));

/** Every banned phrase this page would show a reader. */
const offences = (rel: string) => {
  const text = rendered(rel);
  return BANNED.filter((phrase) => text.includes(phrase));
};

describe("the scanner is reading real pages", () => {
  it("found every public page it claims to check", () => {
    for (const rel of PUBLIC_PAGES) {
      expect(existsSync(join(HERE, rel)), `${rel} is gone — repoint PUBLIC_PAGES`).toBe(true);
      expect(read(rel).length, `${rel} is empty`).toBeGreaterThan(500);
    }
    expect(PUBLIC_PAGES.length).toBeGreaterThan(8);
  });

  it("matches a phrase that is really on a page", () => {
    // THE LIVE PROOF THAT THE MATCHER MATCHES. parks/claim genuinely carries
    // "never phone or text you asking for this code" — so if this comes back
    // empty, the normaliser or the phrase list has rotted and every assertion
    // below is passing against nothing.
    expect(offences("parks/claim/page.tsx")).toContain("text you");
  });

  it("catches the sentence that was actually live on the lake page", () => {
    // Verbatim from src/app/lakes/[slug]/page.tsx before this week, escaped
    // apostrophe and all. If no phrase in BANNED matches it, the guard is
    // decoration: it would have let the defect it was written for straight
    // through.
    const shipped = asRendered(
      "Book a day; a vetted, insured local crew gets routed automatically; " +
      "you get a text when it&apos;s done, with photos.",
    );
    expect(BANNED.filter((phrase) => shipped.includes(phrase)).length,
      "BANNED does not match the sentence this test exists because of")
      .toBeGreaterThan(0);
  });

  it("matches across a line break and through an escaped apostrophe", () => {
    // The two ways the real sentence hid. Neither of these strings contains
    // the literal "we'll text", and both must be caught.
    expect(asRendered("We&apos;ll text you when it&apos;s done")).toContain("we'll text");
    expect(asRendered("something\n   we'll  text\n you about")).toContain("we'll text");
  });

  it("does not count a phrase that is only discussed in a comment", () => {
    // The lake page's own comment quotes the reminder body it is warning the
    // next reader about — "We'll text you when it's done, with photos" — and
    // that must not read as the page saying it. Delete stripComments and this
    // goes red, which is what keeps the stripping honest.
    const rel = "lakes/[slug]/page.tsx";
    expect(asRendered(read(rel)), "the comment this proof relies on was edited away")
      .toContain("we'll text you");
    expect(rendered(rel), "stripComments is not removing comments")
      .not.toContain("we'll text you");
  });

  it("would fail if the allow-list were dropped", () => {
    // Otherwise ALLOWED could be pure decoration and nobody would know.
    const withoutAllowList = PUBLIC_PAGES.filter((rel) => offences(rel).length > 0);
    expect(withoutAllowList.length,
      "no allow-listed page carries a banned phrase any more — ALLOWED may be dead")
      .toBeGreaterThan(0);
    for (const rel of withoutAllowList) expect(ALLOWED.has(rel)).toBe(true);
  });
});

/**
 * A TIMED CLAIM NOBODY TIMED.
 *
 * The lake page's gold button said "Get set up — it takes 2 minutes". No clock
 * in this repo has ever run over the set-up wizard, which asks for an address,
 * a pier, boats, a lawn and a mobile number it makes you verify by code — and
 * how long that takes depends entirely on what is on the property. It is a
 * softer lie than a promised text and it is the same lie: a number on a public
 * page with no source anywhere behind it.
 *
 * If somebody genuinely measures it, this can go — but then the number belongs
 * next to the measurement, not in a button.
 */
const TIMING_CLAIMS = [
  "takes 2 minutes",
  "takes two minutes",
  "in 2 minutes",
  "in two minutes",
  "takes a minute",
  "in a minute",
  "in under a minute",
  "in seconds",
];

describe("no public page quotes a duration nobody measured", () => {
  it("catches the claim that was on the gold button", () => {
    const shipped = asRendered("Get set up — it takes 2 minutes 🌊");
    expect(TIMING_CLAIMS.some((c) => shipped.includes(c)),
      "TIMING_CLAIMS does not match the button this rule exists because of").toBe(true);
  });

  it("still counts it when only the comment explaining it survives", () => {
    // Second proof that stripping is load-bearing, on the other rule: the lake
    // page's comment names "2 minutes" to tell the next reader why it went.
    const rel = "lakes/[slug]/page.tsx";
    expect(asRendered(read(rel))).toContain("2 minutes");
    expect(rendered(rel), "stripComments is not removing comments").not.toContain("2 minutes");
  });

  for (const rel of PUBLIC_PAGES) {
    it(`${rel} quotes no unmeasured duration`, () => {
      const text = rendered(rel);
      expect(TIMING_CLAIMS.filter((c) => text.includes(c)),
        `${rel} tells a stranger how long something takes, and nothing has timed it`)
        .toEqual([]);
    });
  }
});

describe("no public page promises a text or an attached photograph", () => {
  for (const rel of PUBLIC_PAGES) {
    if (ALLOWED.has(rel)) continue;
    it(`${rel} says nothing this product cannot do`, () => {
      expect(offences(rel),
        `${rel} promises something the product cannot do today: a text (none has ` +
        `been delivered since July), a photograph in the message (completion ` +
        `messages carry a count and a link), or crews of our own (they are ` +
        `independent).`)
        .toEqual([]);
    });
  }
});
