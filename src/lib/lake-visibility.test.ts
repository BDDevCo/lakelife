import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SERVED_LAKE_MATCH,
  SERVED_LAKE_SOURCE,
  isServedLake,
  isAwaitingPromotion,
  daysWaiting,
  waitingWords,
} from "@/lib/lake-visibility";
import { composeNightlyDigest, type DigestSections } from "@/lib/digest-render";

/**
 * A STRANGER'S TYPING WAS THE BRAND'S OWN CLAIM ABOUT WHERE IT WORKS.
 *
 * `findOrCreateLake` lets a customer ("my lake isn't listed") or a crew create
 * a `lakes` row. Every public surface then asked one question about it —
 * `is_fixture = false`, which means "not one of OUR scratch rows" and nothing
 * at all about whether LakeLife has agreed to work there. So one typo, one
 * joke, or one lake nobody serves became the front page's hero chip, a card in
 * /lakes, its own indexed landing page with a priced menu on it, a line in
 * sitemap.xml and — since 64e798c — a chip on the Open Graph card that rides
 * into every shared link.
 *
 * Two rules, and the second is the half that matters:
 *
 *   1. ONE predicate, in ONE doorway, and every public reader goes through it.
 *      A second copy of the filter IS the defect — that is how the old fence
 *      came to be right in eight places and absent in a ninth.
 *   2. A customer who is already here loses NOTHING. Their property, their
 *      ice-out and pull-deadline gates and their booking all read the lake
 *      through `properties.lake_id` and must never ask this question. A gate
 *      that also quietly broke their season would be a worse bug than the one
 *      it fixed.
 *
 * WHY A SOURCE SCANNER. The failure is an omission — a reader somebody wrote
 * without the filter — and there is no behavioural test for a query nobody
 * wrote. The unit tests below pin what the predicate MEANS; the scanner pins
 * that every doorway uses it.
 */

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * Comments do not run. Every file changed by this pass explains the defect in
 * prose and quotes the old `is_fixture = false` fence while doing it, so a
 * scanner counting comments would fail on precisely the files that fixed the
 * problem. Proven load-bearing below.
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every `.from("lakes")` in a file, with the query chain that follows it.
 * Same shape as the census in fixture-fence.test.ts: awaits and `.then()`
 * never appear mid-chain in this codebase, so a semicolon terminates.
 */
function lakeChains(rel: string): string[] {
  const src = stripComments(read(rel));
  const out: string[] = [];
  for (const m of src.matchAll(/\.from\("lakes"\)/g)) {
    const rest = src.slice(m.index ?? 0);
    const end = rest.indexOf(";");
    out.push(end === -1 ? rest.slice(0, 400) : rest.slice(0, end));
  }
  return out;
}

/** The rule itself, as one function, so the tests below and the proof that
 *  they are not vacuous are asking the identical question. */
const goesThroughThePredicate = (chain: string) => chain.includes("SERVED_LAKE_MATCH");
const fencedOnFixtureAlone = (chain: string) =>
  chain.includes("is_fixture") && !goesThroughThePredicate(chain);

/**
 * WHAT LAKELIFE ADVERTISES. Every read of `lakes` in these files decides what
 * a stranger, a crawler or a link preview is told about where we work.
 */
const PUBLIC_SURFACES: Record<string, string> = {
  "app/page.tsx": "the front page's hero chip",
  "app/lakes/page.tsx": "/lakes, the public directory",
  "app/lakes/[slug]/page.tsx": "the indexed per-lake landing page and its priced menu",
  "app/sitemap.ts": "sitemap.xml — a crawled URL outlives whatever created it",
  "app/opengraph-image.tsx": "the link-preview card on every shared link",
  "app/profile/setup/page.tsx": "the chips headed 'which lake are you on or near'",
  "app/ops/crews-invite.ts": "the lakes named in a real invitation email to a real crew",
};

