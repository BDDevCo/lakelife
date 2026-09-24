import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * A NEW FOREIGN KEY DOES NOT BREAK WHERE IT IS ADDED. IT BREAKS EVERY QUERY
 * THAT WAS ALREADY THERE.
 *
 * Migration 0178 added `jobs.chosen_vendor_id` — the crew the customer picked
 * off the offers screen — with a foreign key to `vendors`. `jobs` already had
 * `vendor_id`. From the moment that migration applied, PostgREST could no
 * longer tell which relationship a bare `vendors(...)` embed on a `jobs` query
 * meant, and answered every one of them:
 *
 *     PGRST201 Could not embed because more than one relationship was found
 *              for 'jobs' and 'vendors'
 *
 * Those reads go through `mustRead`, which THROWS. So `/ops` returned a 500,
 * and the margin boards, the job board, the calendar and the requests queue
 * went down together — on production, for the owner, on the console he uses to
 * run the business.
 *
 * NOTHING CAUGHT IT. The migration's own post-conditions passed (they asserted
 * the column, the type, the index — all true). tsc passed. Lint passed. 6,941
 * tests passed. Every one of them was testing the code that was CHANGED, and
 * the breakage was in code nobody had touched in months.
 *
 * ============ SO THIS TEST READS THE OTHER DIRECTION ============
 *
 * It does not check the new feature. It checks that every OLD query still
 * names which relationship it means. A named foreign key costs nothing when
 * there is one relationship and is the only thing that works when there are
 * two — so the rule is simply: on an ambiguous pair, always name it.
 *
 * ============ WHEN YOU ADD A FOREIGN KEY ============
 *
 * Before applying a migration that adds one, ask which EXISTING embeds it
 * makes ambiguous. The whole check is one query:
 *
 *     select conrelid::regclass, count(*)
 *       from pg_constraint
 *      where contype = 'f' and confrelid = 'public.<target>'::regclass
 *      group by 1 having count(*) > 1;
 *
 * Anything it returns is a pair that must be named at every call site. Add the
 * pair to AMBIGUOUS below and this test will find the call sites for you.
 */

/**
 * Table -> embedded table pairs that have MORE THAN ONE foreign key between
 * them, verified against production. A bare embed of the second from the first
 * is a runtime error, not a style problem.
 */
const AMBIGUOUS: Array<{ from: string; embed: string; fks: string[]; why: string }> = [
  {
    from: "jobs",
    embed: "vendors",
    fks: ["jobs_vendor_id_fkey", "jobs_chosen_vendor_id_fkey"],
    why: "0178 added chosen_vendor_id — the crew the CUSTOMER picked — beside the vendor_id the router assigns",
  },
];

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

/** Comments explain the rule; they must never be mistaken for a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every place `embed(` appears inside a query that started at `from`, without a
 * `!fk` naming which relationship it means. Windowed to the next `.from(` so one
 * query's select cannot be blamed on another's.
 */
function unnamedEmbeds(src: string, from: string, embed: string): number[] {
  const lines: number[] = [];
  const starts = [...src.matchAll(new RegExp(`\\.from\\(\\s*["']${from}["']\\s*\\)`, "g"))];
  for (const m of starts) {
    const begin = m.index! + m[0].length;
    const nextFrom = src.indexOf(".from(", begin);
    const end = nextFrom === -1 ? Math.min(src.length, begin + 1500) : nextFrom;
    const window = src.slice(begin, end);
    for (const e of window.matchAll(new RegExp(`(?<![!\\w])${embed}\\(`, "g"))) {
      lines.push(src.slice(0, begin + e.index!).split("\n").length);
    }
  }
  return lines;
}

describe("a new foreign key breaks an old embed", () => {
  const files = sourceFiles(SRC);

  it("is reading the codebase, not an empty directory", () => {
    // A scanner over nothing passes forever. Pin that it found the app.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("app/ops/data.ts"))).toBe(true);
  });

  for (const { from, embed, fks, why } of AMBIGUOUS) {
    it(`every ${from} query names which ${embed} relationship it means`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const src = stripComments(readFileSync(file, "utf8"));
        for (const line of unnamedEmbeds(src, from, embed)) {
          offenders.push(`${file.slice(SRC.length)}:${line}`);
        }
      }
      expect(
        offenders,
        `${from} has ${fks.length} foreign keys to ${embed} (${fks.join(", ")}) — ${why}.\n` +
          `A bare ${embed}(...) on a ${from} query is PGRST201 at runtime, and these reads throw.\n` +
          `Write ${embed}!${fks[0]}(...) instead:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  for (const { from, embed, fks } of AMBIGUOUS) {
    it(`no free-floating "${embed}(" embed string can reach a ${from} query`, () => {
      // THE GAP THE FIRST CHECK HAD, and it is the one that actually broke
      // production. `CREW_FIXTURE_EMBED = "vendors(users(...))"` is not inside
      // any `.from(...)` chain — it is a constant, interpolated into selects
      // elsewhere — so a window-based scan walks straight past it while the
      // string it holds goes into three `jobs` reads.
      //
      // An embed string defined outside a query can be used by ANY query, so
      // it has to name the relationship unconditionally. This finds every bare
      // one that belongs to no query at all.
      const offenders: string[] = [];
      for (const file of files) {
        const src = stripComments(readFileSync(file, "utf8"));
        const windows: Array<[number, number]> = [];
        for (const m of src.matchAll(/\.from\(\s*["'][a-z_]+["']\s*\)/g)) {
          const begin = m.index! + m[0].length;
          const next = src.indexOf(".from(", begin);
          windows.push([begin, next === -1 ? Math.min(src.length, begin + 1500) : next]);
        }
        for (const e of src.matchAll(new RegExp(`(?<![!\\w])${embed}\\(`, "g"))) {
          const at = e.index!;
          if (windows.some(([a, b]) => at >= a && at < b)) continue; // some query owns it
          offenders.push(`${file.slice(SRC.length)}:${src.slice(0, at).split("\n").length}`);
        }
      }
      expect(
        offenders,
        `An embed string that belongs to no query can be used by ANY query, including a ${from} one, ` +
          `where a bare ${embed}(...) is PGRST201 at runtime. Write ${embed}!${fks[0]}(...):\n  ` +
          offenders.join("\n  "),
      ).toEqual([]);
    });
  }

  it("the scanner bites — it catches a bare embed and clears a named one", () => {
    // Absence-only assertions pass against a broken scanner. Feed it both.
    const broken = `await admin.from("jobs").select("id, vendors(company)").eq("id", x);`;
    const fixed = `await admin.from("jobs").select("id, vendors!jobs_vendor_id_fkey(company)").eq("id", x);`;
    expect(unnamedEmbeds(broken, "jobs", "vendors")).toHaveLength(1);
    expect(unnamedEmbeds(fixed, "jobs", "vendors")).toHaveLength(0);

    // And it does not blame the NEXT query's embed on this one.
    const twoQueries =
      `await admin.from("jobs").select("id").eq("id", x);\n` +
      `await admin.from("routes").select("id, vendors(company)");`;
    expect(unnamedEmbeds(twoQueries, "jobs", "vendors")).toHaveLength(0);
  });
});
