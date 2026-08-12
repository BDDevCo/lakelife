import { describe, it, expect } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";
import {
  planImport,
  normaliseLotLabel,
  rangeForTerm,
  cadenceTotals,
  checkTotals,
  statedTotalFrom,
  importBlockerText,
  MAX_LOT_LABEL,
  type ImportBlocker,
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
      name: "Somebody", amount, term: "monthly" as const, range: null,
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
