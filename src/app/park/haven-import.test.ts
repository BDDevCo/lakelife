import { describe, it, expect } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";
import {
  planImport, checkTotals, statedTotalFrom, emptyLotsFrom, cadenceTotals, sheetCadence,
  importBlockerText,
} from "./import-helpers";
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

// ---------------------------------------------------------------------------
// MIKE'S ROSTER — THE ANNUAL COLUMN.
//
// The seller's typed roster carries a YEARLY figure per lot: $4,500, $3,900,
// $3,600, $67,500 across the eighteen leased lots. Saved as a CSV under its
// own header, "Annual Rent", the parser mapped the column to rent with no
// cadence, planImport defaulted the cadence to monthly, and the review screen
// read "$67,500 a month, across 18 rows" with "His total ties to the penny"
// in green — 18 ready, nothing asked. One tap filed eighteen tenancies at
// $3,600–$4,500 a month, and "Bill January 2027" would have raised $67,500.
//
// The rule the parser is built on: NEVER INVENT A VALUE. Dividing by twelve
// is inventing one — his roster does not say the year was twelve equal
// months. So a yearly or quarterly figure is a question, exactly like a rent
// we read and could not convert, and the row stays held until he types the
// MONTHLY rent himself.
//
// The lots here are the eighteen The Haven actually leases (memory: the roll
// from Mike); the names are fixtures. 11 × 3,600 + 6 × 3,900 + 4,500 = 67,500.
// ---------------------------------------------------------------------------
const HAVEN_LEASED = [
  "1", "7", "9", "10", "14", "15", "16", "17", "18", "19", "20", "21",
  "22", "23", "24", "26", "27", "28",
];
const HAVEN_ALL = ["1", "2", "6", "7", "9", "10", "11", "14", "15", "16", "17",
  "18", "19", "20", "21", "22", "23", "24", "26", "27", "28"];
const ANNUAL = [4500, ...Array(6).fill(3900), ...Array(11).fill(3600)] as number[];

function mikesRoster(rentHeader: string, extraCol?: { header: string; cell: string }) {
  const head = ["Name", "Lot #", "Mailing Address", "Payment Method", rentHeader];
  if (extraCol) head.push(extraCol.header);
  const lines = [head.join(",")];
  HAVEN_LEASED.forEach((lot, i) => {
    const cells = [
      `"Fixture, Household ${i + 1}"`, lot, `"${lot} Haven Dr, Wolcottville IN"`,
      i % 3 === 0 ? "Check" : "Cash", `"$${ANNUAL[i].toLocaleString("en-US")}.00"`,
    ];
    if (extraCol) cells.push(extraCol.cell);
    lines.push(cells.join(","));
  });
  lines.push(`Total,,,,"$67,500.00"${extraCol ? "," : ""}`);
  return lines.join("\n");
}

const HAVEN_LOTS = HAVEN_ALL.map((n) => ({ id: `lot-${n}`, lotNumber: n, monthlyRate: 400 }));

/** The same lots with no rate card yet — nothing to measure a figure on. */
const HAVEN_LOTS_UNCARDED = HAVEN_ALL.map((n) => ({ id: `lot-${n}`, lotNumber: n, monthlyRate: null }));

function planMikes(
  blob: string,
  overrides?: Record<number, { rent?: number | null }>,
  lots: { id: string; lotNumber: string; monthlyRate?: number | null }[] = HAVEN_LOTS,
  season: { start: string; end: string } | null = null,
) {
  const parsed = parseRentRoll(blob, { knownLots: HAVEN_ALL });
  const plan = planImport({
    rows: parsed.rows,
    lots,
    liveStays: [],
    cutoverISO: "2027-01-01",
    season,
    namelessRoll: !parsed.shape.hasNameColumn,
    overrides,
  });
  return { parsed, plan };
}

