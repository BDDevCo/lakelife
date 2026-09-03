import { describe, it, expect } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";
import { planImport, checkTotals, statedTotalFrom, emptyLotsFrom } from "./import-helpers";
import { allocateCost, type CostLot } from "./cost-helpers";

/**
 * THE HAVEN @ PRETTY LAKE — the real rent roll for the park being bought.
 *
 * Lifted verbatim from the acquisition proforma: 21 numbered lots, four future
 * ones, a pole barn, a trailing unlabelled total, and NOT ONE TENANT NAME.
 * Every earlier fixture in this repo was invented by me; this one is the
 * document, and it found four bugs that eleven hundred invented tests did not.
 *
 * IT IS NOT THE 2024 RENT ROLL. The DD packet's handwritten roll is a
 * different, later document, and the two disagree about the park:
 *
 *   - the real lots are 1, 2, 6, 7, 9, 10, 11, 14-24, 26, 27, 28 — NOT a
 *     contiguous 1-21. Numbers 3, 4, 5, 8, 12, 13 and 25 do not exist.
 *   - the park-owned home is LOT 11 (2019 28x60 Shult, $1,500/mo), not Lot 7.
 *   - Lot 6 is the vacant one.
 *
 * This fixture stays because it is still a real document that exercises the
 * parser hard — a nameless roll, a prose lot label, silent lots, a trailing
 * total. It is a PARSER fixture, not a description of The Haven. Anything
 * asserting what the park actually is belongs against the 2024 roll.
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

// ---------------------------------------------------------------------------
// END TO END: THE REAL ROLL PRODUCES A REAL DENOMINATOR.
//
// Everything built in 0112 hangs on this. "Divide a cost by every rentable lot
// and let the park carry the empties" is inert unless the empties EXIST — and
// until now the importer wrote them down as notes and created nothing, so The
// Haven would have come in as 20 lots with nothing to carry.
// ---------------------------------------------------------------------------
describe("The Haven — the roll becomes a denominator", () => {
  const parsed = parseRentRoll(HAVEN);

  const empties = emptyLotsFrom(
    [...parsed.vacantDeclared, ...parsed.silentLots],
    [],
    parsed.rows.map((r) => r.lot?.value ?? "").filter(Boolean),
  );

  it("separates the gap in the numbering from the pads he has not built", () => {
    expect(empties.filter((e) => e.rentable).map((e) => e.label)).toEqual(["3"]);
    expect(empties.filter((e) => !e.rentable).map((e) => e.label))
      .toEqual(["22", "23", "24", "25"]);
  });

  it("creates all five, so nothing is invisible on the reconcile screen", () => {
    const plan = planImport({
      rows: parsed.rows,
      lots: [],
      liveStays: [],
      cutoverISO: CUTOVER,
      season: null,
      namelessRoll: !parsed.shape.hasNameColumn,
      emptyLots: empties,
    });
    for (const label of ["3", "22", "23", "24", "25"]) {
      expect(plan.lotsToCreate).toContain(label);
    }
  });

  // LOT 7 HAS A ROW AND NO READABLE LABEL. "Lot 7 - Double Wide Owned" is his
  // own home on the roll at "- $", and the parser will not guess a lot number
  // out of a sentence — so it becomes a question rather than a silent lot.
  // That is right, and it is also why the denominator is 20 until he answers
  // it and 21 after. Asserted so nobody later "fixes" the parser into
  // inventing lots out of prose.
  it("asks about the double-wide rather than inventing a lot from prose", () => {
    const billed = parsed.rows.map((r) => r.lot?.value ?? "").filter(Boolean);
    expect(billed).toHaveLength(19);
    expect(billed).not.toContain("LOT7");
    expect(parsed.rows).toHaveLength(20);          // the row exists; the label does not
  });

  // THE NUMBER THE WHOLE CHANGE RESTS ON. 19 labelled + the gap at Lot 3 + the
  // double-wide once he confirms it = 21. The four on the proforma are not
  // lots yet: counting them would divide every resident's water bill by 25 —
  // a 16% cut in each share and roughly $217 a month absorbed for pads that
  // do not exist.
  it("lands on 21 rentable lots, not 25", () => {
    const billed = parsed.rows.map((r) => r.lot?.value ?? "").filter(Boolean);
    const rentable = billed.length + empties.filter((e) => e.rentable).length;
    expect(rentable).toBe(20);                     // before he answers Lot 7
    expect(rentable + 1).toBe(21);                 // after
    expect(empties.filter((e) => !e.rentable)).toHaveLength(4);
  });

  // And the arithmetic that denominator produces, on his own water bill.
  it("gives every household the same share, and the park the empties", () => {
    const billed = parsed.rows.map((r) => r.lot?.value ?? "").filter(Boolean);
    // Lot 7 is his own double-wide — billed on the roll at "- $", so it is a
    // lot he owns rather than a household. 19 households pay.
    const lots: CostLot[] = [
      // The 19 households the roll bills.
      ...billed.map((label, i) => ({
        lotId: `l${label}`, lotNumber: label, reservationId: `r${i}`,
      })),
      // The gap at Lot 3 — a real pad with nobody on it.
      { lotId: "l3", lotNumber: "3", reservationId: null },
      // His own double-wide, once he has answered the importer's question.
      // In the divisor, never a payer.
      { lotId: "lLOT7", lotNumber: "LOT7", reservationId: null, parkOwned: true },
    ];
    const a = allocateCost({ amountPaid: 1140, method: "per_lot", lots });

    expect(a.denominatorLots).toBe(21);
    expect(a.payerLots).toBe(19);
    expect(a.shares[0].amount).toBe(54.28);
    expect(a.shares[0].basis).toBe("1 of 21 rentable lots");
    expect(a.allocated).toBe(1031.32);
    expect(a.parkAbsorbs).toBe(108.68);   // his empty pad + his own double-wide
  });
});
