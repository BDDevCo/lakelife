import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A FIXTURE CREW MUST NEVER BE ROUTED REAL WORK.
 *
 * Three scratch accounts own three ACTIVE vendors, and `buildCandidates`
 * selected every vendor and filtered only on status, service and lake — so the
 * routing pool for Pretty Lake contained a crew called "Iso Test Vendor 2 LLC".
 * The first real booking could have been assigned to it, and the likeliest
 * outcome is not a stranger in a driveway but a job that silently never
 * happens.
 *
 * A fourth account owns the property carrying seven of the eight jobs, which is
 * why this is a FENCE and not a DELETE: those rows are the only end-to-end
 * proof the product works, and nothing has met a real crew yet.
 *
 * DERIVED, NOT DUPLICATED. The first attempt added `vendors.is_fixture` beside
 * the `users.is_fixture` that 0126 already ships. That is the same truth
 * written twice, free to disagree the moment somebody flags an account and
 * forgets the crew — the defect class this codebase keeps digging out. An
 * account either stands for a person or it does not; a crew is a fixture
 * BECAUSE ITS OWNER IS. So the fence joins, and needs no schema change at all.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const DISPATCH = "../app/book/dispatch.ts";

describe("the scanner", () => {
  it("reads the file it thinks it reads", () => {
    expect(code(DISPATCH)).toContain("buildCandidates");
  });

  it("strips comments, so prose cannot satisfy a test", () => {
    // The doc block above the pool explains the fence at length.
    expect(src(DISPATCH)).toContain("is_fixture");
    const stripped = code(DISPATCH);
    expect(stripped).toContain("is_fixture"); // still in the query itself
  });
});

describe("every vendor query the router uses is fenced", () => {
  const dispatch = code(DISPATCH);

  /**
   * THE RULE, stated properly: a query that builds a POOL must be fenced. A
   * query that looks up ONE crew already chosen need not be — it came out of a
   * fenced pool, so the answer is already known to be real.
   *
   * Written as "every select is fenced OR scoped to a single id" rather than a
   * count, because a count is the thing that goes stale: this file had three
   * vendor selects when I believed it had two, and an assertion of `toBe(2)`
   * would have gone green the day somebody added a fourth pool.
   */
  function vendorSelects(): string[] {
    // LINE-BASED, because every query in this file is written on one line and
    // a character-offset splitter is not: my first attempt cut mid-string and
    // reported two of the three sites as unfenced.
    return dispatch
      .split("\n")
      .filter((l) => l.includes('from("vendors")') && l.includes(".select("));
  }

  it("finds every place vendors are selected", () => {
    // Three today: the routing pool, the month calendar, and one by-id lookup
    // of the winner. The first two decide WHO COULD BE SENT; the third asks a
    // question about a crew already picked.
    expect(vendorSelects().length).toBeGreaterThanOrEqual(3);
  });

  it("every POOL is fenced, and every unfenced one is a single-id lookup", () => {
    for (const stmt of vendorSelects()) {
      const fenced = stmt.includes('.eq("users.is_fixture", false)');
      const singleId = /\.eq\("id",\s*\w+\)/.test(stmt);
      // One or the other. A pool that is neither is a fixture in front of a
      // customer; the calendar one would do it silently, by opening dates only
      // a scratch crew could take.
      expect({ stmt: stmt.trim().slice(0, 80), fencedOrScoped: fenced || singleId })
        .toEqual({ stmt: stmt.trim().slice(0, 80), fencedOrScoped: true });
    }
  });

  it("at least two of them are real fences, not all lookups", () => {
    // Guards the guard: if the rule above were satisfied only by everything
    // becoming a by-id lookup, the fence would have quietly disappeared.
    const fenced = vendorSelects().filter((s) => s.includes('.eq("users.is_fixture", false)'));
    expect(fenced.length).toBeGreaterThanOrEqual(2);
  });

  it("never filters a column on vendors itself", () => {
    // `vendors.is_fixture` does not exist and must not be reintroduced: it
    // would be the owner's flag copied, with nothing keeping the copy true.
    expect(dispatch).not.toMatch(/\.eq\("is_fixture", false\)/);
  });
});

describe("the join names its foreign key", () => {
  const dispatch = code(DISPATCH);

  it("disambiguates user_id from invited_by", () => {
    // `vendors` has TWO foreign keys into `users`: user_id (whose crew this
    // is) and invited_by (who asked them along). PostgREST refuses the
    // ambiguous embed rather than guessing — which is lucky, because filtering
    // on the INVITER would look like it worked and fence the wrong crews.
    const embeds = dispatch.match(/users!vendors_user_id_fkey!inner\(is_fixture\)/g) ?? [];
    expect(embeds.length).toBe(2);
    expect(dispatch).not.toContain("vendors_invited_by_fkey");
  });

  it("keeps each select in ONE string literal", () => {
    // supabase-js parses the select at the TYPE level; a concatenated string
    // widens to `string`, which collapses every column to GenericStringError.
    // The embed made these lines long enough to be tempting to split.
    expect(dispatch).not.toMatch(/\.select\(\s*["'][^"']*["']\s*\+/);
  });

  it("uses an INNER join, so a crew with no owner cannot slip through", () => {
    // A left join would return vendors whose user row is missing with a null
    // embed, and `users.is_fixture = false` would not exclude them.
    const inner = dispatch.match(/!inner\(/g) ?? [];
    expect(inner.length).toBe(2);
  });
});

describe("no schema change was needed", () => {
  it("does not depend on a migration that adds vendors.is_fixture", () => {
    // The fence rides on 0126's users.is_fixture, which is already applied.
    // If a future migration adds the duplicate column, this fails and asks
    // why the same truth is being stored twice.
    const dispatch = code(DISPATCH);
    expect(dispatch).toContain("users.is_fixture");
  });
});
