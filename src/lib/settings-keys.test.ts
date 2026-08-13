import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY DIAL THE CODE READS MUST BE A DIAL THE QUERY FETCHES.
 *
 * `getPlatformSettings` fetches a fixed list of keys with `.in("key", [...])`
 * and then reads them back with `byKey.get("...")`. When 0090 added
 * `crew_trip_fee` it updated the interface, the default and the parse — and
 * not the array. `byKey.get` returned undefined, `parseSetting` silently
 * handed back the hard-coded fallback, and the database row was decorative.
 *
 * It was right by coincidence (row 35, code 35). It would have been wrong the
 * moment anybody edited it — and the OFF SWITCH was unreachable too, since a
 * dial of 0 is the documented way to stop the accrual.
 *
 * A set difference catches it in a millisecond, which is the only reason this
 * test reads source text instead of behaviour: the failure is an omission, and
 * you cannot write a behavioural test for a line nobody wrote.
 */
describe("platform settings: fetched keys vs read keys", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/settings.ts"), "utf8");

  const fetched = new Set(
    [...(src.match(/\.in\("key",\s*\[([\s\S]*?)\]\)/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1]),
  );
  const read = new Set([...src.matchAll(/byKey\.get\("([a-z_]+)"\)/g)].map((m) => m[1]));

  it("finds both lists, so the regexes have not silently stopped matching", () => {
    expect(fetched.size).toBeGreaterThan(20);
    expect(read.size).toBeGreaterThan(20);
  });

  it("READS NOTHING IT DID NOT FETCH — the 0090 bug", () => {
    const missing = [...read].filter((k) => !fetched.has(k));
    expect(missing, `read but never fetched, so always falls back to the code default: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("fetches nothing it never reads, so the list cannot rot", () => {
    const unused = [...fetched].filter((k) => !read.has(k));
    expect(unused, `fetched but never read: ${unused.join(", ")}`).toEqual([]);
  });
});
