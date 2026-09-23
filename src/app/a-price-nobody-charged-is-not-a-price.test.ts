import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A NUMBER NOBODY CHARGED, PRINTED WHERE A PRICE GOES.
 *
 * There are four figures in this product that somebody actually paid or
 * billed: $100 a cut to Advantage Lawn Care, $1,405.36 a month to LaGrange
 * County for sewer, $144.02 a month to NIPSCO for the common electric, and
 * $1,680 a season for The Haven's pier. Three are utility bills. Every other
 * price on every screen traces to `lakelife.html`, which is a prototype and is
 * allowed to be one — it prices a pier at $700 and reprices ten sections to
 * twelve at $796, which is $220 base + $48 a section exactly, and 0047 seeded
 * both terms into `services` WITH NO SOURCE NOTE while two neighbours in the
 * same INSERT were annotated "(PLACEHOLDER rate)". A placeholder is only a
 * placeholder where the reader can see it, so the invented number came to read
 * as the grounded one, and docs/membership_model.py then modelled revenue on
 * "the REAL seeded values from production".
 *
 * Scale, because it is the part that makes this money rather than tone: the
 * only pier price anybody has ever charged is $1,680 for a season over 28
 * sections — $60 a section, for the season. The menu is $220 + $48/section
 * EACH WAY, which is $3,128 for the same dock over the same season. 1.86×.
 *
 * WHAT THIS FILE GUARDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It does not touch a price and it does not deactivate a service. Changing
 * what is for sale is the owner's decision. An unpriced service is the SAFE
 * state; a service that VANISHES rather than saying honestly that a crew will
 * quote it is its own defect, and the audit found exactly that on /book, where
 * `price > 0` deleted every crew-priced service from the menu with no sentence
 * anywhere. So the rule here is narrow and checkable: no screen may CLAIM a
 * number is firm when nothing stands behind it, and the lake pages — public,
 * indexed, cached hourly, readable with no login — may not print a figure at
 * all while no crew has agreed to one.
 *
 * WHY A SCANNER. These are sentences and JSX branches, not arithmetic. The
 * four sentences below were written by four different hands in four files, and
 * two of them contradicted a sentence eight lines further up the SAME page. A
 * grep that runs on every commit is the only reader guaranteed to look.
 *
 * TWO BLOCKS, AND THE SECOND ONE IS THE POINT. The first half of this file
 * covers the four screens that were assigned to a builder. The second half,
 * below, covers the seven that were not — /welcome, /profile, the setup recap
 * EMAIL, the front door, /lakes, the customer's own job page and the wizard's
 * recap — every one of which was still saying what those four had just
 * stopped saying. That is what makes this a defect class rather than four
 * sentences, and it is why the scan runs over a list instead of a file.
 *
 * ITS SIBLING is public-pages-claim-only-what-is-built.test.ts, which polices
 * promised texts and photographs on public pages. Same defect class, different
 * claim, and deliberately a separate file: three of the four screens here are
 * behind a sign-in and have no business on that file's PUBLIC_PAGES list.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Comments do not render — and every banned sentence below is quoted in prose
 *  in the very files that removed it, explaining why it went. A scanner that
 *  counted those would fail hardest on the commit that fixed the problem. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** What the reader sees: JSX writes an apostrophe as `&apos;` and wraps prose
 *  across lines wherever the formatter felt like it. */
