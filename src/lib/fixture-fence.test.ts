import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NO FIXTURE REACHES THE PUBLIC, AND NO NEW READER GETS TO FORGET.
 *
 * Before 0124 the only thing keeping a test lake off the live site was its
 * NAME, checked by hand in eight places — four against `name`, three against
 * `slug`, one in JavaScript. On 14 Aug 2026 a parallel session inserted
 * "Scratch Test Lake" with no prefix and a null slug. It went onto the
 * production homepage. It missed /lakes and sitemap.xml only because
 * `NOT (NULL ILIKE 'zz-%')` is NULL rather than TRUE — hidden by accident, and
 * the accident would have reversed the moment somebody filled the slug in.
 *
 * A NINTH SITE HAD NO GUARD AT ALL, and nobody had noticed because the two
 * surfaces that LINK to it were both filtered: /lakes/[slug] fetched by slug
 * and rendered a full public landing page, SEO metadata included, for anyone
 * who typed the URL.
 *
 * So this file tests the RULE, not the instances. Reading source text is the
 * point: the failure mode is an omission, and you cannot write a behavioural
 * test for a query nobody wrote. The second test is the one that matters in a
 * year — a new file that reads `lakes` fails until a human classifies it.
 */

const ROOT = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/**
 * A NESTED EMBED READS `lakes` WITHOUT EVER WRITING `.from("lakes")`:
 *
 *     .from("properties").select("lake_id, lakes(name)")
 *
 * The first version of this file matched only `.from("lakes")`, so thirteen
 * files were invisible to it — not trusted by decision, just unseen, which is
 * precisely the failure this file exists to prevent. Caught by the session
 * working alongside this one.
 *
 * Scans the `.select("…")` STRING and not the raw source on purpose: prose in
 * comments ("demand-born lakes (lib/lake-birth.ts)") matches a naive pattern
 * and produces false positives. A select argument is always one string literal
 * in this codebase, which is what makes that narrowing safe.
 */