describe("Mike's roster — the annual column is a question, never a monthly rent", () => {
  it("the fixture adds up the way his sheet does", () => {
    expect(ANNUAL).toHaveLength(18);
    expect(ANNUAL.reduce((a, b) => a + b, 0)).toBe(67500);
  });

  it("reads all eighteen households and the rent column", () => {
    const { parsed } = planMikes(mikesRoster("Annual Rent"));
    expect(parsed.accounting.unaccounted).toEqual([]);
    expect(parsed.rows).toHaveLength(18);
    expect(parsed.columns.index.rent).toBe(4);
    expect(parsed.rows.every((r) => r.rent.value != null)).toBe(true);
  });

  it("holds every row on the cadence — 18 blocked, 0 ready, nothing written", () => {
    const { plan } = planMikes(mikesRoster("Annual Rent"));
    expect(plan.ready).toHaveLength(0);
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term"))).toBe(true);
    // Nothing monthly to expect, so the receipt's "expected each month" is $0,
    // not $67,500.
    expect(plan.monthlyTotal).toBe(0);
    expect(plan.rates).toEqual([]);
  });

  it("never divides by twelve", () => {
    const { plan } = planMikes(mikesRoster("Annual Rent"));
    for (const r of plan.rows) {
      expect(r.amount).not.toBe(375);
      expect(r.amount).not.toBe(325);
      expect(r.amount).not.toBe(300);
    }
  });

  it("does not print '$67,500 a month' — the cadence card carries no monthly figure", () => {
    const { plan } = planMikes(mikesRoster("Annual Rent"));
    const live = plan.rows.filter((r) => !r.skipped);
    const c = cadenceTotals(live);
    expect(c.byTerm.find((t) => t.term === "monthly")).toBeUndefined();
    expect(c.byTerm.reduce((s, t) => s + t.total, 0)).toBe(0);
    expect(c.heldForMonthly).toBe(18);
  });

  it("does not show 'ties to the penny' in green for a yearly total", () => {
    const { parsed, plan } = planMikes(mikesRoster("Annual Rent"));
    const stated = statedTotalFrom(parsed.totals.map((t) => t.text), parsed.shape.delimiter);
    expect(stated).toBe(67500);
    const live = plan.rows.filter((r) => !r.skipped);
    // The check is refused outright: a yearly total against rows that are
    // waiting for a monthly figure is not arithmetic anyone should see ticked.
    expect(checkTotals(stated, live)).toBeNull();
    expect(sheetCadence(live)).toBe("annual");
  });

  it("says so once at the top, as a block question", () => {
    const { parsed } = planMikes(mikesRoster("Annual Rent"));
    const q = parsed.blockQuestions.find((b) => b.code === "RENT_NOT_MONTHLY");
    expect(q).toBeDefined();
    expect(q!.question).toMatch(/yearly/i);
    expect(q!.question).toMatch(/Annual Rent/);
    expect(q!.question).not.toMatch(/try again/i);
  });

  it("the monthly rent he types unblocks the row as a MONTHLY tenancy", () => {
    const blob = mikesRoster("Annual Rent");
    const { plan } = planMikes(blob, { 2: { rent: 375 } });
    const first = plan.rows.find((r) => r.lineNo === 2)!;
    expect(first.blockers).toEqual([]);
    expect(first.term).toBe("monthly");
    expect(first.amount).toBe(375);
    expect(plan.ready).toHaveLength(1);
    expect(plan.needsYou).toHaveLength(17);
    expect(plan.monthlyTotal).toBe(375);
  });

  it("'Yearly Rent' is read as the rent column and held — not carried off to notes", () => {
    // "year" sat in the CARRY list for vehicle years, so this header was
    // swallowed whole: no rent column, every row imported with no rent at all.
    const { parsed, plan } = planMikes(mikesRoster("Yearly Rent"));
    expect(parsed.columns.index.rent).toBe(4);
    expect(parsed.blockQuestions.map((b) => b.code)).not.toContain("NO_RENT_COLUMN");
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.ready).toHaveLength(0);
  });

  it.each(["Rent/Yr", "Rent (Annual)", "Annual Lot Rent", "Yr Rent", "Rent per year"])(
    "%s is held the same way", (header) => {
      const { plan } = planMikes(mikesRoster(header));
      expect(plan.ready).toHaveLength(0);
      expect(plan.needsYou.every((r) => r.blockers.includes("bad_term"))).toBe(true);
    });

  it("a 'Billing = Quarterly' cell holds the row too — and says so once at the top", () => {
    const { parsed, plan } = planMikes(mikesRoster("Rent", { header: "Billing", cell: "Quarterly" }));
    expect(parsed.columns.index.term).toBe(5);
    expect(plan.ready).toHaveLength(0);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term"))).toBe(true);
    expect(checkTotals(67500, plan.rows)).toBeNull();
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["TERM_NOT_MONTHLY"]);
    expect(parsed.blockQuestions[0].question).toMatch(/18 rows/);
  });

  it("a bare 'Rent' header carrying yearly figures is caught by the rate cards", () => {
    // No header rule can help here — the only tell is that every figure is
    // nine to eleven times what the lots are carded at.
    const { plan } = planMikes(mikesRoster("Rent"));
    expect(plan.ready).toHaveLength(0);
    expect(plan.needsYou.every((r) => r.blockers.includes("looks_yearly"))).toBe(true);
    expect(plan.needsYou[0].rateHint).toEqual({ amount: 400, basis: "lot" });
    // The row itself is the detail the sentence needs — callers pass the row.
    const sentence = importBlockerText("looks_yearly", "1", plan.needsYou[0]);
    expect(sentence).toMatch(/yearly figure/);
    expect(sentence).toMatch(/\$400 a month/);
    expect(sentence).not.toMatch(/try again/i);
  });

  it("the rate-card check is only a question — the figure he types is his answer", () => {
    const { plan } = planMikes(mikesRoster("Rent"), { 2: { rent: 4500 } });
    const first = plan.rows.find((r) => r.lineNo === 2)!;
    expect(first.blockers).toEqual([]);
    expect(first.amount).toBe(4500);
  });

  // A "PAID" COLUMN MUST NOT HOLD HIS ROSTER. Mike's real header text is not
  // pinned anywhere; a Paid Y/N column beside the rent is the ordinary shape,
  // and it turned eighteen rows into eighteen wrong questions with an empty
  // box each and no sentence at the top saying why.
  it("Monthly Rent + Paid=Y imports — eighteen rows, nothing asked", () => {
    const { parsed, plan } = planMikes(mikesRoster("Monthly Rent", { header: "Paid", cell: "Y" }), undefined, HAVEN_LOTS_UNCARDED);
    expect(parsed.columns.index.term).toBeUndefined();
    expect(parsed.blockQuestions).toEqual([]);
    expect(plan.needsYou).toEqual([]);
    expect(plan.ready).toHaveLength(18);
    expect(plan.monthlyTotal).toBe(67500);
    expect(plan.ready[0].notes).toContain("Paid: Y");
  });

  it("Annual Rent + Paid=Y is held as annual, with ONE sentence about the column", () => {
    const { parsed, plan } = planMikes(mikesRoster("Annual Rent", { header: "Paid", cell: "Y" }));
    expect(plan.ready).toEqual([]);
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "annual")).toBe(true);
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
    expect(sheetCadence(plan.rows)).toBe("annual");
    expect(importBlockerText("bad_term", "1", plan.needsYou[0])).toMatch(/yearly figure/);
  });

  it("a Term column reading 'Monthly' under 'Annual Rent' is held too — even on a park with no rate cards", () => {
    // The top of the screen promises that nothing from a yearly column goes
    // in; a cell saying "Monthly" used to beat that header and plan the row
    // monthly at the yearly figure, READY on a park with no cards.
    const { parsed, plan } = planMikes(mikesRoster("Annual Rent", { header: "Term", cell: "Monthly" }), undefined, HAVEN_LOTS_UNCARDED);
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
    expect(plan.ready).toEqual([]);
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "conflicting")).toBe(true);
    expect(plan.monthlyTotal).toBe(0);
  });

  it("a Term column reading 'Seasonal' under 'Annual Rent' is held the same way — even with a season set", () => {
    // "seasonal" is the one term word the short-or-long guard did not sort,
    // so the cell was STATED seasonal and, on a park with a season, every
    // row planned READY as a seasonal tenancy at the YEARLY figure — under
    // the card promising nothing from that column goes in.
    const season = { start: "2027-05-01", end: "2027-10-31" };
    const { parsed, plan } = planMikes(
      mikesRoster("Annual Rent", { header: "Term", cell: "Seasonal" }), undefined, HAVEN_LOTS_UNCARDED, season,
    );
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
    expect(plan.ready).toEqual([]);
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "conflicting")).toBe(true);
    expect(plan.needsYou.every((r) => r.term === "monthly")).toBe(true);
    expect(plan.monthlyTotal).toBe(0);
    expect(sheetCadence(plan.rows)).toBe("conflicting");
    expect(importBlockerText("bad_term", "1", plan.needsYou[0])).toMatch(/two answers/);
  });

  it("'Rent Each Quarter' is a quarterly column on every row, and says so once", () => {
    // The parser knew the header was quarterly; the plan used to re-read the
    // label as a cell and call all eighteen rows unreadable.
    const { parsed, plan } = planMikes(mikesRoster("Rent Each Quarter"));
    expect(parsed.columns.index.rent).toBe(4);
    expect(parsed.rows.every((r) => r.headerCadence === "quarterly")).toBe(true);
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
    expect(parsed.blockQuestions[0].question).toMatch(/quarterly figure \("Rent Each Quarter"\)/);
    expect(plan.needsYou).toHaveLength(18);
    expect(plan.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "quarterly")).toBe(true);
    expect(importBlockerText("bad_term", "1", plan.needsYou[0])).toMatch(/quarterly figure/);
    expect(sheetCadence(plan.rows)).toBe("quarterly");
  });
});