const asRendered = (s: string) =>
  s
    .replace(/&apos;|&rsquo;|&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    // Found while proving this file bites: putting the old heading back as
    // "Services &amp; pricing" — which is how a formatter or a careful author
    // writes an ampersand in JSX — slipped past the banned phrase entirely,
    // and only the structural heading assertion caught it. A normaliser that
    // misses the escaped form of a character IS the hole.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** Structural scans read source, not prose — but whitespace is the formatter's
 *  to move, so it is flattened before anything is matched. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const FILES = {
  lake: "./lakes/[slug]/page.tsx",
  book: "./book/page.tsx",
  grid: "../components/BookingGrid.tsx",
  setup: "./profile/setup/page.tsx",
} as const;

const source = (k: keyof typeof FILES) => strip(read(FILES[k]));
const rendered = (k: keyof typeof FILES) => asRendered(source(k));

/**
 * THE SENTENCES THAT SHIPPED. Each was live in one of the four files above on
 * 22 September 2026, and each is a claim of firmness with nothing behind it.
 *
 * "No quotes, no callbacks, no surprises" is the worst of them and not because
 * it is the boldest: it explicitly forecloses the quoting model the owner has
 * chosen, so honouring it would mean never letting a crew name a price.
 */
const FIRM_PRICE_CLAIMS = [
  "no quotes, no callbacks",
  "every price is exact",
  "price is exact to your property",
  "exact from day one",
  "price it exactly",
  "priced exactly to",
  "exact all-in price",
  // The heading over the twelve figures. Banned as well as the figures,
  // because a heading promising pricing is a promise even over an empty list.
  "services & pricing",
];

describe("the scanner is reading the four screens it claims to read", () => {
  it("finds all four, and they are real files", () => {
    for (const [name, rel] of Object.entries(FILES)) {
      expect(read(rel).length, `${name} (${rel}) is gone or empty — repoint FILES`).toBeGreaterThan(1500);
    }
  });

  it("stripping comments is load-bearing, and provably so", () => {
    // Three of these files now quote the banned sentence in a comment saying
    // why it went. If stripping stopped working, the assertions below would go
    // red on the commit that fixed the defect — so the stripping is proved
    // here rather than assumed.
    const withComments = asRendered(read(FILES.lake));
    expect(withComments, "the lake page's note about the old promise was edited away")
      .toContain("no quotes, no callbacks");
    expect(rendered("lake"), "strip() is not removing comments")
      .not.toContain("no quotes, no callbacks");
  });

  it("the phrase list matches the sentences it exists because of", () => {
    // Verbatim, escaped apostrophes and all. If a phrase here matched none of
    // these, it would be decoration.
    const shipped = [
      "Your exact all-in price shows before you book — it depends on your pier, boat and property. No quotes, no callbacks, no surprises.",
      "{profile.address ?? \"Your place\"} — every price is exact to your property.",
      "Pick the services that fit your place — we&apos;ll only ask about what you choose, and every price is exact from day one.",
      "Same quick setup for your other home — pick its services and we&apos;ll price it exactly.",
      "Once your place is set up, every service here is priced exactly to it.",
      "<h3>Services &amp; pricing on {lake.name}</h3>".replace("&amp;", "&"),
    ].map(asRendered);
    for (const sentence of shipped) {
      expect(
        FIRM_PRICE_CLAIMS.some((p) => sentence.includes(p)),
        `no banned phrase matches a sentence this file exists because of: ${sentence}`,
      ).toBe(true);
    }
  });
});

describe("no screen calls a price firm when nothing stands behind it", () => {
  for (const key of Object.keys(FILES) as Array<keyof typeof FILES>) {
    it(`${FILES[key]} makes no firmness claim`, () => {
      const text = rendered(key);
      expect(
        FIRM_PRICE_CLAIMS.filter((p) => text.includes(p)),
        `${FILES[key]} tells somebody a price is exact or quote-free. No crew has been ` +
        `onboarded; every menu figure traces to lakelife.html. Say what the engine really ` +
        `does — price from their own pier, boats and lawn — or say a crew names it.`,
      ).toEqual([]);
    });
  }
});

describe("the public lake page quotes no price at all", () => {
  it("does not reach the helper that builds a 'from $X' line", () => {
    // fromPrice is the ONLY way a menu floor gets onto this page, and it is
    // still exported and still pinned against priceService by
    // lake-pages.test.ts — it is kept for the day a crew's real rate sits
    // behind a services row. Calling it from here is the defect.
    expect(source("lake"), "the lake page is building a price floor again")
      .not.toContain("fromPrice");
  });

  it("does not even load the columns a price is built from", () => {
    // The stronger half of the same fence: base, unit_rate and band_pricing
    // are the three inputs. Without them in the SELECT a figure cannot be
    // computed here at all, so reinstating one means meeting the note above
    // the query first.
    const q = servicesChain("lake");
    for (const col of ["base", "unit_rate", "band_pricing"]) {
      expect(q, `the lake page's services query loads ${col} again`).not.toMatch(
        new RegExp(`\\b${col}\\b`),
      );
    }
  });

  it("the heading names the work, not a price list", () => {
    expect(flat(source("lake"))).toContain("Services on {lake.name}");
  });

  it("and it still says what happens instead, rather than going quiet", () => {
    // A service that disappears without a sentence is the worse bug. The card
    // keeps its list, and the footer says who prices the work and when.
    const text = rendered("lake");
    expect(text, "the lake page no longer says crews are being onboarded")
      .toContain("we're onboarding crews on");
    expect(text).toContain("nothing is charged until the work is done");
    // The admission eight lines up, which the twelve figures used to
    // contradict, is the half that was always true.
    expect(text).toContain("we're building our crew bench on");
  });

  it("every active service still renders — nothing vanishes silently", () => {
    // The old code dropped a row whose floor came back null (`if (!fp) return
    // null`), which is how a crew-priced service disappeared from its own
    // lake's page. There is no early return left to reinstate.
    const map = flat(source("lake"));
    const start = map.indexOf("{(services ?? []).map(");
    expect(start, "the services list moved — this scan is measuring nothing").toBeGreaterThan(-1);
    const block = map.slice(start, map.indexOf("</div>", start));
    expect(block, "a row is being dropped before it renders").not.toContain("return null");
  });
});

/** The one-line supabase chain that loads the menu, from `from("services")` to
 *  the end of that line. Both files write it on one line; a reformat that
 *  broke it up would empty this and fail the length guard below. */
function servicesChain(key: keyof typeof FILES): string {
  const src = source(key);
  const i = src.indexOf('from("services")');
  expect(i, `no services query in ${FILES[key]} — the scan is stale`).toBeGreaterThan(-1);
  const chain = src.slice(i, src.indexOf("\n", i));
  expect(chain.length, `the services query in ${FILES[key]} is not on one line any more`)
    .toBeGreaterThan(60);
  return chain;
}

describe("both public-facing doors ask the database who sets the price", () => {
  // 0174 added services.crew_priced and fourteen files read it. These two did
  // not, which is this codebase's "a rule in one doorway of three" — inside the
  // commit that was meant to close it. A door that cannot SEE the flag cannot
  // honour it: the lake page would print a floor for a service with no menu,
  // and the set-up wizard's crew-quoted branch could never fire.
  for (const key of ["lake", "setup"] as const) {
    it(`${FILES[key]} selects crew_priced`, () => {
      expect(servicesChain(key), `${FILES[key]} cannot tell a crew-priced service apart`)
        .toContain("crew_priced");
    });
  }

  it("and the lake page acts on it rather than merely loading it", () => {
    // A column with no reader is the same nothing as a column with no writer.
    expect(flat(source("lake"))).toContain("crew_priced?: boolean | null }).crew_priced === true");
  });
});

describe("the booking tile asks for a price instead of scheduling one", () => {
  const grid = () => flat(source("grid"));

  it("the label is one constant, and the menu-priced half still says Schedule", () => {
    // Collapsed BOTH ways: a test that only checked the crew-priced branch
    // would pass on a tile that said "Ask for a price" to everybody.
    expect(source("grid")).toContain('const CREW_QUOTED_ACTION = "Ask for a price"');
    expect(grid()).toContain('{s.crewPriced ? CREW_QUOTED_ACTION : "Schedule"}');
  });

  it("the modal the tile opens carries the same verb", () => {
    expect(grid()).toContain('{service.crewPriced ? CREW_QUOTED_ACTION : "Schedule"}');
  });

  it("the confirm button never prints $0 as a total for visits nobody has quoted", () => {
    // `totalPrice` is `service.price * n`, and service.price is exactly 0 on a
    // crew-priced service. The comment beside that sum claims "nothing renders
    // it there"; the multi-day confirm button did, in bold, on the control
    // that commits.
    expect(grid()).toContain(
      "service.crewPriced ? `Ask for a price on ${picked.length} visits` " +
      ": `Book ${picked.length} visits — ${formatPrice(totalPrice)}`",
    );
  });

  it("and it says what asking costs you, because asking does book the day", () => {
    expect(rendered("grid")).toContain("you'll see the number after you ask, not before");
  });
});

describe("one figure means one visit, in one place", () => {
  it("the unit is a single constant both the tile and the panel read", () => {
    const src = source("grid");
    expect(src).toContain('const PER_VISIT = "per visit"');
    expect(src, "perVisit() is gone — the tile and the panel can drift again")
      .toContain("const perVisit = (price: number)");
  });

  it("the old inline copy of the sentence is gone", () => {
    // "the right thing existed and the door didn't use it" is a named class
    // here: the words were already in this file, in the several-days panel,
    // which is OFF by default. A second literal is how they drift.
    expect(flat(source("grid")), "a second hand-written 'per visit' is back")
      .not.toMatch(/\)\} per visit/);
  });

  it("the tile prints it beside the figure", () => {
    // The pier tile shows "Install (spring) · Removal (fall)" on one line and
    // one number on the next, and that number is EACH WAY — one job per date,
    // priced per trip. ProfileWizard has said "per trip" on its own tile all
    // along; this screen said nothing.
    const tile = flat(source("grid"));
    const at = tile.indexOf("{s.crewPriced ? CREW_QUOTED_TILE");
    expect(at, "the tile's price cell moved").toBeGreaterThan(-1);
    expect(tile.slice(at, at + 500)).toContain("{PER_VISIT}");
  });

  it("so does the modal, where somebody actually commits", () => {
    const src = flat(source("grid"));
    expect(src).toContain("{service.crewPriced ? service.priceNote : perVisit(service.price)}");
    const at = src.indexOf("<b>Your price</b>");
    expect(at, "the summary row moved").toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain("{PER_VISIT}");
  });
});

