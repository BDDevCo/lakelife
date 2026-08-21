import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE LOT THE VIEW COULD NEVER FIND.
 *
 * `/park/visits` said "Grounds" for every visit ever made inside a park —
 * always, for every park, since 0107 shipped. 0107 added `jobs.park_lot_id`,
 * joined the view to it and guarded it with a trigger, and then nothing ever
 * wrote it. The link that IS maintained arrived three weeks later in 0122:
 * `park_lots.service_property_id`, whose own heading is "THE LOT CARRIES THE
 * LINK".
 *
 * This is the codebase's dominant defect: a column read everywhere and written
 * by nothing. The test that catches it is not about the screen — it is about
 * whether the join has a writer.
 */

const root = join(__dirname, "..", "..", "..");
const MIGRATIONS = join(root, "supabase", "migrations");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The newest definition of the view wins — that is the one running. */
function latestViewSql(): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest = "";
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (/create or replace view public\.park_site_visits/.test(sql)) latest = sql;
  }
  return latest;
}


/**
 * Every `.from("<table>")` statement whose INLINE object literal sets
 * park_lot_id. A statement that builds its rows array separately (as the
 * park_charges run does) is invisible here — see the guard-the-guard test.
 */
function writersOf(table: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        const body = readFileSync(p, "utf8");
        const needle = `from("${table}")`;
        for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + 1)) {
          const stmt = body.slice(i, i + 600);
          // Stop at the next .from( so one statement cannot borrow the next.
          const next = stmt.indexOf('from("', needle.length);
          const scoped = next === -1 ? stmt : stmt.slice(0, next);
          if (/\.(insert|update|upsert)\(/.test(scoped) && /park_lot_id:/.test(scoped)) {
            hits.push(p);
          }
        }
      }
    }
  };
  walk(join(root, "src"));
  return hits;
}

const jobsParkLotWriters = () => writersOf("jobs");

describe("the scanner", () => {
  it("finds a migration that defines the view", () => {
    expect(latestViewSql()).toMatch(/create or replace view public\.park_site_visits/);
  });
});

describe("park_site_visits joins a link something writes", () => {
  const sql = latestViewSql();

  it("does not join jobs.park_lot_id, which nothing writes", () => {
    expect(sql).not.toMatch(/on l\.id = j\.park_lot_id/);
  });

  it("joins the lot's own service_property_id", () => {
    expect(sql).toMatch(/join public\.park_lots l on l\.service_property_id = j\.property_id/);
  });

  it("jobs.park_lot_id still has no writer anywhere in the app", () => {
    // If somebody later gives the column a writer, this fails and the join
    // above becomes a live choice again rather than the only option.
    //
    // SCOPED TO THE STATEMENT, not the file. Whole-file matching called
    // cost-actions.ts a writer because it happens to contain both a
    // `from("jobs")` read and a `park_lot_id:` key belonging to an unrelated
    // lot_cost_shares insert.
    expect(jobsParkLotWriters()).toEqual([]);
  });

  it("that scan would notice a writer if one appeared", () => {
    // Guards the guard: the same window applied to a table that really does
    // take park_lot_id must find it, or the assertion above proves nothing.
    // park_requests inserts an inline literal; park_charges builds its rows
    // array first, which this window deliberately cannot see — so the scan is
    // evidence, and the join assertion above is the actual guarantee.
    expect(writersOf("park_requests").length).toBeGreaterThan(0);
  });

  it("still withholds everything 0085 kept out", () => {
    // The SELECT list only — the prose above it and the view comment below it
    // both NAME these columns in order to say they are excluded.
    const select = sql
      .slice(sql.indexOf("create or replace view"), sql.indexOf("comment on view"))
      .replace(/^\s*--.*$/gm, "");
    for (const banned of ["renter_id", "customer_price", "margin", "vendor_cost", "address"]) {
      expect(select).not.toContain(banned);
    }
    // and the scan is looking at something real
    expect(select).toContain("lot_number");
  });

  it("is not granted to anon or authenticated", () => {
    expect(sql).toMatch(/revoke all on public\.park_site_visits from anon, authenticated/);
    expect(sql).not.toMatch(/grant select on public\.park_site_visits to authenticated/);
  });
});

describe("the visit board does not render a failed read as an empty drive", () => {
  const src = read("src/app/park/visits-data.ts");

  it("guards the visits read", () => {
    expect(src).toContain('mustRead("the visits booked in your park"');
  });

  it("guards the linked-properties count", () => {
    expect(src).toContain("mustCount(");
  });

  it("no longer destructures data straight out of the query", () => {
    expect(src).not.toMatch(/const \[\{ data: rows \}/);
  });
});
