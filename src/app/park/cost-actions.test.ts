import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SECOND ID.
 *
 * `recordCost` proves the PARK is yours on its first line. It said nothing
 * about `sourceJobId`, and 0111 makes that column unique across the whole
 * table — so attaching another park's job id spent that job's only slot, and
 * the victim could never bill their own mow again.
 *
 * A source check, because the failure is a guard nobody wrote: there is no
 * behavioural test that can observe a check which is absent, and every path
 * here needs a live Postgres with two parks, two properties and a job.
 */
describe("recordCost scopes the job id to the park", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
  const code = (p: string) =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const body = () => {
    const src = code("app/park/cost-actions.ts");
    const fn = src.match(/export async function recordCost[\s\S]*?\n}/)?.[0] ?? "";
    // A regex that can match nothing is a test that passes vacuously.
    expect(fn.length, "recordCost not found — the scan is measuring nothing").toBeGreaterThan(400);
    return fn;
  };

  it("checks the park owns the job before writing anything", () => {
    const fn = body();
    expect(fn, "recordCost must validate sourceJobId").toMatch(/if \(sourceJobId\)/);
    // The job must be matched against the park's own service property.
    expect(fn).toMatch(/service_property_id/);
    expect(fn).toMatch(/\.eq\("property_id"/);
  });

  it("runs that check BEFORE any park_costs insert", () => {
    const fn = body();
    const guard = fn.indexOf("if (sourceJobId)");
    const firstInsert = fn.indexOf('.from("park_costs")');
    expect(guard, "no sourceJobId guard at all").toBeGreaterThan(-1);
    expect(firstInsert, "no park_costs insert found — scan is stale").toBeGreaterThan(-1);
    expect(guard, "the guard must precede every write, including the early-return branches")
      .toBeLessThan(firstInsert);
  });

  it("still asserts park membership on the first line", () => {
    // The guard added here must not have displaced the one added before it.
    const fn = body();
    const park = fn.indexOf("assertMyPark");
    const job = fn.indexOf("if (sourceJobId)");
    expect(park).toBeGreaterThan(-1);
    expect(park, "park membership is still checked first").toBeLessThan(job);
  });

  /**
   * Every branch that writes a cost row must sit behind both guards. recordCost
   * has three inserts on three different paths — park-carries, fee-covered, and
   * the ordinary split — and the fee-covered branch is the one that returned
   * early past the membership check last time.
   */
  it("no park_costs insert escapes in front of the guards", () => {
    const fn = body();
    const guards = Math.max(fn.indexOf("assertMyPark"), fn.indexOf("if (sourceJobId)"));
    const inserts = [...fn.matchAll(/\.from\("park_costs"\)\s*\n?\s*\.insert/g)].map((m) => m.index ?? -1);
    expect(inserts.length, "expected the write paths to be found").toBeGreaterThan(0);
    for (const at of inserts) {
      expect(at, "a park_costs insert sits before the guards").toBeGreaterThan(guards);
    }
  });
});