describe("the booking page hedges only when there is something to hedge", () => {
  it("the crew-quoted sentence is driven by the menu it introduces", () => {
    // Not a flag, not a hardcoded true: the same list that renders the tiles.
    // A sentence about crew-quoted services on a menu that has none is noise,
    // and a menu that has one cannot lead with "every price is exact".
    expect(flat(source("book"))).toContain("wanted.some((s) => s.crewPriced)");
  });

  it("and the crew-priced services still reach that menu at all", () => {
    // The worse half of the original bug: `price > 0` deleted them with no
    // sentence anywhere. Both halves of the condition, so collapsing either
    // one fails.
    expect(flat(source("book"))).toContain("priced.filter((s) => s.price > 0 || s.crewPriced)");
  });
});

/* ===================================================================== */
/*  THE DOORS NOBODY'S PACKAGE LISTED                                    */
/* ===================================================================== */

/**
 * THE SAME SENTENCE, IN SIX MORE PLACES.
 *
 * The four screens above were each assigned to a builder. These were not, and
 * every one of them was still saying the thing those four had just stopped
 * saying — which is this repo's "a rule in one doorway of three", measured
 * across the whole product rather than inside one file:
 *
 *   /welcome            "price every service exact to your place"
 *   /profile            "every price becomes exact to your property"
 *   /profile (email)    "Every price below is exact to your property" — and it
 *                       LEAVES the product. A screen can be corrected next
 *                       week; an inbox cannot.
 *   /                   "See the full price upfront" — the front door, no
 *                       login, the most-read page there is.
 *   /lakes              "One all-in price per service" — the index directly
 *                       above the three pages that just dropped every figure.
 *   /requests/[id]      "$0.00" in 26px bold over "no add-ons, no surprises".
 *
 * The last is not copy at all, which is why it is the most expensive: a
 * crew-priced job carries `customer_price` NULL from booking until the crew
 * names a figure (0174, book/actions.ts), `formatCurrency` renders null as
 * "$0.00", and the customer's own job page therefore printed a price nobody
 * had charged under the heading "Your invoice".
 */