/**
 * PUBLIC, AND DELIBERATELY NOT GATED — named here so the omission is a
 * decision somebody can argue with rather than a file nobody listed.
 *
 * fixture-fence.test.ts already files parks/public-data.ts under "reaches an
 * anonymous visitor or a crawler", and it is right: it prints a lake's NAME
 * on a public park page. What it does NOT do is enumerate the table. It takes
 * a `parks.lake_id` that only ops can write and resolves the one name that id
 * points at, so nothing a stranger typed can arrive here on its own — it
 * takes an ops person picking that lake in the park editor first. Gating it
 * would blank a label on a live park rather than hide anything, and a park's
 * address is a fact about where the park is, not a claim about where LakeLife
 * works.
 *
 * THE TEST BELOW PINS THE REASON, NOT THE EXEMPTION. The moment one of these
 * reads starts LISTING lakes instead of resolving ids a row already holds,
 * the argument above stops being true and this fails, which is the point at
 * which somebody has to decide again. (The ops park picker that writes
 * `parks.lake_id` still offers unpromoted lakes — whether it should is a
 * product question, not a defect, and it is in the report.)
 */
const PUBLIC_BUT_RESOLVES_BY_ID: Record<string, string> = {
  "app/parks/public-data.ts": "a public park page's lake label, from parks.lake_id — ops-written",
};

