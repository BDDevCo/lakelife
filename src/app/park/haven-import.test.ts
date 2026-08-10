import { describe, it, expect } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";
import { planImport, checkTotals, statedTotalFrom } from "./import-helpers";

/**
 * THE HAVEN @ PRETTY LAKE — the real rent roll for the park being bought.
 *
 * Lifted verbatim from the acquisition proforma: 21 numbered lots, four future
 * ones, a pole barn, a trailing unlabelled total, and NOT ONE TENANT NAME.
 * Every earlier fixture in this repo was invented by me; this one is the
 * document, and it found four bugs that eleven hundred invented tests did not.
 */
const HAVEN = [
  "Current Monthly",
  "Lot 1\t325.00 $", "Lot 2\t250.00 $", "Lot 3", "Lot 4\t275.00 $",
  "Lot 5\t275.00 $", "Lot 6\t275.00 $", "Lot 7 - Double Wide Owned\t- $",
  "Lot 8\t275.00 $", "Lot 9\t275.00 $", "Lot 10\t250.00 $", "Lot 11\t275.00 $",
  "Lot 12\t300.00 $", "Lot 13\t275.00 $", "Lot 14\t300.00 $", "Lot 15\t300.00 $",
  "Lot 16\t250.00 $", "Lot 17\t250.00 $", "Lot 18\t250.00 $", "Lot 19\t250.00 $",
  "Lot 20\t300.00 $", "Lot 21\t250.00 $",
  "Lot 22", "Lot 23", "Lot 24", "Lot 25",
  "24x24 Pole Barn / Boat Storage",
  "\t5,200.00 $",
].join("\n");

const CUTOVER = "2026-12-15";   // closing, per the purchase agreement

describe("The Haven — the real roll", () => {
  const parsed = parseRentRoll(HAVEN);

  it("accounts for every line", () => {
    expect(parsed.accounting.unaccounted).toEqual([]);
    expect(parsed.accounting.duplicated).toEqual([]);
  });

  it("finds the five lots his roll says nothing about — the walk list", () => {
    // "Lot 3" style, with the word in front. The first parser matched a bare
    // "3" only, so this list came back EMPTY on the one roll that matters.
    expect(parsed.silentLots.map((s) => s.text)).toEqual([
      "Lot 3", "Lot 22", "Lot 23", "Lot 24", "Lot 25",
    ]);
  });

  it("recognises the trailing unlabelled total", () => {
    expect(parsed.totals.map((t) => t.text)).toEqual(["5,200.00 $"]);
    expect(statedTotalFrom(parsed.totals.map((t) => t.text))).toBe(5200);
  });

  it("infers the columns with no header row", () => {
    expect(parsed.shape.headerLine).toBeNull();
    expect(parsed.columns.index.lot).toBe(0);
    expect(parsed.columns.index.rent).toBe(1);
    expect(parsed.blockQuestions.map((b) => b.code)).toContain("COLUMNS_INFERRED");
  });

  it("knows the sheet names nobody", () => {
    expect(parsed.shape.hasNameColumn).toBe(false);
  });

  it("keeps the pole barn out of the tenant list", () => {
    expect(parsed.facilities.map((f) => f.text)).toEqual(["24x24 Pole Barn / Boat Storage"]);
  });

  it("imports it as INVENTORY — lots and rents, and nobody invented", () => {
    const plan = planImport({
      rows: parsed.rows,
      lots: [],
      liveStays: [],
      cutoverISO: CUTOVER,
      season: null,
      namelessRoll: !parsed.shape.hasNameColumn,
      approvedNewLots: parsed.rows
        .map((r) => r.lot.value ?? r.lot.raw)
        .filter(Boolean) as string[],
    });

    expect(plan.namelessRoll).toBe(true);
    // No tenancies, and no wall of 20 unanswerable "who lives here?" questions.
    expect(plan.ready).toHaveLength(0);
    expect(plan.needsYou).toHaveLength(0);

    // 19 paying lots + lot 7 (the park-owned double-wide, "- $").
    expect(plan.rates.length).toBeGreaterThanOrEqual(19);

    // THE NUMBER THAT PROVES IT: the roll's own arithmetic.
    expect(plan.monthlyTotal).toBe(5200);
    expect(plan.monthlyTotal * 12).toBe(62400);   // ties to the credit memo
  });

  it("ties to the seller's own stated total", () => {
    const plan = planImport({
      rows: parsed.rows, lots: [], liveStays: [],
      cutoverISO: CUTOVER, season: null,
      namelessRoll: true,
    });
    const t = checkTotals(5200, plan.rows.filter((r) => !r.skipped));
    expect(t!.ties).toBe(true);
  });
});