const MORE_FILES = {
  welcome: "./welcome/page.tsx",
  profileHome: "./profile/page.tsx",
  setupEmail: "./profile/email-actions.ts",
  home: "./page.tsx",
  lakesIndex: "./lakes/page.tsx",
  jobDetail: "./requests/[id]/page.tsx",
  wizard: "../components/ProfileWizard.tsx",
} as const;

const moreSource = (k: keyof typeof MORE_FILES) => strip(read(MORE_FILES[k]));
const moreRendered = (k: keyof typeof MORE_FILES) => asRendered(moreSource(k));

/** The phrases these six shipped, on top of the four above. Same rule: a claim
 *  of firmness with nothing behind it, or a unit noun that is not the unit. */
const MORE_FIRM_PRICE_CLAIMS = [
  "exact to your place",
  "exact to your property",
  "full price upfront",
  "all-in price per service",
];

describe("the second scanner is reading the files it claims to read", () => {
  it("finds all of them, and they are real files", () => {
    for (const [name, rel] of Object.entries(MORE_FILES)) {
      expect(read(rel).length, `${name} (${rel}) is gone or empty — repoint MORE_FILES`)
        .toBeGreaterThan(1500);
    }
  });

  it("every phrase matches a sentence that actually shipped", () => {
    // Verbatim from 22 September 2026. A phrase matching none of these would
    // be decoration, and decoration is how a scanner comes to pass on nothing.
    const shipped = [
      "price every service exact to your place.",
      "and every price\n              becomes exact to your property.",
      "Every price below is exact to your property. We coordinate it all",
      "See the full price upfront, know when the work is scheduled",
      "One all-in price per service, an independent local crew",
      // Found by this scanner rather than by a reader, which is the argument
      // for having one: the wizard's own recap hedged on WHO prices the work
      // (`anyCrewQuoted`) and never on whether the number is firm.
      ", priced exactly to your place",
    ].map(asRendered);
    for (const sentence of shipped) {
      expect(
        [...FIRM_PRICE_CLAIMS, ...MORE_FIRM_PRICE_CLAIMS].some((p) => sentence.includes(p)),
        `no banned phrase matches a sentence this block exists because of: ${sentence}`,
      ).toBe(true);
    }
  });
});