describe("the one public surface that is not gated resolves ids, never lists lakes", () => {
  it("still reads lakes there, so the scanner cannot pass by seeing nothing", () => {
    for (const rel of Object.keys(PUBLIC_BUT_RESOLVES_BY_ID)) {
      expect(lakeChains(rel).length, `no .from("lakes") in ${rel} — re-check the exemption`)
        .toBeGreaterThan(0);
    }
  });

  it("every one of them is keyed on an id a row already holds", () => {
    const listing: string[] = [];
    for (const [rel, why] of Object.entries(PUBLIC_BUT_RESOLVES_BY_ID)) {
      for (const chain of lakeChains(rel)) {
        // `.eq("id", …)` or `.in("id", …)` — a lookup, not a directory.
        if (!/\.(eq|in)\("id"/.test(chain)) listing.push(`${rel} — ${why}`);
      }
    }
    expect(
      listing,
      "this is a PUBLIC surface that was exempt only because it looks up one " +
      "lake by an ops-written id. It is now listing them, so it needs the " +
      "predicate or a fresh decision:\n" + listing.join("\n"),
    ).toEqual([]);
  });

  it("and it keeps the fixture fence it already had", () => {
    for (const rel of Object.keys(PUBLIC_BUT_RESOLVES_BY_ID)) {
      for (const chain of lakeChains(rel)) expect(chain).toContain("is_fixture");
    }
  });
});

/**
 * THIS PERSON'S OWN DATA. Each of these resolves the lake a row already points
 * at, for somebody signed in. Putting the predicate in any of them would take
 * a real homeowner's season dates, booking or property away from them because
 * of a decision LakeLife has not got round to making.
 */
const OWN_DATA_READERS: Record<string, string> = {
  "app/profile/actions.ts": "resolves the lake NAME a customer already saved, to write properties.lake_id",
  "app/book/page.tsx": "the booking grid's season window, off the property's own lake",
  "app/book/actions.ts": "the season gate at booking, off the property's own lake",
  "app/book/storage/actions.ts": "the storage season gate, off the property's own lake",
  "app/profile/data.ts": "the lake name on a customer's own profile",
  "lib/lake-birth.ts": "dedupe and birth — must MATCH an unpromoted lake or a second row appears",
};

/**
 * THE BODY OF ONE FUNCTION, not a fixed number of characters after its name.
 *
 * This window used to be a flat 2,600-character slice taken from the name
 * onward, and `promoteLakeToServed` is 1,267 characters of stripped source —
 * so 912 characters of the function BELOW it sat inside the window, carrying
 * its own `assertOps` refusal. Delete the guard from the promotion and every
 * assertion in the ops block still passed, on a neighbour's text: a test that
 * passes with the branch deleted, which is the one thing a test may never do.
 * The window stops at the next top-level export now, and the last assertion
 * in that block proves it stopped.
 */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}`);
  expect(at, `${name} is gone from the file`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + 1);
  return next === -1 ? src.slice(at) : src.slice(at, next);
}

describe("the predicate says what a served lake is", () => {
  const ops = { is_fixture: false, source: "ops" };
  const bornByCustomer = { is_fixture: false, source: "customer" };
  const bornByCrew = { is_fixture: false, source: "crew" };
  const fixture = { is_fixture: true, source: "ops" };

  it("a lake somebody at LakeLife put there is served", () => {
    expect(isServedLake(ops)).toBe(true);
    expect(isAwaitingPromotion(ops)).toBe(false);
  });

  it("a lake a customer named is NOT served, and IS waiting", () => {
    expect(isServedLake(bornByCustomer)).toBe(false);
    expect(isAwaitingPromotion(bornByCustomer)).toBe(true);
  });

  it("a lake a crew named is NOT served, and IS waiting", () => {
    expect(isServedLake(bornByCrew)).toBe(false);
    expect(isAwaitingPromotion(bornByCrew)).toBe(true);
  });

  it("a fixture is neither — it must not be advertised OR queued for promotion", () => {
    // Both arms matter. Served would put a scratch lake on the front page;
    // waiting would invite ops to promote one, which is the same thing one
    // click later.
    expect(isServedLake(fixture)).toBe(false);
    expect(isAwaitingPromotion(fixture)).toBe(false);
    expect(isAwaitingPromotion({ is_fixture: true, source: "customer" })).toBe(false);
  });

  it("a caller who forgot to select the columns gets NOT SERVED, never a guess", () => {
    // `is_fixture !== true` would read an absent column as a fact and publish
    // the lake. Absence has to fail closed: a real lake missing from a chip is
    // visible to ops; a stranger's typo on the front page is not.
    expect(isServedLake({ source: "ops" })).toBe(false);
    expect(isServedLake({ is_fixture: false })).toBe(false);
    expect(isServedLake(null)).toBe(false);
    expect(isServedLake(undefined)).toBe(false);
    expect(isAwaitingPromotion(null)).toBe(false);
  });

  it("a source nobody has thought of yet lands in the ops queue, not on the site", () => {
    // The CHECK allows three words today. If a fourth is ever added, the safe
    // failure is "somebody look at this", never "publish it".
    const future = { is_fixture: false, source: "partner" };
    expect(isServedLake(future)).toBe(false);
    expect(isAwaitingPromotion(future)).toBe(true);
  });

  it("the filter object carries BOTH halves, because half of it is the defect", () => {
    expect(SERVED_LAKE_MATCH).toEqual({ is_fixture: false, source: SERVED_LAKE_SOURCE });
    expect(SERVED_LAKE_SOURCE).toBe("ops");
  });
});

describe("how long a lake has been waiting", () => {
  const now = new Date("2026-09-22T12:00:00Z");

  it("counts whole days", () => {
    expect(daysWaiting("2026-09-18T12:00:00Z", now)).toBe(4);
    expect(daysWaiting("2026-09-22T06:00:00Z", now)).toBe(0);
  });

  it("is NULL, never 0, when there is no timestamp to read", () => {
    // Zero is a real answer — a lake named this morning. Handing it back for
    // "we couldn't tell" would put a brand-new lake and an unreadable one in
    // the same sentence.
    expect(daysWaiting(null, now)).toBeNull();
    expect(daysWaiting(undefined, now)).toBeNull();
    expect(daysWaiting("not a date", now)).toBeNull();
  });

  it("never goes negative on a clock that disagrees with the database", () => {
    expect(daysWaiting("2026-09-25T12:00:00Z", now)).toBe(0);
  });

  it("says which it got, in words, and the two cases do not read alike", () => {
    expect(waitingWords(4)).toBe("waiting 4 days");
    expect(waitingWords(1)).toBe("waiting 1 day");
    expect(waitingWords(0)).toBe("named today");
    expect(waitingWords(null)).toContain("couldn't work out");
    expect(waitingWords(null)).not.toContain("0");
  });
});

describe("NO PUBLIC SURFACE FILTERS `lakes` ON is_fixture ALONE", () => {
  it("the scanner still finds the queries, so it cannot pass by seeing nothing", () => {
    for (const rel of Object.keys(PUBLIC_SURFACES)) {
      expect(lakeChains(rel).length, `no .from("lakes") found in ${rel} — the scanner has rotted`)
        .toBeGreaterThan(0);
    }
  });

  it("every public read goes through the one predicate", () => {
    const offences: string[] = [];
    for (const [rel, why] of Object.entries(PUBLIC_SURFACES)) {
      for (const chain of lakeChains(rel)) {
        if (!goesThroughThePredicate(chain)) offences.push(`${rel} — ${why}`);
      }
    }
    expect(
      offences,
      "these decide what LakeLife advertises and do not ask the served-lake " +
      "predicate. Use .match(SERVED_LAKE_MATCH) from @/lib/lake-visibility:\n" +
      offences.join("\n"),
    ).toEqual([]);
  });

  it("and none of them is fenced on is_fixture alone — the fence that let this in", () => {
    const stale: string[] = [];
    for (const rel of Object.keys(PUBLIC_SURFACES)) {
      for (const chain of lakeChains(rel)) if (fencedOnFixtureAlone(chain)) stale.push(rel);
    }
    expect(stale, `still asking only "is this one of our scratch rows":\n${stale.join("\n")}`)
      .toEqual([]);
  });

  it("the rule itself rejects the old fence and accepts the new one", () => {
    // Otherwise the two assertions above could both be true of a checker that
    // says yes to everything.
    expect(fencedOnFixtureAlone('.select("name").eq("is_fixture", false).order("name")')).toBe(true);
    expect(goesThroughThePredicate('.select("name").eq("is_fixture", false)')).toBe(false);
    expect(goesThroughThePredicate('.select("name").match(SERVED_LAKE_MATCH)')).toBe(true);
    expect(fencedOnFixtureAlone('.select("name").match(SERVED_LAKE_MATCH)')).toBe(false);
  });

  it("stripping comments is load-bearing, not decoration", () => {
    // Every file above explains the defect by quoting the fence it replaced.
    // Delete stripComments and the raw text keeps matching `is_fixture`, so
    // the rule would be judging prose instead of queries.
    const raw = read("app/page.tsx");
    expect(raw, "the comment this proof relies on was edited away").toContain("is_fixture");
    expect(stripComments(raw)).not.toContain("is_fixture");
  });
});

/**
 * THE HALF MOST LIKELY TO BREAK. A gate on what LakeLife advertises must not
 * touch what somebody already here can do.
 */
describe("a customer on an unpromoted lake loses nothing", () => {
  it("the readers that resolve THEIR OWN lake still find it", () => {
    const gated: string[] = [];
    for (const [rel, why] of Object.entries(OWN_DATA_READERS)) {
      const src = stripComments(read(rel));
      if (src.includes("SERVED_LAKE_MATCH")) gated.push(`${rel} — ${why}`);
    }
    expect(
      gated,
      "these read a lake a signed-in person's own row already points at. " +
      "Gating one takes their season dates, their booking or their property " +
      "away over a decision LakeLife has not made:\n" + gated.join("\n"),
    ).toEqual([]);
  });

  it("their property still resolves its lake by name, fixtures excluded and nothing else", () => {
    // profile/actions.ts writes properties.lake_id. It keeps the fixture fence
    // (0124 — a real house must never bind to a scratch row) and must NOT gain
    // the serving one, or saving an edit on an unpromoted lake would write
    // lake_id = null and silently unhook them from rule 7 entirely.
    const chains = lakeChains("app/profile/actions.ts");
    const byName = chains.find((c) => c.includes('.eq("name"'));
    expect(byName, "the lake-by-name lookup is gone from profile/actions.ts").toBeTruthy();
    expect(byName).toContain("is_fixture");
    expect(byName).not.toContain("SERVED_LAKE_MATCH");
  });

  it("the booking path reads the lake through the property, never through the gate", () => {
    for (const rel of ["app/book/page.tsx", "app/book/actions.ts", "app/book/storage/actions.ts"]) {
      const src = stripComments(read(rel));
      // The embed is how a season window is read for the property in hand.
      expect(src, `${rel} no longer reads the lake off the property`).toMatch(/lakes\(/);
      expect(src, `${rel} started gating a signed-in owner's own season window`)
        .not.toContain("SERVED_LAKE_MATCH");
    }
  });

  it("naming a lake we already know still dedupes to that row rather than a second one", () => {
    // lake-birth's dedupe is the only thing standing between a customer and a
    // duplicate. Gate it and the second person to name an unpromoted lake gets
    // a brand-new row — two markets, crews on one and customers on the other.
    const chains = lakeChains("lib/lake-birth.ts");
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) expect(chain).not.toContain("SERVED_LAKE_MATCH");
  });

  it("the seasonal pull reminder still reaches owners on an unpromoted lake", () => {
    // Rule 7 is about ice, not about marketing. An owner whose pier is in the
    // water does not stop needing to be told the deadline because ops has not
    // decided whether to advertise their lake.
    const chains = lakeChains("lib/automation.ts");
    const pull = chains.find((c) => c.includes("pull_deadline"));
    expect(pull, "sendSeasonalPullReminders' lake read is gone").toBeTruthy();
    expect(pull).not.toContain("SERVED_LAKE_MATCH");
  });

  it("the set-up wizard offers the served lakes AND the one they are already on", () => {
    // The chips advertise where we work, so they are gated — but a homeowner
    // who named their lake last night must not open this page to find their
    // own water missing and no chip selected.
    const src = stripComments(read("app/profile/setup/page.tsx"));
    expect(src).toContain("SERVED_LAKE_MATCH");
    expect(src).toMatch(/ownLake/);
    expect(src).toMatch(/servedLakeNames\.includes\(ownLake\)/);
  });
});

