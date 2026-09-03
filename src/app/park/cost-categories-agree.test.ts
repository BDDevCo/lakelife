import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCHEDULABLE_CATEGORIES,
  COST_CATEGORY_LABEL,
  canSplit,
  type CostCategory,
} from "./cost-helpers";

/**
 * A REMINDER YOU CANNOT ANSWER.
 *
 * /park/today can raise "Property tax for 2027 is due about now", link to
 * /park/costs, and refuse to be dismissed. The form on that page offered
 * seven categories and `tax` was not one of them — so the task could never be
 * cleared by any action the product offers, and would have sat on his morning
 * screen from 1 January onward teaching him the Needs-you list contains
 * chores that do not go away.
 *
 * It was not a rule. `recordCost` accepts `tax`, and the park_costs CHECK
 * allows it. One list gained two entries in 0123 and the other did not.
 *
 * The bitter part: cost-helpers already spells out this exact hazard, for a
 * different category — `unit_electric` is excluded from SCHEDULABLE_CATEGORIES
 * because "the reminder would send him to a screen where it is not in the
 * dropdown and the action would decline it." The reasoning was written down
 * and then not applied to the two categories added beside it.
 *
 * So the rule gets a test rather than a comment: anything you can set a
 * reminder FOR, you must be able to ENTER.
 */

const FORM = fileURLToPath(new URL("../../components/ParkCosts.tsx", import.meta.url));

/** The categories the "Enter a bill" dropdown actually offers. */
function formCategories(): string[] {
  const src = readFileSync(FORM, "utf8");
  const block = src.match(/const CATEGORIES: CostCategory\[\] = \[([\s\S]*?)\];/)?.[1];
  if (!block) throw new Error("CATEGORIES not found in ParkCosts.tsx — this scan is measuring nothing");
  // Comments inside the array would otherwise be read as entries.
  return [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("the scan finds a real list", () => {
  it("reads the dropdown's categories", () => {
    const found = formCategories();
    expect(found.length).toBeGreaterThan(5);
    expect(found).toContain("sewer");
  });

  it("does not count a commented-out entry", () => {
    // The list carries prose explaining why tax and insurance belong in it.
    expect(formCategories()).not.toContain("unit_electric");
  });
});

describe("anything you can be reminded of, you can enter", () => {
  it("every schedulable category is in the form's dropdown", () => {
    const form = new Set(formCategories());
    const missing = SCHEDULABLE_CATEGORIES.filter((c) => !form.has(c));
    expect(missing, "a reminder for these can be raised and never cleared").toEqual([]);
  });

  it("and has words a person can read", () => {
    for (const c of SCHEDULABLE_CATEGORIES) {
      expect(COST_CATEGORY_LABEL[c], `${c} would render as its own column name`).toBeTruthy();
    }
  });

  it("and is one recordCost would actually accept", () => {
    // `canSplit` is the rule recordCost enforces. A schedulable category it
    // refuses is the unit_electric hazard by another door.
    for (const c of SCHEDULABLE_CATEGORIES) {
      expect(canSplit(c), `${c} can be scheduled but not recorded`).toBe(true);
    }
  });
});

describe("the exclusions are deliberate, not drift", () => {
  it("unit_electric stays out of both lists", () => {
    // Power for a home the park owns is metered to that home. It is excluded
    // by a RULE (canSplit), which is why it may be absent from the dropdown.
    expect(SCHEDULABLE_CATEGORIES).not.toContain("unit_electric" as CostCategory);
    expect(canSplit("unit_electric")).toBe(false);
  });

  it("'other' can be entered but not scheduled", () => {
    // The one-active-row-per-category index cannot tell two 'other' bills
    // apart, so each would falsely satisfy the other's reminder. The
    // asymmetry runs this way round only — enterable without being
    // schedulable is safe; the reverse is the bug.
    expect(formCategories()).toContain("other");
    expect(SCHEDULABLE_CATEGORIES).not.toContain("other" as CostCategory);
  });
});