describe("no other door calls a price firm either", () => {
  for (const key of Object.keys(MORE_FILES) as Array<keyof typeof MORE_FILES>) {
    it(`${MORE_FILES[key]} makes no firmness claim`, () => {
      const text = moreRendered(key);
      // BOTH lists, because the four original sentences have no more right to
      // live on these six screens than on their own.
      const banned = [...FIRM_PRICE_CLAIMS, ...MORE_FIRM_PRICE_CLAIMS];
      expect(
        banned.filter((p) => text.includes(p)),
        `${MORE_FILES[key]} tells somebody a price is exact, upfront or one-per-service. ` +
        `No crew has been onboarded and a crew_priced service has no number at all.`,
      ).toEqual([]);
    });
  }
});

describe("the setup email prints a sentence, not $0.00, for a service with no price", () => {
  it("builds its rows from the priced services, never from a name lookup", () => {
    // `priceMap.get(name) ?? 0` turned TWO different absences into a confident
    // figure of zero: a crew-priced row (price 0 by design) and a chosen name
    // matching no service at all.
    const src = flat(moreSource("setupEmail"));
    expect(src, "the email is back to looking a price up by name")
      .not.toContain("priceMap.get(name) ?? 0");
    expect(src, "the email no longer maps over the services themselves")
      .toContain("const rows: Array<[string, string]> = services .filter(");
  });

  it("and reads crewPriced, with the sentence the rest of the product uses", () => {
    const src = flat(moreSource("setupEmail"));
    expect(src).toContain("s.crewPriced ? (s.priceNote ?? CREW_QUOTES_THIS) : formatPrice(s.price)");
    // Imported, not re-typed — "the right thing existed and the door didn't use
    // it" is a named class here and CREW_QUOTES_THIS has exactly one home.
    expect(src, "CREW_QUOTES_THIS is being re-typed rather than imported")
      .toContain('CREW_QUOTES_THIS } from "./data"');
  });
});

