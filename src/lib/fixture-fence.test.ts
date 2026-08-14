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
  "src/app/page.tsx": "the homepage lake sentence — the surface a scratch lake actually reached",
  "src/app/lakes/page.tsx": "the public lake directory",
  "src/app/lakes/[slug]/page.tsx": "the public lake landing page — had NO guard at all before 0124",
  "src/app/sitemap.ts": "sitemap.xml — a crawled URL outlives the fixture that made it",
  "src/app/ops/crews-invite.ts": "names the lakes in an invitation EMAIL to a real crew",
};

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
  "src/app/vendor/onboarding-actions.ts": "a crew claiming an invite",
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

  it("A NEW READER OF `lakes` MUST BE CLASSIFIED, not silently trusted", () => {
    const unclassified = [...new Set(
      queries
        .filter((q) => !(q.file in MUST_FENCE) && !(q.file in MAY_SEE_FIXTURES))
        .map((q) => q.file),
    )];
    expect(
      unclassified,
      `new file(s) reading lakes. Decide, in src/lib/fixture-fence.test.ts:\n` +
      `  - public or outbound? add to MUST_FENCE and put .eq("is_fixture", false) on the query\n` +
      `  - signed-in or internal? add to MAY_SEE_FIXTURES with the reason\n` +
      unclassified.join("\n"),
    ).toEqual([]);
  });

  it("never inherits a season from a fixture", () => {
    // lake-birth copies ice-out and pull-deadline from the newest confirmed
    // lake onto a newly born one. A fixture's dates are arbitrary, so a real
    // lake could be born unbookable — or bookable through the ice.
    const donor = readFileSync(join(ROOT, "lib/lake-birth.ts"), "utf8")
      .match(/\.from\("lakes"\)[\s\S]*?season_confirmed[\s\S]*?;/)?.[0] ?? "";
    expect(donor).toContain("is_fixture");
  });

  it("the old zz- convention is gone from every query", () => {
    const stragglers = queries
      .filter((q) => /ilike[^)]*zz-/.test(q.chain))
      .map((q) => q.file);
    expect(stragglers, `still filtering by name instead of the column: ${stragglers.join(", ")}`)
      .toEqual([]);
  });
});
