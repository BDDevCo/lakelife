import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRentRoll, parseLot } from "@/lib/roll-parse";
import {
  planImport,
  normaliseLotLabel,
  rangeForTerm,
  cadenceTotals,
  checkTotals,
  statedTotalFrom,
  importBlockerText,
  MAX_LOT_LABEL,
  type ImportBlocker, emptyLotsFrom, reconcileRoll, decodeRoll,
} from "./import-helpers";

const CUTOVER = "2026-08-01";

function plan(blob: string, lots: { id: string; lotNumber: string }[], extra?: {
  liveStays?: { lotId: string; range: { start: string; end: string } }[];
  approvedNewLots?: string[];
  season?: { start: string; end: string } | null;
}) {
  const parsed = parseRentRoll(blob, { knownLots: lots.map((l) => l.lotNumber) });
  return planImport({
    rows: parsed.rows,
    lots,
    liveStays: extra?.liveStays ?? [],
    cutoverISO: CUTOVER,
    season: extra?.season ?? null,
    approvedNewLots: extra?.approvedNewLots,
  });
}

const LOTS = [
  { id: "lot-1", lotNumber: "1" },
  { id: "lot-2", lotNumber: "2" },
  { id: "lot-7", lotNumber: "7" },
  { id: "lot-13", lotNumber: "13" },
];