describe("a job nobody has quoted shows no figure at all", () => {
  it("the loader hands back null rather than coercing it to zero", () => {
    const src = flat(strip(read("./requests/job-detail-data.ts")));
    expect(src, "customer_price is being coerced to 0 again")
      .not.toContain("customerPrice: Number(job.customer_price ?? 0)");
    expect(src).toContain("customerPrice: job.customer_price == null ? null : Number(job.customer_price)");
  });

  it("and the invoice card branches on it instead of formatting it", () => {
    // formatCurrency(null) is "$0.00" — it is the crew's take-home formatter
    // and null-safe by design, which is exactly why a null must never reach
    // it here.
    const src = flat(moreSource("jobDetail"));
    expect(src, "the no-price branch is gone").toContain("headline == null ? (");
    expect(src).toContain("No price yet");
  });

  it("the no-surprises promise cannot be reached by a job with no price", () => {
    // Collapsed both ways: the sentence must still be there for a job that HAS
    // a figure, and must sit inside the branch that only runs when one exists.
    const src = flat(moreSource("jobDetail"));
    const promise = "One all-in price — crew, materials, and LakeLife. No add-ons, no surprises.";
    expect(src, "the promise was deleted rather than fenced").toContain(promise);
    const at = src.indexOf("headline == null ? (");
    const promiseAt = src.indexOf(promise);
    expect(at, "the no-price branch moved").toBeGreaterThan(-1);
    expect(promiseAt, "the promise moved above the branch that fences it").toBeGreaterThan(at);
  });
});

describe("the wizard's price hints name the unit the engine actually charges", () => {
  // `Boat storage & winterize` and `Jet ski winterize & store` are seeded
  // (0047) with two frequency options each, and `createBookingBatch` writes
  // ONE job per booked date at this figure — so a season is twice the number,
  // and "/season" understated a boat owner's year by 2×. The right noun was
  // already in the same helper: `PWC lift set / pull`, identically shaped, has
  // said "/trip" all along. BookingGrid's tile now says "per visit" off the
  // same arithmetic, and two screens cannot use two nouns for one number.
  it("nothing in the wizard prices a per-trip service by the season", () => {
    // BOTH SPACINGS. The first sweep of this only banned "/season" and the
    // recap's own unit table wrote "/ season" — a fourth doorway that survived
    // the fix and was found by a different test's failure output, not by this
    // one. A scanner that misses the spaced form of a token IS the hole.
    const src = moreSource("wizard");
    for (const form of ["/season", "/ season"]) {
      expect(src, `a '${form}' hint is back over a per-trip figure`).not.toContain(form);
    }
  });

  it("and the per-trip noun is still on all three of them", () => {
    const src = moreSource("wizard");
    for (const svc of ["Boat storage & winterize", "Jet ski winterize & store", "PWC lift set / pull"]) {
      const at = src.indexOf(`priceOf("${svc}")`);
      expect(at, `${svc} lost its price hint`).toBeGreaterThan(-1);
      expect(src.slice(at, at + 60), `${svc} no longer names a trip`).toContain("/trip");
    }
  });
});
