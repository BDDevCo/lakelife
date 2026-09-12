import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRentRoll, parseLot } from "@/lib/roll-parse";
import {
  planImport,
  normaliseLotLabel,
  sheetCadence,
  heldCadence,
  answeredCadence,
  cadenceOnSheetOf,
  rangeForTerm,
  cadenceTotals,
  checkTotals,
  statedTotalFrom,
  importBlockerText,
  typedRent,
  phoneOnFile,
  MAX_LOT_LABEL,
  type ImportBlocker, emptyLotsFrom, reconcileRoll, decodeRoll,
} from "./import-helpers";

// ---------------------------------------------------------------------------
// THE REAL `resolveRow`, against a fake of the two tables it touches. Mocked
// here at the top because vi.mock is hoisted; nothing else in this file
// imports the server client, so the pure helpers above are untouched.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};
class FakeQ {
  private fs: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  update(patch: Row) { this.patch = patch; return this; }
  private resolve() {
    const hit = (fakeDb[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit, error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data[0] ?? null, error: null })); }
  then<A, B>(ok?: ((x: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => new FakeQ(t) }),
  createServiceClient: () => ({ from: (t: string) => new FakeQ(t) }),
}));

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
      "lot_twice_in_paste", "label_too_long", "bad_amount", "bad_term", "looks_yearly", "no_season",
    ];
    // The union in the source, so a blocker added without a sentence — or a
    // sentence added here without a blocker — fails rather than rotting.
    const src = readFileSync(fileURLToPath(new URL("./import-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const union = src.match(/export type ImportBlocker =([\s\S]*?);/)?.[1] ?? "";
    const declared = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(declared.length, "ImportBlocker not found — this scan is measuring nothing").toBeGreaterThan(5);
    expect([...all].sort()).toEqual(declared);
    // Every cadence the sheet can state, from the union in the source too.
    const cadences = [...(src.match(/export type CadenceOnSheet =([^;]*);/)?.[1] ?? "").matchAll(/"(\w+)"/g)]
      .map((m) => m[1] as "annual");
    expect(cadences).toEqual(["annual", "quarterly", "conflicting", "unreadable"]);
    for (const b of all) {
      for (const detail of [undefined, ...cadences.map((c) => ({ cadenceOnSheet: c })),
                            { rateHint: { amount: 400, basis: "lot" as const } },
                            { rateHint: { amount: 412.5, basis: "park" as const } }]) {
        const s = importBlockerText(b, "7", detail);
        expect(s.length).toBeGreaterThan(10);
        expect(s).not.toMatch(/undefined|null|\{|\}|NaN/);
        expect(s).not.toMatch(/try again/i);
        expect(s.trim()).toBe(s);
      }
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
      amount, term: "monthly" as const, cadenceOnSheet: null, typedOver: false, rateHint: null, range: null,
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


describe("the seller's own total, read across a CSV", () => {
  // `\d[\d,]*` ran straight through the field separator, so a totals row of
  // whole dollars — "TOTAL,,6700,1200" — read as one number, 67,001,200. This
  // function takes the LARGEST it finds, so that is what won, and the panel
  // whose whole job is checking his arithmetic against his own rows would
  // have told him at the closing table that his sheet claims a figure seven
  // orders of magnitude out. It behaved only when every number in the row
  // happened to carry cents.
  it("does not read two CSV fields as one number", () => {
    // Told the delimiter, the ambiguity disappears: these are fields, not a
    // thousands separator.
    expect(statedTotalFrom(["TOTAL,,6700,1200"], "comma")).toBe(6700);
    expect(statedTotalFrom(["Total,,800,600"], "comma")).toBe(800);
    expect(statedTotalFrom(["Total\t\t6700\t1200"], "tab")).toBe(6700);
  });

  it("a quoted thousands separator survives the split", () => {
    expect(statedTotalFrom(['TOTAL,,"6,700.00"'], "comma")).toBe(6700);
    expect(statedTotalFrom(['TOTAL,,"10,850.60"'], "comma")).toBe(10850.6);
  });

  it("even with no delimiter, a run of digits cannot swallow the next field", () => {
    // The regex earns its place on this path: a caller that does not know the
    // delimiter still must not read "6700,1200" as sixty-seven million. It
    // cannot resolve the genuinely ambiguous "800,600" — only the split can —
    // but it refuses the unambiguous case.
    expect(statedTotalFrom(["Total 6700,1200"])).toBe(6700);
  });

  it("without a delimiter it still reads prose, which is all it can do", () => {
    // The honest limit: "800,600" alone is a valid grouping and there is
    // nothing to tell it apart from two fields. The caller knows, and passes.
    expect(statedTotalFrom(["Total  $10,850.60"])).toBe(10850.6);
    expect(statedTotalFrom(["Total 6700"])).toBe(6700);
  });

  it("still reads a real thousands separator", () => {
    expect(statedTotalFrom(["Total  $10,850.60"], "multispace")).toBe(10850.6);
    expect(statedTotalFrom(["Grand total 12,345,678"], "none")).toBe(12345678);
  });

  it("still takes the largest figure on the line", () => {
    // A totals row often carries a lot count and subtotals beside the figure
    // that matters.
    expect(statedTotalFrom(["21 lots,,6700.00,1200.00"], "comma")).toBe(6700);
  });

  it("the loader hands it the delimiter — a default it never passes is no fix", () => {
    const actions = readFileSync(
      fileURLToPath(new URL("./import-actions.ts", import.meta.url)),
      "utf8",
    );
    expect(actions, "statedTotalFrom is called without the delimiter again")
      .toMatch(/statedTotalFrom\([\s\S]{0,140}?parsed\.shape\.delimiter\)/);
  });

  it("keeps ignoring numbers too small to be a roll total", () => {
    expect(statedTotalFrom(["Page 2 of 3"])).toBeNull();
    expect(statedTotalFrom(["21 lots"])).toBeNull();
  });

  it("reads the plain unseparated case unchanged", () => {
    expect(statedTotalFrom(["Total 6700"], "none")).toBe(6700);
    expect(statedTotalFrom(["Total\t6700.00"], "tab")).toBe(6700);
  });
});


// ---------------------------------------------------------------------------
// A FIGURE IN A CADENCE THE PLAN WILL NOT FILE.
//
// planImport read `row.term.value ?? "monthly"`, so a sheet whose figures were
// yearly — Mike's roster — planned eighteen monthly tenancies at $3,600–$4,500
// and the review screen said "$67,500 a month … ties to the penny". The
// biller never reads the term, only the amount, so setting term "annual" on
// the tenancy would have changed nothing on the January bill. The fix is at
// plan time and it is a question: the row is held until he types the MONTHLY
// rent. Never divided by twelve — the parser's own rule, and his sheet does
// not say the year was twelve equal months.
// ---------------------------------------------------------------------------
describe("a yearly or quarterly figure is held for the monthly rent", () => {
  function planWith(blob: string, overrides: Record<number, { rent?: number | null; name?: string }>, lots = LOTS) {
    const parsed = parseRentRoll(blob, { knownLots: lots.map((l) => l.lotNumber) });
    return planImport({
      rows: parsed.rows, lots, liveStays: [], cutoverISO: CUTOVER, season: null,
      namelessRoll: !parsed.shape.hasNameColumn, overrides,
    });
  }

  it("a yearly HEADER holds the row, names the cadence, and files nothing", () => {
    const p = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t4800", {});
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou[0].blockers).toEqual(["bad_term"]);
    expect(p.needsYou[0].cadenceOnSheet).toBe("annual");
    // The tenancy this row becomes is monthly; the figure on it is his.
    expect(p.needsYou[0].term).toBe("monthly");
    expect(p.needsYou[0].amount).toBe(4800);       // the evidence, kept on the card
    expect(p.monthlyTotal).toBe(0);
    expect(p.rates).toEqual([]);
  });

  it.each([
    ["Annually", "annual"], ["Yearly", "annual"], ["Per annum", "annual"],
    ["Quarterly", "quarterly"], ["Qtr", "quarterly"], ["Twice yearly", "unreadable"], ["Whenever", "unreadable"],
  ])("a term CELL of %s holds the row as %s", (cell, cadence) => {
    const p = planWith(`Lot\tTenant\tRent\tBilling\n1\tWexler, Donna\t1200\t${cell}`, {});
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou[0].blockers).toContain("bad_term");
    expect(p.needsYou[0].cadenceOnSheet).toBe(cadence);
    expect(importBlockerText("bad_term", "1", p.needsYou[0])).toMatch(/monthly rent/i);
  });

  it("the sentence names what the sheet said, and never a twelfth of it", () => {
    const annual = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t4800", {}).needsYou[0];
    const s = importBlockerText("bad_term", "1", annual);
    expect(s).toMatch(/yearly figure/);
    expect(s).not.toMatch(/400/);
    const q = planWith("Lot\tTenant\tRent\tBilling\n1\tWexler, Donna\t1200\tQuarterly", {}).needsYou[0];
    expect(importBlockerText("bad_term", "1", q)).toMatch(/quarterly figure/);
    const u = planWith("Lot\tTenant\tRent\tBilling\n1\tWexler, Donna\t1200\tWhenever", {}).needsYou[0];
    expect(importBlockerText("bad_term", "1", u)).toMatch(/couldn't tell how often/);
  });

  it("a row with no figure has nothing to hold", () => {
    const p = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t", {});
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].amount).toBeNull();
    expect(p.ready[0].term).toBe("monthly");
  });

  it("the monthly rent he types clears it — as typed, filed monthly", () => {
    const blob = "Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t4800";
    const p = planWith(blob, { 2: { rent: 400 } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0]).toMatchObject({ amount: 400, term: "monthly", blockers: [] });
    // The sheet's cadence is still remembered, so the totals check stays off.
    expect(p.ready[0].cadenceOnSheet).toBe("annual");
    // And the figure on the row is his now, not the seller's printed one.
    expect(p.ready[0].typedOver).toBe(true);
    expect(p.monthlyTotal).toBe(400);
    expect(p.rates).toEqual([{ lineNo: 2, lotLabel: "1", amount: 400, createsLot: false }]);
  });

  it("'there isn't one' is also an answer", () => {
    const p = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t4800", { 2: { rent: null } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].amount).toBeNull();
    // The seller printed 4800; nothing is on the row now. Typed over.
    expect(p.ready[0].typedOver).toBe(true);
  });

  it("a row with no figure on the sheet is never typed over — there was nothing to type over", () => {
    const p = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t", {});
    expect(p.ready[0].typedOver).toBe(false);
    // A plain monthly figure is not typed over either, even by a different
    // one: the plan would have filed it as printed, and the sentence for a
    // typed-over row would call it a figure that looked yearly. The only box
    // the screen offers such a row is the optional rent beside a name.
    const m = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t400", { 2: { rent: 400 } });
    expect(m.ready[0].typedOver).toBe(false);
    const nameless = planWith("Lot\tTenant\tRent\n1\t\t400", { 2: { name: "Wexler, Donna", rent: 410 } });
    expect(nameless.ready[0]).toMatchObject({ amount: 410, typedOver: false });
    // Nor a rent we could not read: "4l0.00" printed no figure to type over,
    // and the 410 he types restores the seller's, so the check still runs.
    const unread = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t4l0.00", { 2: { rent: 410 } });
    expect(unread.ready[0]).toMatchObject({ amount: 410, typedOver: false });
    expect(answeredCadence([...m.rows, ...nameless.rows, ...unread.rows])).toBeNull();
  });

  it("the cadence card leaves held rows out and counts them", () => {
    const p = planWith(
      "Lot\tTenant\tRent\tBilling\n1\tWexler, Donna\t385\tMonthly\n2\tFry, Loren\t4800\tAnnually",
      {},
    );
    const c = cadenceTotals(p.rows);
    expect(c.byTerm).toEqual([{ term: "monthly", count: 1, total: 385 }]);
    expect(c.heldForMonthly).toBe(1);
    expect(c.mixed).toBe(false);
  });

  it("the tie check is refused on a sheet that is not monthly — before AND after he answers", () => {
    const blob = "Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t4800\n2\tFry, Loren\t4800\nTOTAL\t\t9600";
    const before = planWith(blob, {});
    expect(checkTotals(9600, before.rows)).toBeNull();
    expect(sheetCadence(before.rows)).toBe("annual");
    // Answered, the rows are monthly and his total is still a year: 9600
    // against 800 is not a mismatch to shout about, it is two different units.
    const after = planWith(blob, { 2: { rent: 400 }, 3: { rent: 400 } });
    expect(after.ready).toHaveLength(2);
    expect(checkTotals(9600, after.rows)).toBeNull();
    expect(sheetCadence(after.rows)).toBe("annual");
    // Collapsed the other way: the same rows on a monthly sheet are checked.
    const monthly = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t400\n2\tFry, Loren\t400\nTOTAL\t\t800", {});
    expect(checkTotals(800, monthly.rows)?.ties).toBe(true);
    expect(sheetCadence(monthly.rows)).toBeNull();
  });

  it("a nameless roll under a yearly header sets up the lots with NO rate card", () => {
    const p = planWith("Lot\tAnnual Rent\n1\t4800\n2\t4800", {});
    expect(p.namelessRoll).toBe(true);
    expect(p.rates.map((r) => r.amount)).toEqual([null, null]);
    expect(p.monthlyTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE RATE CARDS AS A SCALE. A bare "Rent" header carrying yearly figures has
// no header to read; the only tell is twenty-one cards at $400 against a
// column of $3,600s. A question, never a rejection — the figure he types is
// his answer, even when it is the same one.
// ---------------------------------------------------------------------------
describe("a monthly figure many times the park's rate cards looks yearly", () => {
  const CARDED = [
    { id: "lot-1", lotNumber: "1", monthlyRate: 400 },
    { id: "lot-2", lotNumber: "2", monthlyRate: 400 },
    { id: "lot-7", lotNumber: "7", monthlyRate: 400 },
    { id: "lot-11", lotNumber: "11", monthlyRate: 1500 },   // the park-owned home
    { id: "lot-13", lotNumber: "13", monthlyRate: null },
  ];
  function planWith(
    blob: string,
    overrides: Record<number, { rent?: number | null }> = {},
    lots: { id: string; lotNumber: string; monthlyRate?: number | null }[] = CARDED,
  ) {
    const parsed = parseRentRoll(blob, { knownLots: lots.map((l) => l.lotNumber) });
    return planImport({ rows: parsed.rows, lots, liveStays: [], cutoverISO: CUTOVER, season: null, overrides });
  }

  it("holds $3,600 against a $400 card, and says which card", () => {
    const p = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t3600");
    expect(p.ready).toHaveLength(0);
    expect(p.needsYou[0].blockers).toEqual(["looks_yearly"]);
    expect(p.needsYou[0].rateHint).toEqual({ amount: 400, basis: "lot" });
    expect(importBlockerText("looks_yearly", "1", p.needsYou[0])).toMatch(/\$400 a month/);
  });

  it("the middle card is the scale, so one $1,500 home does not move it", () => {
    // Median of 400, 400, 400, 1500 is 400; four times that is 1,600.
    const home = planWith("Lot\tTenant\tRent\n11\tThe Park\t1500");
    expect(home.ready).toHaveLength(1);
    const over = planWith("Lot\tTenant\tRent\n13\tWexler, Donna\t1700");
    expect(over.needsYou[0].blockers).toEqual(["looks_yearly"]);
    // Lot 13 has no card of its own, so the sentence says what lots here go for.
    expect(over.needsYou[0].rateHint).toEqual({ amount: 400, basis: "park" });
    expect(importBlockerText("looks_yearly", "13", over.needsYou[0])).toMatch(/about \$400 a month/);
  });

  it("a lot the park does not have yet is measured against the park", () => {
    const p = planWith("Lot\tTenant\tRent\n34B\tJunior Caraway\t3600");
    expect(p.needsYou[0].blockers).toContain("looks_yearly");
    expect(p.needsYou[0].rateHint).toEqual({ amount: 400, basis: "park" });
  });

  it("does not run on a park with no cards — a guess would be worse", () => {
    const p = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t3600", {}, LOTS);
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].rateHint).toBeNull();
  });

  it("is not raised beside bad_term — that row is already asking", () => {
    const p = planWith("Lot\tTenant\tAnnual Rent\n1\tWexler, Donna\t3600");
    expect(p.needsYou[0].blockers).toEqual(["bad_term"]);
  });

  it("the figure he types is his answer, even the same one", () => {
    const p = planWith("Lot\tTenant\tRent\n1\tWexler, Donna\t3600", { 2: { rent: 3600 } });
    expect(p.ready).toHaveLength(1);
    expect(p.ready[0].amount).toBe(3600);
    expect(p.ready[0].blockers).toEqual([]);
  });

  it("no green tick above the open questions — and none once he has typed a different figure over the sheet's", () => {
    const blob = "Lot\tTenant\tRent\n1\tWexler, Donna\t3600\n2\tFry, Loren\t3600\nTOTAL\t\t7200";
    const held = planWith(blob);
    expect(checkTotals(7200, held.rows)).toBeNull();
    expect(held.rows.every((r) => r.typedOver === false)).toBe(true);
    // Answered with the monthly rent, the rows are 300 + 300 and his total
    // is still 3600 + 3600. This ran the check and said "short $6,600"
    // about a sheet that adds up: the sums no longer add the same things,
    // and the row says so.
    const answered = planWith(blob, { 2: { rent: 300 }, 3: { rent: 300 } });
    expect(answered.needsYou).toEqual([]);
    expect(answered.rows.map((r) => r.typedOver)).toEqual([true, true]);
    expect(checkTotals(7200, answered.rows)).toBeNull();
    expect(checkTotals(600, answered.rows)).toBeNull();
    // The same figure typed back IS the sheet's figure, and then his
    // arithmetic is checked: 3600 + 3600 ties to 7200.
    const same = planWith(blob, { 2: { rent: 3600 }, 3: { rent: 3600 } });
    expect(same.rows.map((r) => r.typedOver)).toEqual([false, false]);
    expect(checkTotals(7200, same.rows)?.ties).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE SCREEN OFFERS THE ANSWER IT ASKS FOR. A blocker with no control is a
// dead end dressed as a question; a box pre-filled with the sheet's yearly
// figure under "Monthly rent" is one tap from filing a year as a month.
// ---------------------------------------------------------------------------
describe("the review screen gives the held rows a monthly-rent box", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkImportRead.tsx", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("finds the file it is scanning", () => {
    expect(src).toMatch(/function AskCard\(/);
    expect(src).toMatch(/function shortReason\(/);
  });

  it("offers the rent box for both blockers", () => {
    expect(src).toMatch(/const wantsMonthly = has\("bad_term"\) \|\| has\("looks_yearly"\);/);
    expect(src).toMatch(/const wantsRent = [^;]*wantsMonthly/);
  });

  it("labels it as the MONTHLY rent and does not pre-fill the sheet's figure", () => {
    expect(src).toMatch(/wantsMonthly \? "Monthly rent" : "Rent"/);
    expect(src).toMatch(/useState\(row\.amount == null \|\| heldOnCadence \? "" : String\(row\.amount\)\)/);
  });

  it("will not save a held row with the box still empty — that refresh would say nothing", () => {
    expect(src).toMatch(/disabled=\{busy \|\| \(wantsName && !name\.trim\(\)\) \|\| \(wantsMonthly && !rent\.trim\(\)\)\}/);
  });

  it("has a short reason for each, and passes the row so the sentence can name the card", () => {
    expect(src).toMatch(/case "bad_term": return "[^"]+";/);
    expect(src).toMatch(/case "looks_yearly": return "[^"]+";/);
    expect(src).toMatch(/importBlockerText\(b, row\.lotLabel \?\? undefined, row\)/);
  });

  it("refuses the tie check through checkTotals and explains the missing panel", () => {
    expect(src).toMatch(/const sheetSays = sheetCadence\(live\);/);
    expect(src).toMatch(/\{view\.statedTotal != null && !totals && \(sheetSays \|\| cadence\.heldForMonthly > 0 \|\| answered\) && \(/);
  });
});

// ---------------------------------------------------------------------------
// A "PAID Y/N" COLUMN MUST NOT HOLD A ROLL.
//
// Probed against the real parser and planner: `Lot,Tenant,Monthly Rent,Paid`
// with Y/N cells came back 0 ready, every row held on bad_term, under a
// header that literally said Monthly — the bare word "paid" was a term
// synonym, and an unreadable term cell beat a readable rent header. Worse,
// `Annual Rent` + Paid said three different things about one column. The
// header is the stronger evidence; a cell that is not a cadence is kept in
// the notes, not obeyed; and whatever stays unreadable is said ONCE.
// ---------------------------------------------------------------------------
describe("a Paid column and a lease-length cell do not hold a roll", () => {
  const CARDED = [{ id: "lot-1", lotNumber: "1", monthlyRate: 400 }, { id: "lot-2", lotNumber: "2", monthlyRate: 400 }];
  function planWith(blob: string, lots: { id: string; lotNumber: string; monthlyRate?: number | null }[] = CARDED) {
    const parsed = parseRentRoll(blob, { knownLots: lots.map((l) => l.lotNumber) });
    const p = planImport({
      rows: parsed.rows, lots, liveStays: [], cutoverISO: CUTOVER, season: null,
      namelessRoll: !parsed.shape.hasNameColumn,
    });
    return { parsed, plan: p };
  }

  it("Monthly Rent + Paid=Y imports", () => {
    const { parsed, plan: p } = planWith('Lot,Tenant,Monthly Rent,Paid\n1,"Wexler, Donna",400,Y\n2,"Fry, Loren",410,N');
    expect(parsed.blockQuestions).toEqual([]);
    expect(p.needsYou).toEqual([]);
    expect(p.ready).toHaveLength(2);
    expect(p.ready.every((r) => r.term === "monthly" && r.cadenceOnSheet === null)).toBe(true);
    expect(p.monthlyTotal).toBe(810);
    expect(p.ready[0].notes).toContain("Paid: Y");
  });

  it("Annual Rent + Paid=Y is held as annual — one sentence at the top, and the cadence card knows it is yearly", () => {
    const { parsed, plan: p } = planWith('Lot,Tenant,Annual Rent,Paid\n1,"Wexler, Donna",4800,Y\n2,"Fry, Loren",4800,N');
    expect(p.ready).toEqual([]);
    expect(p.needsYou).toHaveLength(2);
    expect(p.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "annual")).toBe(true);
    expect(importBlockerText("bad_term", "1", p.needsYou[0])).toMatch(/yearly figure/);
    expect(sheetCadence(p.rows)).toBe("annual");
    // ONE sentence about the column, not three.
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
  });

  it("Term=12 under Monthly Rent imports — the header's cadence, with the cell kept", () => {
    const { parsed, plan: p } = planWith('Lot,Tenant,Monthly Rent,Term\n1,"Wexler, Donna",400,12\n2,"Fry, Loren",410,6');
    expect(parsed.blockQuestions).toEqual([]);
    expect(p.ready).toHaveLength(2);
    expect(p.ready[0].notes).toContain("Term: 12");
  });

  it("Term=12 under a bare Rent header is held as unreadable, and said once at the top", () => {
    const { parsed, plan: p } = planWith('Lot,Tenant,Rent,Term\n1,"Wexler, Donna",400,12\n2,"Fry, Loren",410,6');
    expect(p.ready).toEqual([]);
    expect(p.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "unreadable")).toBe(true);
    const qs = parsed.blockQuestions.filter((b) => b.code === "TERM_NOT_READ");
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toMatch(/"12" in the Term column/);
    expect(sheetCadence(p.rows)).toBe("unreadable");
  });

  it("a Term cell reading Monthly under an Annual Rent header does not beat the header", () => {
    // Before: the cell was `stated`, the row planned monthly at the yearly
    // figure, and the only thing holding it was the rate card — on a park
    // with no cards it was READY under a top sentence saying it could not be.
    const blob = 'Lot,Tenant,Annual Rent,Term\n1,"Wexler, Donna",4800,Monthly';
    const { parsed, plan: p } = planWith(blob, [{ id: "lot-1", lotNumber: "1", monthlyRate: null }]);
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
    expect(p.ready).toEqual([]);
    expect(p.needsYou[0].blockers).toEqual(["bad_term"]);
    expect(p.needsYou[0].cadenceOnSheet).toBe("conflicting");
    const s = importBlockerText("bad_term", "1", p.needsYou[0]);
    expect(s).toMatch(/header and this row's term cell disagree/i);
    expect(s).toMatch(/two answers/i);
    expect(s).toMatch(/monthly rent/i);
    expect(s).not.toMatch(/couldn't tell/i);
    expect(sheetCadence(p.rows)).toBe("conflicting");
    // With cards it is the same hold, not a second one.
    expect(planWith(blob).plan.needsYou[0].blockers).toEqual(["bad_term"]);
  });

  it("a Term cell reading Annual under a Monthly Rent header is the same contradiction, said once at the top", () => {
    // The other direction. The cell used to be `stated` annual and the card
    // read "This is a yearly figure" — asserting the figure is a year when
    // the header says it is a month. Neither is trusted; the sheet is asked.
    const { parsed, plan: p } = planWith('Lot,Tenant,Monthly Rent,Term\n1,"Wexler, Donna",400,Annual\n2,"Fry, Loren",410,Annual');
    expect(p.ready).toEqual([]);
    expect(p.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "conflicting")).toBe(true);
    expect(importBlockerText("bad_term", "1", p.needsYou[0])).not.toMatch(/yearly figure/);
    const qs = parsed.blockQuestions.filter((b) => b.code === "TERM_CONFLICTS");
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toMatch(/"Monthly Rent"/);
    expect(qs[0].question).toMatch(/Term column/);
    expect(qs[0].question).toMatch(/"Annual"/);
    expect(qs[0].question).toMatch(/2 rows/);
    expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["TERM_CONFLICTS"]);
  });
});

// ---------------------------------------------------------------------------
// ONE ROW MUST NOT DECIDE THE SHEET'S CADENCE.
//
// `sheetCadence` took the most frequent NON-NULL cadence and ignored every
// row without one, so a single conflicting row on a monthly sheet — or a
// blank-rent row whose term cell said Annual, which held nothing — made the
// whole sheet "conflicting", switched the seller's-arithmetic check off for
// good, and printed "adds up figures the sheet gives two cadences for" about
// a monthly total that tied to the penny. A sheet's cadence is the one MOST
// of its figures share, or nothing; the held row still refuses the tick on
// its own until it is answered; and the sentence about held rows is derived
// from the held rows, not from the sheet.
// ---------------------------------------------------------------------------
describe("the sheet's cadence is a majority of its figures, never one row", () => {
  const CARDED = [
    { id: "lot-1", lotNumber: "1", monthlyRate: 400 },
    { id: "lot-2", lotNumber: "2", monthlyRate: 400 },
    { id: "lot-7", lotNumber: "7", monthlyRate: 400 },
  ];
  function planWith(
    blob: string,
    overrides?: Record<number, { rent?: number | null; skip?: boolean }>,
    lots: { id: string; lotNumber: string; monthlyRate?: number | null }[] = CARDED,
  ) {
    const parsed = parseRentRoll(blob, { knownLots: lots.map((l) => l.lotNumber) });
    const p = planImport({
      rows: parsed.rows, lots, liveStays: [], cutoverISO: CUTOVER, season: null,
      namelessRoll: !parsed.shape.hasNameColumn, overrides,
    });
    return { parsed, plan: p };
  }
  // The seller's total is the sum of the figures he PRINTED: 400 + 400 + 4800.
  const ODD_ROW = 'Lot,Tenant,Monthly Rent,Term\n1,"Wexler, Donna",400,Monthly\n2,"Fry, Loren",400,Monthly\n7,"Ordonez, Maria",4800,Annual\nTOTAL,,5600,';

  it("one Annual row on a monthly sheet leaves the sheet monthly, and holds only that row", () => {
    const { plan: p } = planWith(ODD_ROW);
    expect(p.ready).toHaveLength(2);
    expect(p.needsYou).toHaveLength(1);
    expect(p.needsYou[0]).toMatchObject({ lotLabel: "7", cadenceOnSheet: "conflicting", blockers: ["bad_term"] });
    expect(sheetCadence(p.rows)).toBeNull();
  });

  it("the tie check waits for the held row, and stays off once he has typed a different figure over the sheet's", () => {
    // A tick above an open question about one of the same figures answers
    // it — so no tick while held, however the majority reads.
    const { plan: held } = planWith(ODD_ROW);
    expect(checkTotals(5600, held.rows)).toBeNull();
    // Answered with the MONTHLY rent, the rows are 400 + 400 + 400 and his
    // total is still 400 + 400 + 4800: the two no longer add up the same
    // things, and no total he could have printed is a check on them. This
    // ran the check and said "short $4,400" about a sheet that adds up to
    // the penny — and ticked only a 1,200 the seller could have written by
    // dividing 4,800 by 12 himself.
    const { plan: after } = planWith(ODD_ROW, { 4: { rent: 400 } });
    expect(after.needsYou).toEqual([]);
    const odd = after.rows.find((r) => r.lotLabel === "7")!;
    expect(odd.cadenceOnSheet).toBe("conflicting");   // remembered on the row
    expect(odd.typedOver).toBe(true);
    expect(sheetCadence(after.rows)).toBeNull();
    expect(checkTotals(5600, after.rows)).toBeNull();
    expect(checkTotals(1200, after.rows)).toBeNull();
    expect(checkTotals(800, after.rows)).toBeNull();
    // The SAME figure typed back is still his figure, and then the check is
    // his arithmetic over his own numbers: 400 + 400 + 4800 ties to 5600.
    const { plan: same } = planWith(ODD_ROW, { 4: { rent: 4800 } });
    expect(same.needsYou).toEqual([]);
    expect(same.rows.find((r) => r.lotLabel === "7")?.typedOver).toBe(false);
    expect(checkTotals(5600, same.rows)?.ties).toBe(true);
    expect(checkTotals(1200, same.rows)?.difference).toBe(-4400);
    // Stood down, the row is out of both sums: 400 + 400 against whatever
    // he wrote is his arithmetic again.
    const { plan: gone } = planWith(ODD_ROW, { 4: { skip: true } });
    expect(checkTotals(800, gone.rows)?.ties).toBe(true);
  });

  it("the rows whose figure is no longer the seller's are counted, by kind, for the sentence that says why", () => {
    // Held: nothing answered yet.
    expect(answeredCadence(planWith(ODD_ROW).plan.rows)).toBeNull();
    // Answered with a different figure: one conflicting row.
    expect(answeredCadence(planWith(ODD_ROW, { 4: { rent: 400 } }).plan.rows)).toEqual({ kind: "conflicting", count: 1 });
    // The same figure typed back is not typed over; a skipped row is not counted.
    expect(answeredCadence(planWith(ODD_ROW, { 4: { rent: 4800 } }).plan.rows)).toBeNull();
    expect(answeredCadence(planWith(ODD_ROW, { 4: { skip: true } }).plan.rows)).toBeNull();
    // Mike's bare Rent header on a carded park: held for looking yearly,
    // then typed over — the kind is the cards, not a cadence on the sheet.
    const cards = 'Lot,Tenant,Rent\n1,"Wexler, Donna",4800\n2,"Fry, Loren",4800\n7,"Ordonez, Maria",400\nTOTAL,,10000,';
    expect(answeredCadence(planWith(cards).plan.rows)).toBeNull();
    const typed = planWith(cards, { 2: { rent: 400 }, 3: { rent: 400 } }).plan;
    expect(typed.needsYou).toEqual([]);
    expect(answeredCadence(typed.rows)).toEqual({ kind: "looks_yearly", count: 2 });
    expect(checkTotals(10000, typed.rows)).toBeNull();
    // One of each: neither sentence is true of both.
    const mixed = 'Lot,Tenant,Rent,Billing\n1,"Wexler, Donna",4800,Annually\n2,"Fry, Loren",4800,\n7,"Ordonez, Maria",400,Monthly';
    expect(answeredCadence(planWith(mixed, { 2: { rent: 400 }, 3: { rent: 400 } }).plan.rows)).toEqual({ kind: "mixed", count: 2 });
    // Half answered: the answered one is counted, the held one is still held.
    const half = planWith(mixed, { 2: { rent: 400 } }).plan;
    expect(half.needsYou.map((r) => r.blockers)).toEqual([["looks_yearly"]]);
    expect(answeredCadence(half.rows)).toEqual({ kind: "annual", count: 1 });
    expect(heldCadence(half.rows)).toBe("looks_yearly");
  });

  it("a blank-rent row whose term cell says Annual has no figure to tally", () => {
    const blob = 'Lot,Tenant,Monthly Rent,Term\n1,"Wexler, Donna",400,Monthly\n2,"Fry, Loren",,Annual\nTOTAL,,400,';
    const { plan: p } = planWith(blob);
    expect(p.needsYou).toEqual([]);
    expect(p.rows.find((r) => r.lotLabel === "2")?.cadenceOnSheet).toBe("conflicting");
    expect(sheetCadence(p.rows)).toBeNull();
    expect(checkTotals(400, p.rows)?.ties).toBe(true);
  });

  it("an even split is not a majority, and a skipped row is not a vote", () => {
    const blob = 'Lot,Tenant,Rent,Billing\n1,"Wexler, Donna",400,Monthly\n2,"Fry, Loren",4800,Annually';
    expect(sheetCadence(planWith(blob).plan.rows)).toBeNull();
    // Stand the monthly row down and the sheet is all yearly.
    expect(sheetCadence(planWith(blob, { 2: { skip: true } }).plan.rows)).toBe("annual");
    // Stand the yearly row down and it is all monthly.
    expect(sheetCadence(planWith(blob, { 3: { skip: true } }).plan.rows)).toBeNull();
  });

  it("a sheet that is mostly yearly is yearly, with a monthly row or two on it", () => {
    const blob = 'Lot,Tenant,Rent,Billing\n1,"Wexler, Donna",4800,Annually\n2,"Fry, Loren",4800,Annually\n7,"Ordonez, Maria",400,Monthly\nTOTAL,,10000,';
    const { plan: p } = planWith(blob);
    expect(sheetCadence(p.rows)).toBe("annual");
    expect(checkTotals(10000, p.rows)).toBeNull();
    // And still a yearly sheet once both are answered: his total is a year.
    const { plan: after } = planWith(blob, { 2: { rent: 400 }, 3: { rent: 400 } });
    expect(after.needsYou).toEqual([]);
    expect(sheetCadence(after.rows)).toBe("annual");
    expect(checkTotals(10000, after.rows)).toBeNull();
  });

  it("what the HELD rows were stated as is read off the held rows, not the sheet", () => {
    // One conflicting row on a monthly sheet: the sheet says nothing, and
    // the sentence must not fall back to "figures that look yearly against
    // your rate cards" — nothing measured that row against a card.
    expect(heldCadence(planWith(ODD_ROW).plan.rows)).toBe("conflicting");
    // Mike's bare Rent header: nothing on the sheet, every row held on the cards.
    const cards = planWith('Lot,Tenant,Rent\n1,"Wexler, Donna",4800\n2,"Fry, Loren",4800');
    expect(cards.plan.needsYou.every((r) => r.blockers.includes("looks_yearly"))).toBe(true);
    expect(heldCadence(cards.plan.rows)).toBe("looks_yearly");
    // Two kinds held at once: neither sentence is true of all of them.
    const mixed = planWith('Lot,Tenant,Rent,Billing\n1,"Wexler, Donna",4800,Annually\n2,"Fry, Loren",4800,');
    expect(mixed.plan.needsYou.map((r) => r.blockers)).toEqual([["bad_term"], ["looks_yearly"]]);
    expect(heldCadence(mixed.plan.rows)).toBe("mixed");
    // Nothing held: nothing to say.
    expect(heldCadence(planWith(ODD_ROW, { 4: { rent: 400 } }).plan.rows)).toBeNull();
    // A held row he stood down is not counted.
    expect(heldCadence(planWith(ODD_ROW, { 4: { skip: true } }).plan.rows)).toBeNull();
  });

  it("the review screen describes the total by the sheet and the held rows by the held rows", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../components/ParkImportRead.tsx", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).toMatch(/const sheetSays = sheetCadence\(live\);/);
    expect(src).toMatch(/const heldSays = heldCadence\(live\);/);
    expect(src).toMatch(/const heldPhrase = phraseFor\(heldSays\)/);
    expect(src).toMatch(/const sheetPhrase = phraseFor\(sheetSays\)/);
    // Every kind has its own words — in the plural for a set of figures and
    // the singular for the figure on a row — and the mixed case claims
    // nothing specific. ONE table: a kind added to one form is added to both.
    expect(src).toMatch(/const KIND_WORDS: Record<HeldCadence, \{ many: string; one: string \}> = \{/);
    expect(src).toMatch(/conflicting: \{ many: "[^"]+", one: "[^"]+" \}/);
    expect(src).toMatch(/looks_yearly: \{ many: "[^"]+", one: "[^"]+" \}/);
    expect(src).toMatch(/mixed: \{ many: "figures we won't read as a monthly rent", one: "one we won't read as a monthly rent" \}/);
    expect(src).toMatch(/const phraseFor = \(c: HeldCadence \| null\) => KIND_WORDS\[c \?\? "mixed"\]\.many;/);
    expect(src).toMatch(/const figureWas = \(c: HeldCadence \| null\) => KIND_WORDS\[c \?\? "mixed"\]\.one;/);
    // The sentence about a total the sheet gave in another cadence uses the
    // sheet's word; the one about rows still waiting uses the held rows'.
    expect(src).toMatch(/adds up \{sheetPhrase\}/);
    expect(src).not.toMatch(/adds up \{heldPhrase\}/);
  });
});

// ---------------------------------------------------------------------------
// THE HEADER'S CADENCE IS A SIGNAL THE PARSER HAD, NOT TEXT TO RE-READ.
//
// A quarterly header the parser reads fine — "Rent Each Quarter" — is two
// words after the filler, which the one-word cell reader cannot read. The
// parser put the header LABEL in each row's raw and the plan re-read it as a
// cell: the top card said "a quarterly figure", each row said "we couldn't
// tell how often that's paid", and the cadence card said "a cadence we
// couldn't read". Three sentences about one column, two of them false.
// ---------------------------------------------------------------------------
describe("a quarterly header says quarterly in all three places", () => {
  const LOTS2 = [{ id: "lot-1", lotNumber: "1", monthlyRate: 400 }, { id: "lot-2", lotNumber: "2", monthlyRate: 400 }];
  function planWith(blob: string) {
    const parsed = parseRentRoll(blob, { knownLots: LOTS2.map((l) => l.lotNumber) });
    const p = planImport({ rows: parsed.rows, lots: LOTS2, liveStays: [], cutoverISO: CUTOVER, season: null });
    return { parsed, plan: p };
  }

  it.each(["Rent Each Quarter", "Rent Due Quarterly", "Quarterly Rent Due", "Quarterly Rent"])(
    "%s — the top card, the row and the sheet agree", (header) => {
      const { parsed, plan: p } = planWith(`Lot,Tenant,${header}\n1,"Wexler, Donna",1200\n2,"Fry, Loren",1200`);
      expect(parsed.blockQuestions.map((b) => b.code)).toEqual(["RENT_NOT_MONTHLY"]);
      expect(parsed.blockQuestions[0].question).toMatch(/quarterly figure/);
      expect(p.needsYou).toHaveLength(2);
      expect(p.needsYou.every((r) => r.blockers.includes("bad_term") && r.cadenceOnSheet === "quarterly")).toBe(true);
      expect(importBlockerText("bad_term", "1", p.needsYou[0])).toMatch(/quarterly figure/);
      expect(importBlockerText("bad_term", "1", p.needsYou[0])).not.toMatch(/couldn't tell/);
      expect(sheetCadence(p.rows)).toBe("quarterly");
      expect(heldCadence(p.rows)).toBe("quarterly");
    });

  it("reads the signal before the raw text, and a contradiction before either", () => {
    const unread = { value: null, confidence: "unknown" as const, raw: "Rent Each Quarter" };
    expect(cadenceOnSheetOf({ term: unread, headerCadence: "quarterly" })).toBe("quarterly");
    // Without the signal the same raw is what it always was: unreadable.
    expect(cadenceOnSheetOf({ term: unread })).toBe("unreadable");
    // A yearly header over a cell that says quarterly: both long, no
    // contradiction; the header's word wins, as it does on the top card.
    const qtr = { value: null, confidence: "unknown" as const, raw: "Qtr" };
    expect(cadenceOnSheetOf({ term: qtr, headerCadence: "annual" })).toBe("annual");
    expect(cadenceOnSheetOf({ term: qtr })).toBe("quarterly");
    // A contradiction outranks the signal.
    expect(cadenceOnSheetOf({ term: { ...unread, raw: "Monthly" }, headerCadence: "quarterly", cadenceConflict: { header: "Rent Each Quarter", cell: "Monthly" } })).toBe("conflicting");
    // A monthly or weekly header is not a cadence the plan refuses.
    expect(cadenceOnSheetOf({ term: { value: "monthly", confidence: "inferred" as const, raw: "" }, headerCadence: "monthly" })).toBeNull();
  });

  it("a Seasonal cell under a yearly header is held as a contradiction, not filed as a season", () => {
    const parsed = parseRentRoll('Lot,Tenant,Annual Rent,Term\n1,"Wexler, Donna",4800,Seasonal', { knownLots: ["1"] });
    const p = planImport({
      rows: parsed.rows, lots: [{ id: "lot-1", lotNumber: "1", monthlyRate: null }], liveStays: [],
      cutoverISO: CUTOVER, season: { start: "2027-05-01", end: "2027-10-31" },
    });
    expect(p.ready).toEqual([]);
    expect(p.needsYou[0]).toMatchObject({ blockers: ["bad_term"], cadenceOnSheet: "conflicting", term: "monthly" });
    expect(importBlockerText("bad_term", "1", p.needsYou[0])).toMatch(/two answers/);
  });
});

// ---------------------------------------------------------------------------
// THE RENT HE TYPES IS A FIGURE, OR IT IS REFUSED BY NAME.
//
// The box under "This is a yearly figure… What's the monthly rent?" invites
// arithmetic. The loader read the answer by stripping everything but digits:
// "4500/12" → 450012, "see lease" → 0 — and either cleared the hold as his
// answer, with no question left on screen. A binned attempt must not look
// like a number.
// ---------------------------------------------------------------------------
describe("the rent he types is a figure, or it is refused by name", () => {
  it("reads a plain figure, however he writes it", () => {
    expect(typedRent("375")).toEqual({ ok: true, value: 375 });
    expect(typedRent("$4,500.00")).toEqual({ ok: true, value: 4500 });
    expect(typedRent(" 375.5 ")).toEqual({ ok: true, value: 375.5 });
    expect(typedRent(375)).toEqual({ ok: true, value: 375 });
    expect(typedRent("0")).toEqual({ ok: true, value: 0 });
    // "There isn't one" is an answer the plan already accepts.
    expect(typedRent(null)).toEqual({ ok: true, value: null });
  });

  it.each(["4500/12", "4,500 / 12 = 375", "see lease", "none", "", "12 x 375", "-20"])(
    "refuses %j, naming what he typed, and never turns it into a number", (typed) => {
      const t = typedRent(typed);
      expect(t.ok).toBe(false);
      if (t.ok) return;
      expect(t.error).toMatch(/like 375/);
      if (typed.trim()) expect(t.error).toContain(typed.trim());
      expect(t.error).not.toMatch(/try again/i);
    });

  it("a number that is not a rent is refused too", () => {
    expect(typedRent(Number.NaN).ok).toBe(false);
    expect(typedRent(-5).ok).toBe(false);
    expect(typedRent(true).ok).toBe(false);
  });

  describe("resolveRow, with the screen's real payload", () => {
    beforeEach(() => {
      for (const k of Object.keys(fakeDb)) delete fakeDb[k];
      fakeDb.park_import_batches = [{ id: "b1", park_id: "p1", committed_at: null }];
      fakeDb.park_import_rows = [{ batch_id: "b1", line_no: 2, resolved: { name: "Wexler, Donna" } }];
    });

    it("refuses '4500/12' and writes nothing", async () => {
      const { resolveRow } = await import("./import-actions");
      const res = await resolveRow("b1", 2, { rent: "4500/12" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("4500/12");
      expect(res.error).toMatch(/like 375/);
      expect(fakeDb.park_import_rows[0].resolved).toEqual({ name: "Wexler, Donna" });
    });

    it("stores a plain figure as the number, merged over his earlier answers", async () => {
      const { resolveRow } = await import("./import-actions");
      const res = await resolveRow("b1", 2, { rent: "$375" });
      expect(res.ok).toBe(true);
      expect(fakeDb.park_import_rows[0].resolved).toEqual({ name: "Wexler, Donna", rent: 375 });
    });

    it("an answer with no rent in it is untouched", async () => {
      const { resolveRow } = await import("./import-actions");
      const res = await resolveRow("b1", 2, { skip: true });
      expect(res.ok).toBe(true);
      expect(fakeDb.park_import_rows[0].resolved).toEqual({ name: "Wexler, Donna", skip: true });
    });
  });

  it("the loader reads a stored answer through the same door, never a digit-stripper", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/async function loadBatch/);
    expect(src).toMatch(/typedRent\(raw\.rent\)/);
    expect(src).not.toMatch(/replace\(\/\[\^0-9\.-\]\/g/);
  });
});

// ---------------------------------------------------------------------------
// ONE MEDIAN, ONE MONEY SHAPE, ONE PHONE FORM — the right thing existed.
// ---------------------------------------------------------------------------
describe("the helpers this file borrows rather than rewrites", () => {
  const helpers = readFileSync(
    fileURLToPath(new URL("./import-helpers.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const actions = readFileSync(
    fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the park's middle rate card comes from the shared median, not a third copy", () => {
    expect(helpers).toMatch(/export function planImport/);
    expect(helpers).not.toMatch(/function medianOf/);
    expect(helpers).toMatch(/import \{ median \} from "@\/lib\/stats"/);
    expect(helpers).toMatch(/const cardMedian = median\(/);
  });

  it("the rate-card sentence prints money the way the screen does — cents only when there are any", () => {
    const row = { cadenceOnSheet: null, rateHint: { amount: 400, basis: "lot" as const } };
    expect(importBlockerText("looks_yearly", "1", row)).toMatch(/\$400 a month/);
    expect(importBlockerText("looks_yearly", "1", row)).not.toMatch(/\$400\.00/);
    const odd = { cadenceOnSheet: null, rateHint: { amount: 412.5, basis: "park" as const } };
    expect(importBlockerText("looks_yearly", "1", odd)).toMatch(/\$412\.50 a month/);
  });

  it("a pasted phone is stored the way the other two writers store it — E.164 — and shown the way it was written", () => {
    expect(phoneOnFile("(260) 555-0142")).toBe("+12605550142");
    expect(phoneOnFile(null)).toBeNull();
    expect(phoneOnFile("")).toBeNull();
    // The write goes through it. `row.phone` is parsePhone's pretty form and
    // stays that on the review screen.
    expect(actions).toMatch(/phone_on_file_with_park: phoneOnFile\(row\.phone\)/);
    expect(actions).not.toMatch(/phone_on_file_with_park: row\.phone,/);
  });
});

// ---------------------------------------------------------------------------
// COPY THAT OUTLIVES ITS CONDITION. The yearly-column card is rendered from
// the stored parse for the life of the batch; once every held row has its
// monthly rent it must read as done, not as an open blocker over a finished
// job — and the tie-check paragraph must stop saying the rows need a rent.
// ---------------------------------------------------------------------------
describe("the review screen's cadence copy follows his answers", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkImportRead.tsx", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("finds the file it is scanning", () => {
    expect(src).toMatch(/view\.blockQuestions\.map\(/);
  });

  it("names a sheet that contradicts itself, rather than calling it unreadable", () => {
    expect(src).toMatch(/conflicting: \{ many: "[^"]+", one: "[^"]+" \}/);
    expect(src).not.toMatch(/conflicting: \{ many: "[^"]*couldn't read/);
  });

  it("the yearly-column card is derived from the plan once the rows are answered", () => {
    expect(src).toMatch(/const cadenceAnswered =/);
    expect(src).toMatch(/!live\.some\(\(r\) => r\.blockers\.includes\("bad_term"\)\)/);
    expect(src).toMatch(/const CADENCE_CARDS = new Set\(\["RENT_NOT_MONTHLY", "TERM_NOT_MONTHLY", "TERM_NOT_READ", "TERM_CONFLICTS"\]\)/);
    expect(src).toMatch(/cadenceAnswered && CADENCE_CARDS\.has\(q\.code\)/);
    expect(src).toMatch(/settled \?/);
  });

  it("the tie-check paragraph says the rows need a rent only while some still do", () => {
    expect(src).toMatch(/cadence\.heldForMonthly > 0 \? \(/);
  });

  it("never promises a check that the monthly rent he types makes impossible", () => {
    // "Once every row has one, the rows are checked against it" promised the
    // seller's-arithmetic check on rows whose figure would no longer be the
    // seller's — and then ran it, reading "short $4,400" off a sheet that
    // adds up to the penny.
    expect(src).not.toMatch(/Once every row has one/);
    expect(src).not.toMatch(/the rows are checked against it/);
    // The answered state has its own sentence, derived from the plan.
    expect(src).toMatch(/const answered = answeredCadence\(live\);/);
    expect(src).toMatch(/\{view\.statedTotal != null && !totals && \(sheetSays \|\| cadence\.heldForMonthly > 0 \|\| answered\) && \(/);
    expect(src).toMatch(/the sheet&apos;s figure was \{figureWas\(answered\.kind\)\} and you typed the monthly rent over it,\s*so his total and the rows no longer add up the same things\./);
  });
});
