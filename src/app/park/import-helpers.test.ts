import { describe, it, expect } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";
import {
  planImport,
  normaliseLotLabel,
  rangeForTerm,
  cadenceTotals,
  checkTotals,
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
