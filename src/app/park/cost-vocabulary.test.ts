import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COST_CATEGORY_LABEL, SCHEDULABLE_CATEGORIES, canSplit, type CostCategory } from "./cost-helpers";

/**
 * THE FOUR LISTS THAT HAVE TO AGREE ABOUT WHAT A PARK SPENDS MONEY ON.
 *
 * There is a database CHECK, a TypeScript union, a label map, and two separate
 * hardcoded dropdowns. Adding `snow` in 0144 touched all five, and the one
 * that nearly got missed was the dropdown — a category the database accepts
 * and no screen offers is a column with no writer, which is this codebase's
 * most-repeated bug.
 *
 * So the invariant is not "snow exists". It is that the lists still line up,
 * whatever the next category turns out to be.
 */
const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The categories the DATABASE will actually accept, read from the migration. */
function dbCategories(): string[] {
  const sql = repo("supabase/migrations/0144_somebody_has_to_plough_the_road.sql");
  const block = sql.match(
    /alter table public\.park_costs add constraint park_costs_category_check[\s\S]*?\);/,
  )?.[0] ?? "";
  expect(block, "the park_costs category check was not found — this scan is stale")
    .not.toBe("");
  const inList = block.match(/check \(category in \(([\s\S]*?)\)\)/)?.[1] ?? "";
  const found = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  expect(found.length, "no categories parsed out of the CHECK").toBeGreaterThan(5);
  return found;
}

function dbScheduleCategories(): string[] {
  const sql = repo("supabase/migrations/0144_somebody_has_to_plough_the_road.sql");
  const block = sql.match(
    /alter table public\.park_cost_schedules add constraint park_cost_schedules_category_check[\s\S]*?\);/,
  )?.[0] ?? "";
  expect(block, "the schedules category check was not found").not.toBe("");
  const inList = block.match(/check \(category in \(([\s\S]*?)\)\)/)?.[1] ?? "";
  return [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** The categories the COSTS SCREEN offers in its dropdown. */
function screenCategories(): string[] {
  const tsx = repo("src/components/ParkCosts.tsx");
  const list = tsx.match(/const CATEGORIES: CostCategory\[\] = \[([\s\S]*?)\];/)?.[1] ?? "";
  expect(list, "the CATEGORIES dropdown list was not found").not.toBe("");
  return [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("every category the database accepts has a label", () => {
  it("labels all of them", () => {
    for (const c of dbCategories()) {
      expect(
        COST_CATEGORY_LABEL[c as CostCategory],
        `${c} is a legal category with no label — it would print as the raw word`,
      ).toBeTruthy();
    }
  });

  it("labels nothing the database would refuse", () => {
    const db = new Set(dbCategories());
    for (const c of Object.keys(COST_CATEGORY_LABEL)) {
      expect(db.has(c), `${c} has a label but the database would refuse it`).toBe(true);
    }
  });
});

describe("every category a person can pick is one the database accepts", () => {
  it("offers nothing the database would refuse", () => {
    const db = new Set(dbCategories());
    for (const c of screenCategories()) {
      expect(db.has(c), `the costs screen offers ${c}, which the CHECK refuses`).toBe(true);
    }
  });

  it("offers every splittable category except the deliberate omissions", () => {
    // `unit_electric` is deliberately absent (power for a park-owned home is
    // metered to that home). `tax` and `insurance` are real bills but no fee
    // may claim them, so they are entered as schedules, not split costs.
    const OMITTED = new Set(["unit_electric", "tax", "insurance"]);
    const offered = new Set(screenCategories());
    for (const c of dbCategories()) {
      if (OMITTED.has(c)) continue;
      expect(
        offered.has(c),
        `${c} is a legal, splittable category the screen never offers — nobody can file one`,
      ).toBe(true);
    }
  });

  it("still keeps unit_electric out of the dropdown", () => {
    expect(screenCategories()).not.toContain("unit_electric");
    expect(canSplit("unit_electric")).toBe(false);
  });
});

describe("the reminder list agrees with the schedules CHECK", () => {
  it("schedules nothing the database would refuse", () => {
    const db = new Set(dbScheduleCategories());
    for (const c of SCHEDULABLE_CATEGORIES) {
      expect(db.has(c), `${c} is schedulable in code but refused by the CHECK`).toBe(true);
    }
  });

  it("keeps `other` out of schedules", () => {
    // 0117: one active schedule per category, so two unrelated `other` bills
    // would falsely satisfy each other's reminder.
    expect(SCHEDULABLE_CATEGORIES).not.toContain("other");
    expect(dbScheduleCategories()).not.toContain("other");
  });
});

describe("snow, specifically", () => {
  const sql = () => repo("supabase/migrations/0144_somebody_has_to_plough_the_road.sql");

  /**
   * The whole INSERT, bounded by its own closing `);`.
   *
   * A non-greedy match to the first `;` stopped 407 characters in, on a
   * semicolon inside a code comment — and two assertions still passed, because
   * what they needed happened to be above the cut. A regex that can stop early
   * is a test that passes for the wrong reason.
   */
  const snowInsert = () => {
    const m = sql().match(/insert into public\.services[\s\S]*?\n\);/)?.[0] ?? "";
    expect(m.length, "the snow INSERT was not found whole — this scan is stale")
      .toBeGreaterThan(600);
    expect(m, "the match must reach the end of the statement").toMatch(/park_bookable/);
    return m;
  };

  it("is spendable, schedulable, splittable and labelled", () => {
    expect(dbCategories()).toContain("snow");
    expect(dbScheduleCategories()).toContain("snow");
    expect(screenCategories()).toContain("snow");
    expect(SCHEDULABLE_CATEGORIES).toContain("snow");
    expect(COST_CATEGORY_LABEL.snow).toBe("Snow clearing");
    expect(canSplit("snow")).toBe(true);
  });

  it("is NOT water work, which would make it unbookable all winter", () => {
    // Water work is refused outside ice-out → pull-deadline, which is exactly
    // the months it snows. This one line decides whether snow can be booked.
    const insert = snowInsert();
    expect(insert, "the snow insert was not found").not.toBe("");
    expect(insert, "is_water_work must be false and commented as load-bearing")
      .toMatch(/false,\s*--\s*LOAD-BEARING/);
  });

  it("is protective, so the nightly can never quietly cancel it", () => {
    const insert = snowInsert();
    expect(insert).toMatch(/'protective'/);
  });

  it("arrives with no price, so the desk asks rather than inventing one", () => {
    // 0115: every park sets its own. A default here would be a LaGrange County
    // plough rate applied to a park in another state.
    const insert = snowInsert();
    expect(insert).toMatch(/'flat',\s*\n\s*0,/);
  });

  it("is flat, not per-lot — the road does not get longer as the park fills", () => {
    const insert = snowInsert();
    expect(insert).toMatch(/'flat'/);
    expect(insert, "band_pricing must be null; a count field would scale it")
      .toMatch(/null,\s*--\s*flat counts nothing/);
  });
});