/**
 * A GATE WITH NO NOTICE IS A SILENT HOLE. The row is created, the customer is
 * set up, and before this nobody at LakeLife ever learned a market asked for
 * us.
 */
describe("the nightly digest names the lakes waiting on a decision", () => {
  const quiet: DigestSections = {
    learning: { changes: [] },
    autoPricing: { changes: [] },
    disputeSweep: { fired: 0, escalated: 0 },
    escalatedDisputes: [],
    lakesBorn: [],
    routes: {},
    aiAutoReplies: 0,
    aiReplyTexts: [],
    gapSla: { alerted: 0 },
  };

  it("says nothing when nothing is waiting — a quiet night stays quiet", () => {
    expect(composeNightlyDigest({ ...quiet, lakesWaiting: [] }))
      .toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
    expect(composeNightlyDigest(quiet))
      .toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });

  it("names the lake, who asked for it, how many homes and how long", () => {
    const html = composeNightlyDigest({
      ...quiet,
      lakesWaiting: [{ name: "Adams Lake", source: "customer", properties: 2, days: 4 }],
    });
    expect(html).toContain("1 lake waiting on you");
    expect(html).toContain("Adams Lake");
    expect(html).toContain("from a customer");
    expect(html).toContain("2 homes");
    expect(html).toContain("waiting 4 days");
    // It must also say the customer is fine, or the reader assumes a breakage.
    expect(html).toContain("book and get their season dates meanwhile");
  });

  it("a home count we could not read is never printed as zero homes", () => {
    // "0 homes" is the single fact most likely to make somebody skip the lake,
    // and it would be the sentence we print precisely when we failed to look.
    const html = composeNightlyDigest({
      ...quiet,
      lakesWaiting: [{ name: "Adams Lake", source: "crew", properties: null, days: 1 }],
    });
    // A nested html`` template, so our own apostrophe stays an apostrophe —
    // the same construct every other literal in the composer uses.
    expect(html).toContain("we couldn't count the homes on it");
    expect(html).not.toContain("0 home");
    expect(html).toContain("waiting 1 day");
  });

  it("pluralises the lakes and the homes independently", () => {
    const html = composeNightlyDigest({
      ...quiet,
      lakesWaiting: [
        { name: "Adams Lake", source: "customer", properties: 1, days: 0 },
        { name: "Witmer Lake", source: "crew", properties: 3, days: 30 },
      ],
    });
    expect(html).toContain("2 lakes waiting on you");
    expect(html).toContain("1 home,");
    expect(html).toContain("3 homes");
    expect(html).toContain("named today");
  });

  it("is a STANDING queue, not the same thing as last night's births", () => {
    // "New lakes" fires once, on the night it happens, and then never again —
    // which is how a lake could wait a month with nobody told twice.
    const html = composeNightlyDigest({
      ...quiet,
      lakesBorn: [{ name: "Adams Lake", source: "customer" }],
      lakesWaiting: [{ name: "Witmer Lake", source: "customer", properties: 0, days: 40 }],
    });
    expect(html).toContain("New lakes");
    expect(html).toContain("waiting 40 days");
    // A lake with genuinely no homes on it still gets named — that is a real
    // answer, and it is the reason the failed-count case above says something
    // different.
    expect(html).toContain("0 homes");
  });
});