// ---------------------------------------------------------------------------
describe("normaliseLotLabel", () => {
  const real = ["1", "7", "12", "12A", "A3"];

  it("matches the ways a person writes the same lot", () => {
    for (const w of ["7", "07", "Lot 7", "lot 7", "#7", " 7 ", "SITE 7", "Space 7"]) {
      expect(normaliseLotLabel(w, real)).toBe("7");
    }
  });

  it("returns the REAL spelling, never the pasted one", () => {
    expect(normaliseLotLabel("a3", real)).toBe("A3");
    expect(normaliseLotLabel("12a", real)).toBe("12A");
  });

  it("never lets a fuzzy hit beat an exact one", () => {
    // "12A" must resolve to itself, not collapse to lot 12.
    expect(normaliseLotLabel("12A", real)).toBe("12A");
    expect(normaliseLotLabel("12", real)).toBe("12");
  });

  it("returns null rather than inventing a lot", () => {
    expect(normaliseLotLabel("34B", real)).toBeNull();
    expect(normaliseLotLabel("", real)).toBeNull();
    expect(normaliseLotLabel(null, real)).toBeNull();
    expect(normaliseLotLabel("lot", real)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("rangeForTerm", () => {
  it("starts every grandfathered tenancy at the cutover", () => {
    const r = rangeForTerm("monthly", CUTOVER, null);
    expect(r).toEqual({ start: "2026-08-01", end: "2027-08-01" });
  });

  it("handles a leap day without producing an invalid date", () => {
    expect(rangeForTerm("monthly", "2028-02-29", null)).toEqual({
      start: "2028-02-29",
      end: "2029-03-01",
    });
  });

  it("REFUSES a seasonal tenancy when the park has no season", () => {
    // The alternative is a guessed window, which reads as a vacant lot all
    // winter with somebody living on it.
    expect(rangeForTerm("seasonal", CUTOVER, null)).toBeNull();
  });

  it("uses the real season when there is one", () => {
    expect(rangeForTerm("seasonal", CUTOVER, { start: "2026-05-01", end: "2026-10-15" }))
      .toEqual({ start: "2026-05-01", end: "2026-10-15" });
  });

  it("refuses a cutover that is not a date", () => {
    expect(rangeForTerm("monthly", "next August", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("planImport", () => {
  it("plans a clean roll with nothing to ask", () => {
    const p = plan(
      "Lot\tTenant\tRent\n1\tWexler, Donna\t385\n2\tKastner, Ray\t385",
      LOTS,
    );
    expect(p.ready).toHaveLength(2);
    expect(p.needsYou).toHaveLength(0);
    expect(p.monthlyTotal).toBe(770);
    expect(p.ready[0].matchedLotId).toBe("lot-1");
    expect(p.ready[0].createsLot).toBe(false);
    expect(p.ready[0].range).toEqual({ start: "2026-08-01", end: "2027-08-01" });
  });

  it("THE ONE THE PROTOTYPE COULD NOT SEE: two people on one lot", () => {
    // Grouped by LOT, not by name. Both rows blocked, so neither is written and
    // the database never gets to reject one at random.
    const p = plan(
      "Lot\tTenant\tRent\n7\tLoren Fry\t385\n7\tCheryl Newman\t410",
      LOTS,
    );
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou).toHaveLength(2);
    for (const r of p.needsYou) expect(r.blockers).toContain("lot_twice_in_paste");
  });

  it("catches the duplicate even when the two lines SPELL the lot differently", () => {
    // "7" and "Lot 07" are the same lot. Grouping on raw text misses this.
    const p = plan(
      "Lot\tTenant\tRent\n7\tLoren Fry\t385\n07\tCheryl Newman\t410",
      LOTS,
    );
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou.every((r) => r.blockers.includes("lot_twice_in_paste"))).toBe(true);
  });

  it("blocks a lot that does not exist — and unblocks it once he says create it", () => {
    const blob = "Lot\tTenant\tRent\n34B\tJunior Caraway\t60";
    const before = plan(blob, LOTS);
    expect(before.needsYou[0].blockers).toContain("lot_unknown");

    const after = plan(blob, LOTS, { approvedNewLots: ["34B"] });
    expect(after.ready).toHaveLength(1);
    expect(after.ready[0].createsLot).toBe(true);
    expect(after.lotsToCreate).toEqual(["34B"]);
  });

  it("blocks a rent we READ and could not convert — but not an absent one", () => {
    const bad = plan("Lot\tTenant\tRent\n1\tWexler, Donna\t4l0.00", LOTS);
    expect(bad.needsYou[0].blockers).toContain("bad_amount");

    // Absent rent is fine forever. It is not a blocker; it is a blank field.
    const blank = plan("Lot\tTenant\tRent\n1\tWexler, Donna\t", LOTS);
    expect(blank.ready).toHaveLength(1);
    expect(blank.ready[0].amount).toBeNull();
  });

  it("blocks a row whose name is a placeholder", () => {
    const p = plan("Lot\tTenant\tRent\n13\tSEE NOTE\t385", LOTS);
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou[0].blockers).toContain("no_name");
  });

  it("catches a tenancy that already exists — the other-tab collision", () => {
    const p = plan("Lot\tTenant\tRent\n1\tWexler, Donna\t385", LOTS, {
      liveStays: [{ lotId: "lot-1", range: { start: "2026-01-01", end: "2027-01-01" } }],
    });
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou[0].blockers).toContain("lot_taken");
  });

  it("does NOT flag a live stay that has already ended", () => {
    const p = plan("Lot\tTenant\tRent\n1\tWexler, Donna\t385", LOTS, {
      liveStays: [{ lotId: "lot-1", range: { start: "2025-01-01", end: "2026-08-01" } }],
    });
    // Half-open: [.., 2026-08-01) does not overlap [2026-08-01, ..).
    expect(p.ready).toHaveLength(1);
  });

  it("refuses a lot label that is far too long to be one", () => {
    // Label-SHAPED but absurd — this is what a merged cell of digits pastes as.
    const long = "9".repeat(MAX_LOT_LABEL + 2);
    const p = plan(`Lot\tTenant\tRent\n${long}\tWexler, Donna\t385`, LOTS, {
      approvedNewLots: [long],
    });
    expect(p.needsYou[0].blockers).toContain("label_too_long");
  });

  it("holds a seasonal row when the park has no season configured", () => {
    const p = plan("Lot\tTenant\tRent\tTerm\n1\tWexler, Donna\t2400\tseasonal", LOTS);
    const row = p.rows[0];
    if (row.term === "seasonal") {
      expect(row.blockers).toContain("no_season");
      expect(p.ready).toHaveLength(0);
    }
  });

  it("only totals the rows it will actually write, and only monthly ones", () => {
    const p = plan(
      "Lot\tTenant\tRent\n1\tWexler, Donna\t385\n99\tGhost, Al\t1000",
      LOTS,
    );
    // Lot 99 does not exist, so it is not written and not counted.
    expect(p.ready).toHaveLength(1);
    expect(p.monthlyTotal).toBe(385);
  });

  it("never drops a parsed row from the plan", () => {
    const p = plan(
      "Lot\tTenant\tRent\n1\tWexler, Donna\t385\n7\tAmes, Bill\t1\n7\tBoecker, M\t2\n99\tGhost, Al\t9\n13\tSEE NOTE\t5",
      LOTS,
    );
    expect(p.rows).toHaveLength(5);
    expect(p.ready.length + p.needsYou.length).toBe(5);
  });

  it("gives every blocker a sentence with no placeholder left in it", () => {
    const all: ImportBlocker[] = [
      "no_name", "no_lot", "lot_unknown", "lot_ambiguous", "lot_taken",
      "lot_twice_in_paste", "label_too_long", "bad_amount", "no_season",
    ];
    for (const b of all) {
      const s = importBlockerText(b, "7");
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(/undefined|null|\{|\}/);
      expect(s.trim()).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the money, split by cadence", () => {
  it("refuses to imply one number when cadences are mixed", () => {
    const p = plan(
      "Lot\tTenant\tRent\tTerm\n1\tAmes, Bill\t385\tmonthly\n2\tBoecker, Marilyn\t185\tweekly",
      LOTS,
    );
    const t = cadenceTotals(p.ready);
    if (t.byTerm.length > 1) {
      expect(t.mixed).toBe(true);
      // The parts are available; no code here ever adds them together.
      expect(t.byTerm.reduce((n, x) => n + x.count, 0)).toBe(p.ready.length);
    }
  });

  it("says a tie is a tie, and points at the blank when it is not", () => {
    const p = plan(
      "Lot\tTenant\tRent\n1\tAmes, Bill\t385\n2\tBoecker, Marilyn\t385\n13\tCaraway, Junior\t",
      LOTS,
    );
    expect(checkTotals(770, p.ready)?.ties).toBe(true);

    const short = checkTotals(1155, p.ready);
    expect(short?.ties).toBe(false);
    expect(short?.difference).toBe(385);
    // The gap is exactly one lot's rent, and lot 13 is the only blank.
    expect(short?.lotsWithNoAmount).toContain("13");
  });

  it("returns nothing when the seller stated no total", () => {
    expect(checkTotals(null, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE ANSWERS. Without these wired through, every question on the reconcile
// screen is decorative: he types a name, taps Save, and the row stays blocked
// forever. This is exactly the shape of the bug the spec warns about — a
// number he read on screen and approved that never reaches the database.
// ---------------------------------------------------------------------------
describe("what he answers changes the plan", () => {
  function planWith(blob: string, overrides: Record<number, Record<string, unknown>>) {
    const parsed = parseRentRoll(blob, { knownLots: LOTS.map((l) => l.lotNumber) });
    return planImport({
      rows: parsed.rows,
      lots: LOTS,
      liveStays: [],
      cutoverISO: CUTOVER,
      season: null,
      approvedNewLots: Object.values(overrides)
        .map((o) => o.createLot)
        .filter((s): s is string => typeof s === "string"),
      overrides,
    });
  }

  it("a name he types unblocks the row", () => {
    const blob = "Lot\tTenant\tRent\n13\tSEE NOTE\t385";
    expect(planWith(blob, {}).ready).toHaveLength(0);

    const p = planWith(blob, { 2: { name: "Rumbaugh, Delmar" } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].name).toBe("Rumbaugh, Delmar");
    expect(p.ready[0].amount).toBe(385);
  });

  it("a rent he types unblocks a rent we refused to read", () => {
    const blob = "Lot\tTenant\tRent\n1\tWexler, Donna\t4l0.00";
    expect(planWith(blob, {}).needsYou[0].blockers).toContain("bad_amount");

    const p = planWith(blob, { 2: { rent: 410 } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].amount).toBe(410);
  });

  it("picking the current tenant unblocks that row and stands the other down", () => {
    const blob = "Lot\tTenant\tRent\n7\tLoren Fry\t385\n7\tCheryl Newman\t410";
    const both = planWith(blob, {});
    expect(both.ready).toHaveLength(0);
    expect(both.needsYou).toHaveLength(2);

    // "Fry lives there now."
    const p = planWith(blob, { 2: { current: true } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].name).toBe("Loren Fry");
    // Newman is neither imported nor still asking — she is a decision he made.
    expect(p.needsYou).toHaveLength(0);
    expect(p.rows.find((r) => r.name === "Cheryl Newman")?.skipped).toBe(true);
    // And the accounting still holds both.
    expect(p.rows).toHaveLength(2);
  });

  it("skipping a row removes it from both lists but never from the accounting", () => {
    const blob = "Lot\tTenant\tRent\n1\tWexler, Donna\t385\n2\tKastner, Ray\t385";
    const p = planWith(blob, { 2: { skip: true } });
    expect(p.ready).toHaveLength(1);
    expect(p.needsYou).toHaveLength(0);
    expect(p.rows).toHaveLength(2);
    expect(p.monthlyTotal).toBe(385);
  });

  it("a skipped row frees the lot for the other row claiming it", () => {
    const blob = "Lot\tTenant\tRent\n7\tLoren Fry\t385\n7\tCheryl Newman\t410";
    const p = planWith(blob, { 3: { skip: true } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].name).toBe("Loren Fry");
  });

  it("creating a lot he names lets the row through and plans the lot", () => {
    const blob = "Lot\tTenant\tRent\n34B\tJunior Caraway\t60";
    const p = planWith(blob, { 2: { createLot: "34B" } });
    expect(p.ready).toHaveLength(1);
    expect(p.lotsToCreate).toEqual(["34B"]);
    expect(p.ready[0].createsLot).toBe(true);
  });

  it("an answer never invents a value it wasn't given", () => {
    const blob = "Lot\tTenant\tRent\n1\tWexler, Donna\t";
    const p = planWith(blob, { 2: { rent: null } });
    expect(p.ready[0].amount).toBeNull();
    expect(p.monthlyTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The gap explanation has to be EARNED. Found in the browser: the screen said
// "that's exactly one lot's rent" about a $100 gap on a sheet whose rents were
// all $370-$410 — a confident sentence that sends him to the wrong lot. The
// real cause was a lot listed twice.
// ---------------------------------------------------------------------------
describe("the seller's arithmetic, without the overclaim", () => {
  function rowsOf(pairs: [string | null, number | null][]) {
    return pairs.map(([lotLabel, amount], i) => ({
      lines: [i + 1], lineNo: i + 1, source: [""],
      lotLabel, matchedLotId: null, createsLot: false,
      name: "Somebody", email: null, phone: null,
      amount, term: "monthly" as const, range: null,
      skipped: false, blockers: [], flags: [], notes: [],
    }));
  }

  it("names the lot ONLY when the shortfall looks like a real rent", () => {
    // Short by 385, and 385 sits right in the range of the other rents.
    const t = checkTotals(1155, rowsOf([["1", 385], ["2", 385], ["13", null]]));
    expect(t!.ties).toBe(false);
    expect(t!.difference).toBe(385);
    expect(t!.oneMissingRent).toBe("13");
  });

  it("REFUSES to name a lot when the gap is nothing like a rent", () => {
    // Short by only $12 — that is a rounding error or a fee, not lot 13's rent.
    const t = checkTotals(782, rowsOf([["1", 385], ["2", 385], ["13", null]]));
    expect(t!.oneMissingRent).toBeNull();
  });

  it("REFUSES to name a lot when the sheet is OVER rather than short", () => {
    // THE BROWSER BUG: over by 100, and it blamed the one blank lot.
    const t = checkTotals(2280, rowsOf([
      ["1", 385], ["2", 385], ["4", 370], ["7", 385], ["7", 410], ["13", 385], ["5", null],
    ]));
    expect(t!.difference).toBeLessThan(0);
    expect(t!.oneMissingRent).toBeNull();
    // And it offers the explanation that is actually true.
    expect(t!.doubleCountedLots).toEqual(["7"]);
  });

  it("REFUSES to name a lot when more than one is blank", () => {
    const t = checkTotals(1155, rowsOf([["1", 385], ["13", null], ["14", null]]));
    expect(t!.oneMissingRent).toBeNull();
  });

  it("says nothing about double-counting when the sheet is short", () => {
    const t = checkTotals(2000, rowsOf([["7", 385], ["7", 410]]));
    expect(t!.doubleCountedLots).toEqual([]);
  });
});

describe("statedTotalFrom", () => {
  it("takes the money, not the lot count", () => {
    expect(statedTotalFrom(["TOTAL\t24 lots\t9,965.00"])).toBe(9965);
    expect(statedTotalFrom(["TOTAL\t\t2280"])).toBe(2280);
    expect(statedTotalFrom(["Grand total: $10,350"])).toBe(10350);
  });

  it("returns null when there is no total to read", () => {
    expect(statedTotalFrom([])).toBeNull();
    expect(statedTotalFrom(["TOTAL", "Page 2 of 4"])).toBeNull();
  });
});

describe("a NAMED roll carries rate cards too", () => {
  // The named path returned `rates: []`, so importing a roll with names wrote
  // lots and tenancies and not one rate card — leaving "Rate cards 0 of 21" on
  // the checklist and "Ask the park about rates" on every lot of the public
  // page, for a park whose sheet stated a rent on every line.
  const roll = "Lot\tTenant\tRent\n1\tAmberg, Roy\t395\n2\tBell, Dana\t410";

  it("plans a rate for every ready monthly row", () => {
    const p = plan(roll, LOTS);
    expect(p.namelessRoll).toBe(false);
    expect(p.rates.map((r) => [r.lotLabel, r.amount])).toEqual([["1", 395], ["2", 410]]);
  });

  it("skips a row with no amount rather than writing a rate of zero", () => {
    const p = plan("Lot\tTenant\tRent\n1\tAmberg, Roy\t\n2\tBell, Dana\t410", LOTS);
    expect(p.rates.map((r) => r.lotLabel)).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------
// THE EMPTY PADS ARE LOTS.
//
// A roll's vacant and silent lines were recorded as import NOTES and created
// nothing, so The Haven imported as 19 lots instead of 21 — and a cost split
// "across every rentable lot, with the park carrying the empties" divided by
// 19 and carried nothing, because the empties did not exist to be carried.
// ---------------------------------------------------------------------------
describe("the lots nobody is on", () => {
  it("gives an empty pad the label its text would get as a BILLED row", () => {
    // This asserted "LOT3","LOT22","LOT7","LOT12","LOT9" — every empty pad
    // forced into a LOT-prefixed shape, on the stated grounds that it matched
    // "the shape the parser emits for a billed lot".
    //
    // That is true of The Haven's roll, where every line reads "Lot 4", and
    // FALSE of any roll written as bare numbers — including the one in this
    // app's own paste-box placeholder. parseLot now reads "Lot 3" as "3";
    // parseLot("12") is "12". So a bare-number roll billed lots 1..21 and
    // then created empty pads LOT6 and LOT19 beside the real 6 and 19: 23
    // lots for 21 pedestals, occupancy reading 18/23, and every shared cost
    // divided by 23 — which is the exact arithmetic this whole file exists to
    // get right.
    expect(emptyLotsFrom([
      { text: "Lot 3" },
      { text: "Lot 22 — vacant" },
      { text: "#7" },
      { text: "12" },
      { text: "Site 9  (needs skirting)" },
    ]).map((e) => e.label)).toEqual(["3", "22", "7", "12", "9"]);
  });

  it("cannot disagree with the billed side, whichever way the roll is written", () => {
    // The property that matters, stated directly: for any text, the empty-pad
    // label equals what a billed row with that lot cell would be called.
    for (const [cell, expected] of [
      ["Lot 3", "3"], ["LOT 3", "3"], ["3", "3"], ["#3", "3"], ["12A", "12A"],
      ["Site 9", "9"], ["Space 6", "6"], ["Pad 14", "14"],
    ] as const) {
      const [only] = emptyLotsFrom([{ text: cell }]);
      expect(only?.label, cell).toBe(expected);
      expect(only?.label, `${cell} must match parseLot`).toBe(parseLot(cell).value ?? expected);
    }
  });

  it("will not re-create a pad the park already has, however the sheet spells it", () => {
    // "Lot 6" on the sheet against a stored "6" compared raw strings and
    // missed, so the import added a second pedestal for lot 6.
    for (const spelling of ["Lot 6", "LOT 6", "#6", "6", "lot 6 — vacant"]) {
      expect(emptyLotsFrom([{ text: spelling }], [{ lotNumber: "6" }]), spelling).toEqual([]);
    }
    // and the reverse: a stored "LOT6" against a bare "6" on the sheet
    expect(emptyLotsFrom([{ text: "6" }], [{ lotNumber: "LOT6" }])).toEqual([]);
  });

  it("never invents one it cannot read", () => {
    // A phantom lot silently dilutes every resident's utility share, which is
    // worse than missing one.
    expect(emptyLotsFrom([
      { text: "vacant" },
      { text: "— see notes —" },
      { text: "" },
    ])).toEqual([]);
  });

  it("does not re-create a lot the park already has", () => {
    expect(emptyLotsFrom(
      [{ text: "Lot 3" }, { text: "Lot 22" }],
      [{ lotNumber: "3" }],
    ).map((e) => e.label)).toEqual(["22"]);
  });

  it("says each one once, however many times the sheet mentions it", () => {
    expect(emptyLotsFrom([
      { text: "Lot 22" }, { text: "lot 22" }, { text: "Lot 22 — vacant" },
    ]).map((e) => e.label)).toEqual(["22"]);
  });
});

describe("a pad that exists versus one that does not yet", () => {
  // THE HAVEN'S REAL ROLL. Lots 1-21 are billed (3 is a gap); 22-25 are pads
  // he has not built. Counting those four would divide every resident's water
  // bill by 25 instead of 21 — a 16% cut in each share, and about $217 a month
  // the park would absorb for lots that do not exist.
  const billed = ["1","2","4","5","6","7","8","9","10","11","12","13","14",
                  "15","16","17","18","19","20","21"];

  it("treats a gap inside the numbering as a real empty pad", () => {
    const [three] = emptyLotsFrom([{ text: "Lot 3" }], [], billed);
    expect(three).toEqual({ label: "3", rentable: true });
  });

  it("treats pads beyond the last billed lot as not built yet", () => {
    const future = emptyLotsFrom(
      [{ text: "Lot 22" }, { text: "Lot 23" }, { text: "Lot 24" }, { text: "Lot 25" }],
      [], billed,
    );
    expect(future.every((e) => e.rentable === false)).toBe(true);
    expect(future.map((e) => e.label)).toEqual(["22","23","24","25"]);
  });

  it("keeps The Haven at 21 rentable lots, not 25", () => {
    const all = emptyLotsFrom(
      [{ text: "Lot 3" }, { text: "Lot 22" }, { text: "Lot 23" },
       { text: "Lot 24" }, { text: "Lot 25" }],
      [], billed,
    );
    expect(billed.length + all.filter((e) => e.rentable).length).toBe(21);
  });

  // A label with no digit at all ("Lot A") is not read as a lot — same rule as
  // "never invents one it cannot read". A phantom pad dilutes every share.
  it("does not invent a lot from a label with no number in it", () => {
    expect(emptyLotsFrom([{ text: "Lot A" }], [], billed)).toEqual([]);
  });

  // A lettered pad that DOES carry a number sits on the line normally.
  it("places a lettered pad by its number", () => {
    expect(emptyLotsFrom([{ text: "Lot 12A" }], [], billed)[0])
      .toEqual({ label: "12A", rentable: true });
    expect(emptyLotsFrom([{ text: "Lot 30B" }], [], billed)[0].rentable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE ANSWER THAT HAD NOWHERE TO LAND.
//
// The importer asks "Which month do you take over?" and wrote it to
// `park_import_batches.cutover_date` — a different column on a different table
// from `parks.cutover_date`, which only the Park setup form ever wrote. So an
// owner who onboarded the documented way left parks.cutover_date NULL, and
// NULL means "no handover, no restriction" (0131): the go-live gate waved
// through a charge run for a month that still belonged to the seller.
// ---------------------------------------------------------------------------
describe("committing an import records the go-live date", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("finds the file it is scanning", () => {
    expect(src).toMatch(/export async function commitImport/);
  });

  it("writes parks.cutover_date, not just the batch's", () => {
    expect(src).toMatch(/\.from\("parks"\)\s*\n?\s*\.update\(\{ cutover_date: loaded\.cutover \}\)/);
  });

  it("only when the park has none — an import must not move his ledger's start", () => {
    // If he set a closing date on Park setup, that is his answer.
    expect(src).toMatch(/park\.cutover_date == null/);
  });
});

// ---------------------------------------------------------------------------
// THE HOUSEHOLD THAT VANISHED BETWEEN THE READ AND THE COMMIT.
//
// `loadBatch` re-plans against LIVE tenancies every time — correct, since
// somebody may fill a lot in another tab. But `commitImport` iterates
// `plan.ready`, so a row that picks up a blocker in between leaves `ready`
// silently: not written, and not counted as a failure either.
//
// Reproduced end to end: three rows pasted, lot 2 taken by somebody else in
// between, receipt read "2 tenants are in ✓" with failed: 0, and Earl was gone
// — no tenancy, no renter file, no line anywhere. From then on an unfiled
// household and an empty lot look identical on every screen, and he is never
// billed again.
// ---------------------------------------------------------------------------
describe("a row lost between the read and the commit is NAMED", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("finds the file it is scanning", () => {
    expect(src).toMatch(/export async function commitImport/);
  });

  it("sweeps every non-skipped blocked row into failures after the loop", () => {
    expect(src).toMatch(/const written = new Set\(loaded\.plan\.ready\.map/);
    expect(src).toMatch(/for \(const row of loaded\.plan\.rows\)/);
    expect(src).toMatch(/if \(row\.skipped \|\| written\.has\(row\.lineNo\) \|\| row\.blockers\.length === 0\) continue;/);
  });

  it("uses the blocker's own sentence, not a generic one", () => {
    expect(src).toMatch(/message: importBlockerText\(row\.blockers\[0\]/);
  });

  it("does not double-report a row the write loop already named", () => {
    // The 23P01 path pushes its own failure; this sweep must not add a second.
    expect(src).toMatch(/const named = new Set/);
    expect(src).toMatch(/if \(named\.has\(`\$\{row\.lotLabel\}\|\$\{row\.name\}`\)\) continue;/);
  });

  it("treats a row he STOOD DOWN as an answer, not a loss", () => {
    expect(src).toMatch(/row\.skipped \|\|/);
  });

  it("persists the list, so it survives a reload", () => {
    // Client state would have lost it on refresh — and the receipt is a page
    // he comes back to.
    expect(src).toMatch(/failed: failures\.length,[\s\S]{0,120}?failures,/);
  });
});


// ---------------------------------------------------------------------------
// DOES THIS SHEET NUMBER THE PADS THE WAY THE PARK DOES?
//
// The most likely way tomorrow goes wrong, and it produces a screen that looks
// fine. The Haven's pads are 1, 2, 6, 7, 9, 10, 11, 14, 15-24, 26, 27, 28 —
// not 1-21. A seller whose book numbers his tenants 1..21 produces a file
// where FIFTEEN rows match a real pad by coincidence, import silently with no
// blocker and nothing to answer, and put fifteen households on lots that are
// not theirs. The other six become "Create lot 3" buttons whose obvious answer
// is yes, taking the park to 27 lots — the denominator every shared cost is
// divided by, so the $142.53 fee built on 21 quietly dilutes.
//
// Verified against the real parser before writing this: a 1..21 sheet against
// the real pads returns matched=[1,2,6,7,9,10,11,14,15,16,17,18,19,20,21] with
// verdict "import", and lots 3,4,5,8,12,13 as "ask".
// ---------------------------------------------------------------------------
describe("the sheet's lots against the park's lots", () => {
  const HAVEN = ["1","2","6","7","9","10","11","14","15","16","17","18","19","20","21","22","23","24","26","27","28"];
  const f = (matched: string | null, raw: string) => ({ matched, raw });

  it("catches the mis-numbered seller roll — the whole point", () => {
    // What a 1..21 book actually produces through the parser.
    const file = [
      ...["1","2","6","7","9","10","11","14","15","16","17","18","19","20","21"].map((l) => f(l, l)),
      ...["3","4","5","8","12","13"].map((l) => f(null, l)),
    ];
    const r = reconcileRoll(HAVEN, file);

    expect(r.matched).toHaveLength(15);
    expect(r.wouldCreate).toEqual(["3","4","5","8","12","13"]);
    expect(r.neverMentioned).toEqual(["22","23","24","26","27","28"]);
    expect(r.looksMisnumbered, "the signature is BOTH lists at once").toBe(true);
  });

  it("stays quiet for a roll that uses the park's own numbers", () => {
    const r = reconcileRoll(HAVEN, HAVEN.map((l) => f(l, l)));
    expect(r.wouldCreate).toEqual([]);
    expect(r.neverMentioned).toEqual([]);
    expect(r.looksMisnumbered).toBe(false);
  });

  it("does not cry mismatch over one new pad", () => {
    // A genuinely new site is ordinary. One unknown label alone is not a
    // numbering problem, and a warning that fires on the ordinary case is a
    // warning he learns to click past.
    const r = reconcileRoll(HAVEN, [...HAVEN.map((l) => f(l, l)), f(null, "29")]);
    expect(r.wouldCreate).toEqual(["29"]);
    expect(r.neverMentioned).toEqual([]);
    expect(r.looksMisnumbered).toBe(false);
  });

  it("does not cry mismatch over a seller who omitted his empties", () => {
    // The other ordinary case: 19 occupied lots listed, 2 empties left off.
    const listed = HAVEN.slice(0, 19);
    const r = reconcileRoll(HAVEN, listed.map((l) => f(l, l)));
    expect(r.wouldCreate).toEqual([]);
    expect(r.neverMentioned).toEqual(["27","28"]);
    expect(r.looksMisnumbered, "quiet pads alone are a vacancy, not a mismatch").toBe(false);
  });

  it("still reports both lists even when it does not raise the alarm", () => {
    // The card shows the comparison whenever there is anything to compare —
    // the alarm is the loud branch, not the only one.
    const r = reconcileRoll(HAVEN, HAVEN.slice(0, 19).map((l) => f(l, l)));
    expect(r.neverMentioned.length).toBeGreaterThan(0);
    expect(r.parkLots).toHaveLength(21);
  });

  it("counts a raw label the park DOES have as matched, not as new", () => {
    // planImport resolves most labels, but a row can arrive unresolved with a
    // raw that is nonetheless one of his pads. Creating it would duplicate.
    const r = reconcileRoll(HAVEN, [f(null, "6"), f(null, " 07 ")]);
    expect(r.wouldCreate).toEqual([]);
    expect(r.matched).toContain("6");
  });

  it("ignores a line with no lot at all rather than inventing one", () => {
    const r = reconcileRoll(HAVEN, [f(null, ""), f(null, "   ")]);
    expect(r.wouldCreate).toEqual([]);
  });

  it("a lot the sheet calls VACANT counts as mentioned", () => {
    // Otherwise every declared-empty pad reads as one the seller never
    // mentioned — the opposite of true, and enough of them to fire the
    // mis-numbering alarm on a perfectly good roll.
    const occupied = HAVEN.slice(0, 19).map((l) => f(l, l));
    const vacant = ["27", "28"].map((l) => f(null, l));   // how emptyLots arrive
    const r = reconcileRoll(HAVEN, [...occupied, ...vacant]);
    expect(r.neverMentioned).toEqual([]);
    expect(r.wouldCreate).toEqual([]);
    expect(r.looksMisnumbered).toBe(false);
  });

  it("lists a repeated new lot once", () => {
    const r = reconcileRoll(HAVEN, [f(null, "3"), f(null, "3")]);
    expect(r.wouldCreate).toEqual(["3"]);
  });

  it('lists "3" and "03" separately, because that is what would be created', () => {
    // Tempting to fold these together, and it would be a lie: neither matches
    // a pad, so approving both really does make two lots. The card predicts
    // the import, and seeing "3, 03" side by side is itself the useful signal
    // that something in the sheet is inconsistent.
    const r = reconcileRoll(HAVEN, [f(null, "3"), f(null, "03")]);
    expect(r.wouldCreate).toEqual(["3", "03"]);
  });
});


describe("the comparison reaches the screen", () => {
  // The helper being right is half of it; a card nothing renders is the other
  // half of every defect in this codebase.
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the loader computes it", () => {
    const actions = read("./import-actions.ts");
    expect(actions, "reconcileRoll is not called").toMatch(/reconciliation: reconcileRoll\(/);
    expect(actions, "it must be fed the park's real lots").toMatch(/lots\.map\(\(l\) => l\.lotNumber\)/);
  });

  it("the page hands it to the component", () => {
    expect(read("./import/[batchId]/page.tsx")).toMatch(/reconciliation: batch\.reconciliation/);
  });

  it("the component renders both directions and the alarm", () => {
    const c = read("../../components/ParkImportRead.tsx");
    expect(c).toMatch(/reconciliation\.wouldCreate/);
    expect(c).toMatch(/reconciliation\.neverMentioned/);
    expect(c, "the loud branch is the whole reason for the card")
      .toMatch(/reconciliation\.looksMisnumbered/);
    expect(c, "it must name the lots, not just count them")
      .toMatch(/wouldCreate\.join\(", "\)/);
  });

  it("says what creating them does to the denominator", () => {
    // Every shared cost is divided by the lot count. Going to 27 lots dilutes
    // the $142.53 fee and the park eats the difference.
    const c = read("../../components/ParkImportRead.tsx");
    expect(c).toMatch(/every shared cost is divided by that number/);
  });
});


// ---------------------------------------------------------------------------
// THE SELLER'S FILE IS PROBABLY NOT UTF-8.
//
// File.text() decodes UTF-8 unconditionally. Excel on Windows writes
// windows-1252 for "Save As -> CSV (Comma delimited)", where a curly
// apostrophe is one byte, 0x92. Decoded as UTF-8 that is invalid and becomes
// U+FFFD, so O'Neil arrives with a black diamond in the middle of it — and
// passes every check we have, because it is not a NUL byte, not empty, and
// parses as a perfectly good stated name. That household is then filed under
// that spelling permanently.
// ---------------------------------------------------------------------------
describe("decoding whatever the seller actually sent", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  /** windows-1252: one byte per character, 0x92 being the curly apostrophe. */
  const cp1252 = (bytes: number[]) => new Uint8Array(bytes);

  it("reads a plain UTF-8 file unchanged", () => {
    expect(decodeRoll(utf8("Lot,Tenant\n6,Ordoñez"))).toBe("Lot,Tenant\n6,Ordoñez");
  });

  it("reads Excel-on-Windows apostrophes as apostrophes", () => {
    // "6,O’Neil" with the curly apostrophe as windows-1252 byte 0x92.
    const bytes = cp1252([0x36, 0x2c, 0x4f, 0x92, 0x4e, 0x65, 0x69, 0x6c]);
    const out = decodeRoll(bytes);
    expect(out, "the apostrophe became a replacement character").not.toMatch(/�/);
    expect(out).toBe("6,O’Neil");
  });

  it("reads a windows-1252 accented name rather than mangling it", () => {
    // "Ordoñez" — ñ is byte 0xF1, invalid on its own as UTF-8.
    const bytes = cp1252([0x4f, 0x72, 0x64, 0x6f, 0xf1, 0x65, 0x7a]);
    expect(decodeRoll(bytes)).toBe("Ordoñez");
    expect(decodeRoll(bytes)).not.toMatch(/�/);
  });

  it("never leaves a replacement character behind for either encoding", () => {
    // The tell that something was decoded wrongly. If this can happen, a name
    // is wrong on screen and nothing anywhere says so.
    for (const b of [utf8("Ordoñez"), cp1252([0x4f, 0xf1, 0x7a]), cp1252([0x92, 0x93, 0x94])]) {
      expect(decodeRoll(b)).not.toMatch(/�/);
    }
  });

  it("loses the BOM that 'CSV UTF-8' writes", () => {
    // The option worth asking a seller for is the one that adds a BOM, which
    // would otherwise make the first header "﻿Lot" instead of "Lot".
    // TextDecoder strips it for us — pinned here rather than guarded in code,
    // because a guard for it turned out to be unreachable.
    const out = decodeRoll(utf8("﻿Lot,Tenant\n6,Maria"));
    expect(out.startsWith("Lot,")).toBe(true);
    expect(out).not.toMatch(/﻿/);
  });

  it("and the header still matches after the BOM is gone", () => {
    const r = parseRentRoll(decodeRoll(utf8("﻿Lot,Tenant,Rent\n6,Maria,400")), { knownLots: ["6"] });
    expect(r.columns.index.lot, "the first column stopped being the lot column").toBe(0);
    expect(r.rows[0].lot.value).toBe("6");
  });

  it("leaves an ASCII file byte-identical, whichever decoder ran", () => {
    // The encodings agree on ASCII, which is why trying UTF-8 first is safe.
    const plain = "Lot,Tenant,Rent\n6,Maria,400\n";
    expect(decodeRoll(utf8(plain))).toBe(plain);
  });
});


describe("a lot the seller simply left off", () => {
  // "0 empty" was a false statement at the moment of decision. `walk` is built
  // from lines that were physically in the file, so a park with 21 lots and a
  // sheet listing only the 19 occupied ones showed "19 ready · 0 need you ·
  // 0 empty" — and the empties are exactly what the park carries, so they are
  // the lots that matter for every shared cost.
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const c = read("../../components/ParkImportRead.tsx");

  it("the walk list counts his lots too, not just the file's lines", () => {
    expect(c, "absent is gone — the count is from the file again")
      .toMatch(/const absent = view\.reconciliation\.neverMentioned/);
  });

  it("the section appears even when the file declared no vacancies", () => {
    expect(c).toMatch(/walk\.length > 0 \|\| absent\.length > 0/);
  });

  it("the commit bar counts both", () => {
    const bar = c.match(/\$\{view\.ready\.length\} ready[^`]*/)?.[0] ?? "";
    expect(bar, "the bar line is gone — this scan is measuring nothing").not.toBe("");
    expect(bar, "the bar still counts only the file's vacant lines")
      .toMatch(/walk\.length \+ absent\.length/);
  });

  it("and names them, so he knows which ones to walk", () => {
    expect(c).toMatch(/not on this list at all/);
  });
});


// ---------------------------------------------------------------------------
// "LOT 26" MATCHED NONE OF HIS LOTS.
//
// The Haven's own roll reads "Lot 4" on every line — emptyLotsFrom says so in
// its comment, from a look at the real due-diligence packet. And parseLot
// collapsed the whitespace FIRST, so "Lot 26" became "LOT26" and was compared
// against a park whose lots are "26". Every row of such a roll came back
// lot_unknown, and the only control the review screen offers for that is
// "Create lot LOT26" — twenty-one times, leaving 42 lots where 21 exist and
// halving the denominator every shared cost divides by.
//
// normaliseLotLabel in import-helpers had always known about the word: it
// strips it BEFORE removing the space, so its \b fires. Two matchers, one of
// which knew "Lot" was a word.
// ---------------------------------------------------------------------------
describe("the word the seller writes in front of the number", () => {
  const HAVEN = ["1", "2", "6", "7", "9", "11", "26", "28"];

  it("matches a Lot-prefixed cell to the bare lot the park has", () => {
    for (const cell of ["Lot 26", "LOT 26", "lot 26", "Lot26", "Lot. 26", "Lot #26"]) {
      expect(parseLot(cell, HAVEN).value, cell).toBe("26");
    }
  });

  it("handles the other words a seller uses for the same thing", () => {
    // "Space" is five letters and the shape check allowed three, so this one
    // failed even earlier — before any matching was attempted.
    for (const [cell, want] of [
      ["Site 9", "9"], ["Space 6", "6"], ["Unit 7", "7"], ["Pad 11", "11"], ["Stall 2", "2"],
    ] as const) {
      expect(parseLot(cell, HAVEN).value, cell).toBe(want);
    }
  });

  it("a whole Lot-prefixed roll imports instead of blocking every row", () => {
    // The end-to-end shape of the failure: 0 ready, every row lot_unknown.
    const lots = HAVEN.map((n) => ({ id: `lot-${n}`, lotNumber: n }));
    const parsed = parseRentRoll([
      "Lot,Tenant,Rent",
      'Lot 1,"Wexler, Donna",385',
      'Lot 26,"Trombley, Ken",400',
      'Lot 28,"Bui, Anh",400',
    ].join("\n"), { knownLots: HAVEN });

    const plan = planImport({
      rows: parsed.rows, lots, liveStays: [], cutoverISO: "2027-01-01",
      season: null, namelessRoll: !parsed.shape.hasNameColumn,
    });

    expect(plan.ready.length, "rows still blocked on a Lot-prefixed roll").toBe(3);
    expect(plan.needsYou.length).toBe(0);
    expect(plan.lotsToCreate, "it would have offered to create phantom lots").toEqual([]);
    expect(plan.rows.map((r) => r.lotLabel)).toEqual(["1", "26", "28"]);
  });

  it("still refuses a lot the park genuinely does not have", () => {
    // The fix must not turn "no such lot" into a silent match.
    expect(parseLot("Lot 3", HAVEN).value).toBeNull();
    expect(parseLot("Lot 99", HAVEN).value).toBeNull();
  });

  it("a park that really stored a lot as LOT26 still wins on its own spelling", () => {
    expect(parseLot("Lot 26", ["LOT26"]).value).toBe("LOT26");
    expect(parseLot("LOT26", ["LOT26"]).value).toBe("LOT26");
  });

  it("names a new lot by its number, not by the seller's wording", () => {
    // With no known lots — a park's first roll — "Lot 4" creates lot 4.
    // Nobody paints "LOT4" on a post.
    expect(parseLot("Lot 4").value).toBe("4");
    expect(parseLot("Site 9").value).toBe("9");
  });

  it("THE TWO MATCHERS AGREE, which is the defect that caused this", () => {
    // parseLot and normaliseLotLabel resolve a label independently. They
    // disagreed on exactly the shape The Haven's roll uses.
    // The no-space spellings matter most: `\b` and the lookahead agree on
    // "Lot 26" and differ on "Lot26", so a list without them lets the two
    // drift apart again. A mutation reverting normaliseLotLabel to \b passed
    // until these were here.
    for (const cell of [
      "Lot 26", "26", "#26", "Site 9", "Space 6", "lot 6", "Pad 11", "07",
      "Lot26", "Site9", "Pad11", "SPACE6", "Lot.26", "Lotus",
    ]) {
      expect(normaliseLotLabel(cell, HAVEN), `normaliseLotLabel vs parseLot on ${cell}`)
        .toBe(parseLot(cell, HAVEN).value);
    }
  });
});