function selectArgs(src: string): string[] {
  // Walks each `.select(` argument to its own closing paren, tracking string
  // state, and returns the CONCATENATION of its string literals. A one-literal
  // regex is not enough: three ops files build the argument across lines with
  // `+`, and the embed lives in a later fragment —
  //   "properties(id, address, lakes(name), users(name)), " +
  //   "vendors(company)"
  // Those three were exactly the ones a first-literal match missed.
  const out: string[] = [];
  for (const m of src.matchAll(/\.select\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1, quote = "", lit = "";
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (quote) {
        if (c === "\\") { i += 2; continue; }
        if (c === quote) quote = ""; else lit += c;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    if (lit) out.push(lit);
  }
  return out;
}

function embedReaders(): Array<{ file: string; sel: string }> {
  const out: Array<{ file: string; sel: string }> = [];
  for (const abs of walk(ROOT)) {
    const file = relative(process.cwd(), abs);
    for (const sel of selectArgs(readFileSync(abs, "utf8"))) {
      if (/(^|[\s,(])lakes\s*(![a-z]+)?\s*\(/.test(sel)) out.push({ file, sel });
    }
  }
  return out;
}

/** Every `.from("lakes")` in the codebase, with the query chain that follows. */
function lakeQueries() {
  const out: Array<{ file: string; chain: string; isInsert: boolean }> = [];
  for (const abs of walk(ROOT)) {
    const src = readFileSync(abs, "utf8");
    const file = relative(process.cwd(), abs);
    for (const m of src.matchAll(/\.from\("lakes"\)/g)) {
      // The chain runs to the end of the statement. Awaits and .then() never
      // appear mid-chain in this codebase, so a semicolon is a safe terminator.
      const rest = src.slice(m.index ?? 0);
      const end = rest.indexOf(";");
      const chain = end === -1 ? rest.slice(0, 400) : rest.slice(0, end);
      out.push({ file, chain, isInsert: /\.(insert|upsert|update|delete)\(/.test(chain) });
    }
  }
  return out;
}

/**
 * Files where EVERY read of `lakes` must exclude fixtures, because what they
 * produce is seen by the public or sent to a real person.
 */
const MUST_FENCE: Record<string, string> = {
  // (a) reaches an anonymous visitor or a crawler
  "src/app/page.tsx": "the homepage lake sentence — the surface a scratch lake actually reached",
  "src/app/lakes/page.tsx": "the public lake directory",
  "src/app/lakes/[slug]/page.tsx": "the public lake landing page — had NO guard at all before 0124",
  "src/app/sitemap.ts": "sitemap.xml — a crawled URL outlives the fixture that made it",
  "src/app/parks/public-data.ts": "labels a public park page with its lake's name",
  // (b) leaves the system as an email or an SMS
  "src/app/ops/crews-invite.ts": "names the lakes in an invitation EMAIL to a real crew",
  // (c) hands a lake id or name to a write that binds a real row to it
  "src/app/profile/actions.ts": "writes properties.lake_id — the binding every season gate reads",
  "src/app/profile/setup/page.tsx": "the chips a customer picks their lake from",
  "src/app/vendor/onboarding-actions.ts": "the whitelist behind vendors.service_lakes",
  "src/app/ops/parks-actions.ts": "writes parks.lake_id, and the picker that feeds it",
  "src/app/vendor/page.tsx": "crew lake picker",
  "src/app/vendor/open/page.tsx": "crew lake picker",
  "src/app/vendor/rates/page.tsx": "crew lake picker",
  "src/app/vendor/schedule/page.tsx": "crew lake picker",
  "src/app/vendor/earnings/page.tsx": "crew lake picker",
  "src/app/vendor/availability/page.tsx": "crew lake picker",
  "src/app/vendor/import/page.tsx": "crew lake picker",
};

/**
 * Some files hold several lake reads where only ONE must be fenced, so
 * file-level granularity cannot say what is meant. Each entry pins a single
 * query by something unique to it.
 */
const MUST_FENCE_QUERY: Array<{ file: string; anchor: RegExp; why: string }> = [
  {
    file: "src/lib/automation.ts",
    anchor: /pull_deadline/,
    why: "sendSeasonalPullReminders EMAILS every owner on the matched lake, naming it",
  },
  {
    file: "src/lib/lake-birth.ts",
    anchor: /season_confirmed/,
    why: "a real lake must not inherit a fixture's ice-out and pull deadline",
  },
  {
    file: "src/lib/lake-birth.ts",
    anchor: /\.or\(/,
    why: "a customer naming their lake must not be deduped INTO a fixture",
  },
  {
    file: "src/lib/lake-birth.ts",
    anchor: /duplicate\|unique|\.eq\("slug", slug\)/,
    why: "the 23505 retry must not hand back a fixture that holds the slug",
  },
];

/**
 * Everywhere else that touches `lakes`, each with the reason seeing a fixture
 * is correct there. Ops and crews are signed in and sometimes need to work ON
 * the fixture; the engine needs every row to do its bookkeeping.
 */
const MAY_SEE_FIXTURES: Record<string, string> = {
  "src/lib/automation.ts": "the engine — must account for every row it schedules against",
  "src/lib/lake-birth.ts": "dedupe + insert; the season-donor read is fenced and asserted separately below",
  "src/lib/comms-context.ts": "a signed-in crew's own service lakes",
  "src/app/ops/data.ts": "ops edits lake conditions — somebody has to be able to set a fixture's dates",
  "src/app/ops/actions.ts": "ops writes lake conditions",
  "src/app/ops/parks-data.ts": "ops park admin",
  "src/app/ops/parks-actions.ts": "ops park admin",
  "src/app/park/data.ts": "a signed-in park owner's own park",
  "src/app/parks/public-data.ts": "resolves a lake NAME by id for an already-active park; fencing here blanks a label rather than hiding a page",
  "src/app/profile/actions.ts": "a signed-in customer's own property",
  "src/app/profile/setup/page.tsx": "a signed-in customer picking their lake",
  "src/app/vendor/page.tsx": "signed-in crew",
  "src/app/vendor/open/page.tsx": "signed-in crew",
  "src/app/vendor/schedule/page.tsx": "signed-in crew",
  "src/app/vendor/rates/page.tsx": "signed-in crew",
  "src/app/vendor/earnings/page.tsx": "signed-in crew",
  "src/app/vendor/availability/page.tsx": "signed-in crew",
  "src/app/vendor/import/page.tsx": "signed-in crew",
  // Reached only through a nested embed — `lakes(name)` on another table.
  // Every one is a signed-in surface: an owner's own property, a crew's own
  // board, or ops. None is public, which is why the fence still held while
  // they were invisible.
  "src/app/book/actions.ts": "the booking path — season gates + the same-day rush blast (see below)",
  "src/app/book/page.tsx": "a signed-in owner booking their own property",
  "src/app/book/storage/actions.ts": "a signed-in owner's storage booking",
  "src/app/requests/actions.ts": "a signed-in owner's own requests",
  "src/app/profile/data.ts": "a signed-in owner's own profile",
  "src/app/profile/account-actions.ts": "a signed-in owner's own account",
  "src/app/vendor/job-detail-data.ts": "a signed-in crew's own job",
  "src/app/vendor/open-data.ts": "a signed-in crew's open board",
  "src/app/ops/calendar-data.ts": "ops",
  "src/app/ops/dispatch-data.ts": "ops",
  "src/app/ops/job-detail-data.ts": "ops",
  "src/app/ops/messages-data.ts": "ops",
  "src/app/ops/search-data.ts": "ops",
};

describe("the fixture fence", () => {
  const queries = lakeQueries();

  it("still finds the queries, so the regex has not silently stopped matching", () => {
    expect(queries.length).toBeGreaterThan(20);
    expect(queries.some((q) => q.file === "src/app/sitemap.ts")).toBe(true);
  });

  it("EVERY PUBLIC AND OUTBOUND READ EXCLUDES FIXTURES", () => {
    const unfenced = queries
      .filter((q) => q.file in MUST_FENCE && !q.isInsert)
      .filter((q) => !q.chain.includes("is_fixture"))
      .map((q) => `${q.file} — ${MUST_FENCE[q.file]}`);
    expect(unfenced, `these reach the public without excluding fixtures:\n${unfenced.join("\n")}`)
      .toEqual([]);
  });

  it("EVERY QUERY-LEVEL RULE HOLDS", () => {
    const broken = MUST_FENCE_QUERY.filter((r) => {
      const hit = queries.find((q) => q.file === r.file && r.anchor.test(q.chain));
      return !hit || !hit.chain.includes("is_fixture");
    }).map((r) => `${r.file} [${r.anchor}] — ${r.why}`);
    expect(broken, `unfenced, or the anchor stopped matching:\n${broken.join("\n")}`).toEqual([]);
  });

  it("A NEW READER OF `lakes` MUST BE CLASSIFIED, not silently trusted", () => {
    // Direct reads AND embedded ones. A `.select("lake_id, lakes(name)")` is a
    // read of this table; leaving it out of the census left 13 files unseen.
    const readers = [
      ...queries.map((q) => q.file),
      ...embedReaders().map((e) => e.file),
    ];
    const unclassified = [...new Set(
      readers.filter((f) => !(f in MUST_FENCE) && !(f in MAY_SEE_FIXTURES)),
    )];
    expect(
      unclassified,
      `new file(s) reading lakes. Decide, in src/lib/fixture-fence.test.ts:\n` +
      `  - public or outbound? add to MUST_FENCE and put .eq("is_fixture", false) on the query\n` +
      `  - signed-in or internal? add to MAY_SEE_FIXTURES with the reason\n` +
      unclassified.join("\n"),
    ).toEqual([]);
  });

  it("finds the embedded readers too, so that census cannot silently empty", () => {
    const files = new Set(embedReaders().map((e) => e.file));
    expect(files.size).toBeGreaterThan(10);
    expect(files.has("src/app/book/actions.ts")).toBe(true);
  });

  it("NO PUBLIC SURFACE READS `lakes` THROUGH AN EMBED", () => {
    // Fencing an embed is a different shape — `lakes!inner(...)` plus
    // `.eq("lakes.is_fixture", false)` — and no rule for it is written yet.
    // Nothing public needs one today. This test is what makes that sentence
    // stay true: the day a public surface reaches lakes by embed, it fails
    // here rather than shipping unfenced through a hole in the other tests.
    const publicEmbeds = embedReaders()
      .filter((e) => e.file in MUST_FENCE)
      .map((e) => `${e.file} — select("${e.sel}")`);
    expect(publicEmbeds, `public embed read with no fencing rule:\n${publicEmbeds.join("\n")}`)
      .toEqual([]);
  });

  it("the old zz- convention is gone from every query", () => {
    const stragglers = queries
      .filter((q) => /ilike[^)]*zz-/.test(q.chain))
      .map((q) => q.file);
    expect(stragglers, `still filtering by name instead of the column: ${stragglers.join(", ")}`)
      .toEqual([]);
  });
});
