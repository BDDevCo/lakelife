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
    const orCalls = fn.match(/\.or\([^)]*\)/g) ?? [];
    expect(orCalls.length, "no .or() found — scan is stale").toBeGreaterThan(0);
    for (const call of orCalls) {
      expect(call, "park_bookable may only widen the GROUNDS branch")
        .toMatch(/park_only\.eq\.true/);
    }
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
    const or = fn.match(/\.or\("([^"]*)"\)/)?.[1] ?? "";
    expect(or, "no .or() filter found — scan is stale").not.toBe("");
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

  it("still filters to standalone services", () => {
    const fn = menuFn();
    // Components and add-ons price inside packages; as menu tiles they are
    // duplicates at the wrong price.
    expect(fn).toMatch(/\.eq\("kind",\s*"standalone"\)/);
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