/**
 * A GATE OPS CANNOT OPEN IS WORSE THAN NO GATE — the only alternative would be
 * an UPDATE typed against production.
 */
describe("ops can say yes, and the screen offers it", () => {
  const actions = stripComments(read("app/ops/actions.ts"));
  const ui = stripComments(read("components/ops/LakeConditions.tsx"));

  it("the writer exists, is ops-only, and writes the column the predicate reads", () => {
    expect(actions).toMatch(/export async function promoteLakeToServed/);
    const body = functionBody(actions, "promoteLakeToServed");
    expect(body).toMatch(/const ops = await assertOps\(\);/);
    expect(body).toMatch(/if \(!ops\) return \{ ok: false, error: "Ops only\." \};/);
    expect(body).toMatch(/\.update\(\{ source: SERVED_LAKE_SOURCE \}\)/);
  });

  it("it refuses a fixture, so the two halves of the predicate cannot be split", () => {
    const body = functionBody(actions, "promoteLakeToServed");
    expect(body).toMatch(/is_fixture === true/);
    expect(body).toMatch(/test lake/i);
  });

  it("a failed read is not a missing lake", () => {
    const body = functionBody(actions, "promoteLakeToServed");
    expect(body).toMatch(/readFailedMessage\("that lake"/);
  });

  it("the cached public pages are revalidated, or the button looks broken", () => {
    const body = functionBody(actions, "promoteLakeToServed");
    for (const path of ['revalidatePath("/")', 'revalidatePath("/lakes")', 'revalidatePath("/sitemap.xml")']) {
      expect(body).toContain(path);
    }
  });

  it("and the window stops at the function, so no neighbour can answer for it", () => {
    // The proof that the assertions above are about promoteLakeToServed and
    // not about whatever happens to be written underneath it. The bug this
    // replaced was exactly that: the next function's own ops guard sat inside
    // the window and answered for a guard that had been deleted.
    const body = functionBody(actions, "promoteLakeToServed");
    expect(body).not.toContain("updateLakeConditions");
    expect(body.trimEnd().endsWith("}")).toBe(true);
  });

  it("and a screen actually calls it — a writer with no door is no writer", () => {
    expect(ui).toContain("promoteLakeToServed");
    expect(ui).toMatch(/onClick=\{promote\}/);
  });

  it("ops is told which lakes are waiting before they scroll to a card", () => {
    expect(ui).toMatch(/awaiting_promotion/);
    expect(ui).toMatch(/waiting on you/);
    expect(ui).toMatch(/waitingWords/);
  });
});
