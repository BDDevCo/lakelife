import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SERVICE MENU FENCE, AND WHICH HALF OF IT MAY MOVE.
 *
 * 0143 opened the fence one way: a park's grounds property can now see the
 * general work it has been let buy (its own 28-section dock), on top of its
 * three grounds services.
 *
 * The other half must never move. A lake homeowner offered a 21-lot mow is the
 * failure the fence was built for, and it is the kind that looks like a
 * feature until somebody books it.
 *
 * A source scan, because the fence is a PostgREST query shape: the behaviour
 * needs a live Postgres, three services and two properties, and what actually
 * breaks is somebody editing one line of the query.
 */
const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
/** Comments explain the fence at length; only the code counts. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const menuFn = () => {
  const src = code("app/profile/data.ts");
  const fn = src.match(/export async function getPricedServices[\s\S]*?\n}/)?.[0] ?? "";
  expect(fn.length, "getPricedServices not found — this scan is measuring nothing")
    .toBeGreaterThan(400);
  return fn;
};

describe("a lake house never sees a park service", () => {
  it("asks for park_only = false on the non-grounds branch", () => {
    const fn = menuFn();
    // The whole point. If this becomes .or(...) or disappears, a lake-house
    // menu grows a 21-lot mow.
    expect(fn, "the lake-house branch must pin park_only to false")
      .toMatch(/\.eq\("park_only",\s*false\)/);
  });

  it("never widens the lake-house branch to park_bookable", () => {
    const fn = menuFn();
    // park_bookable says "a PARK may also buy this". It has no meaning on a
    // lake house, and reading it there would be the fence failing open.
    //
    // Scoped to the .or() calls that actually name a park flag. 0147 added a
    // SECOND .or() to this query — the solo_bookable door — which carries no
    // park flag at all and so cannot widen this fence in either direction.
    // The pre-0147 version of this test looped over EVERY .or() and would now
    // fail on that unrelated one, which would have said nothing true about
    // the fence.
    const orCalls = fn.match(/\.or\([^)]*\)/g) ?? [];
    expect(orCalls.length, "no .or() found — scan is stale").toBeGreaterThan(0);
    const parkOrs = orCalls.filter((c) => c.includes("park_"));
    expect(parkOrs.length, "no park .or() found — scan is stale").toBeGreaterThan(0);
    for (const call of parkOrs) {
      expect(call, "park_bookable may only widen the GROUNDS branch")
        .toMatch(/park_only\.eq\.true/);
    }
  });

  it("the solo_bookable door carries no park flag — it cannot move this fence", () => {
    const fn = menuFn();
    // 0147's door is about packages, not parks. If it ever grows a park_ term
    // it stops being a package question and becomes a fence question.
    const soloOr = (fn.match(/\.or\([^)]*\)/g) ?? []).find((c) => c.includes("solo_bookable"));
    expect(soloOr, "no solo_bookable .or() found — scan is stale").toBeTruthy();
    expect(soloOr, "the package door must not touch the park fence").not.toMatch(/park_/);
  });

  it("branches on grounds, not on something incidental", () => {
    const fn = menuFn();
    expect(fn).toMatch(/const isGrounds = p\.groundsForParkId != null/);
    const decl = fn.indexOf("const isGrounds");
    const use = fn.indexOf("isGrounds\n") >= 0 ? fn.indexOf("isGrounds\n") : fn.lastIndexOf("isGrounds");
    expect(decl, "isGrounds is not derived").toBeGreaterThan(-1);
    expect(use, "isGrounds is derived and never used").toBeGreaterThan(decl);
  });
});

describe("a park's grounds can reach its own dock", () => {
  it("includes park_bookable on the grounds branch", () => {
    const fn = menuFn();
    // Without this the park menu is three rows and the pier is invisible —
    // the bug 0143 exists to fix.
    expect(fn, "the grounds branch must admit park_bookable services")
      .toMatch(/park_bookable\.eq\.true/);
  });

  it("still gives the grounds its own park_only services too", () => {
    const fn = menuFn();
    // The PARK .or() specifically — since 0147 this query has two.
    const or = (fn.match(/\.or\("([^"]*)"\)/g) ?? [])
      .map((c) => c.match(/\.or\("([^"]*)"\)/)?.[1] ?? "")
      .find((c) => c.includes("park_")) ?? "";
    expect(or, "no park .or() filter found — scan is stale").not.toBe("");
    expect(or, "a park must keep seeing its grounds services").toContain("park_only.eq.true");
    expect(or, "and gain the ones it has been let buy").toContain("park_bookable.eq.true");
  });
});

describe("the query itself stays sound", () => {
  it("keeps the select as ONE string literal", () => {
    const fn = menuFn();
    // supabase-js parses the select at the TYPE level; a concatenated string
    // widens to `string` and collapses every column to GenericStringError.
    const sel = fn.match(/\.select\(([\s\S]*?)\)/)?.[1] ?? "";
    expect(sel, "no select found — scan is stale").not.toBe("");
    expect(sel.trim().startsWith('"'), "the select must be one literal").toBe(true);
    expect(sel, "a concatenated select breaks the row types").not.toMatch(/\+|`/);
  });

  it("routes both branches through mustRead", () => {
    const fn = menuFn();
    // {data:null,error} reads exactly like "no services". An empty menu is a
    // screen that says this park can buy nothing.
    expect(fn, "a failed menu read must throw, not render as an empty menu")
      .toMatch(/mustRead\(/);
    const must = fn.indexOf("mustRead(");
    const tail = fn.slice(must);
    expect(tail, "both branches sit inside the same mustRead").toMatch(/isGrounds/);
  });

  it("still filters by kind — components are not menu tiles by default", () => {
    const fn = menuFn();
    // Components and add-ons price inside packages; as menu tiles they are
    // duplicates at the wrong price. 0147 did not relax that — it moved the
    // test from `.eq("kind","standalone")` into an `.or()` that ALSO admits a
    // leg explicitly opened with solo_bookable. The gate is still named and
    // still closed by default; what changed is that there are now two ways
    // through it, both of them deliberate.
    expect(fn, "the menu must still gate on kind").toMatch(/kind\.eq\.standalone/);
    // The failure this guards: admitting every component wholesale, which is
    // what a `.in("kind", [...])` here would do.
    expect(fn, "the menu must never admit components in bulk").not.toMatch(/\.in\("kind"/);
  });

  it("only an explicitly opened leg gets in — the flag is the whole permission", () => {
    const fn = menuFn();
    expect(fn, "solo_bookable is what distinguishes an opened leg from every other component")
      .toMatch(/solo_bookable\.eq\.true/);
  });
});

describe("0143 is on disk, not only in the database", () => {
  const sql = () =>
    readFileSync(
      join(process.cwd(), "supabase/migrations/0143_a_park_can_buy_its_own_dock.sql"),
      "utf8",
    );

  it("adds the column closed by default", () => {
    expect(sql()).toMatch(/park_bookable boolean not null default false/);
  });

  it("opens the pier, which is the service it exists for", () => {
    expect(sql()).toMatch(/Pier install \/ removal/);
  });

  it("gives the grounds its 28 sections", () => {
    // The fence opening alone changes nothing: a per_section service with no
    // section count prices to 0 and drops out anyway.
    expect(sql()).toMatch(/pier_sections/);
    expect(sql()).toMatch(/\b28\b/);
  });

  it("refuses to let one service carry both flags", () => {
    expect(sql(), "park_only and park_bookable are different axes")
      .toMatch(/park_only and park_bookable/);
  });
});
