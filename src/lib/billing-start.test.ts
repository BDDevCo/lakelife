import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  firstBillablePeriod, periodIsBillable, preCutoverRefusal,
} from "./billing-start";

// The real formatter, so a copy change that breaks the sentence breaks a test.
import { prettyMonth } from "@/app/park/ledger-helpers";

describe("where our ledger begins", () => {
  it("starts the month AFTER a mid-month handover", () => {
    // The Haven closes 15 Dec 2026. The seller collected December on the 1st
    // and settles the back half at the closing table. The resident paid their
    // month; our first bill is January.
    expect(firstBillablePeriod("2026-12-15")).toBe("2027-01");
  });

  it("keeps the month when go-live IS the first", () => {
    // Otherwise a park starting cleanly on the 1st could never bill at all —
    // the gate would eat its own first month.
    expect(firstBillablePeriod("2026-12-01")).toBe("2026-12");
  });

  it("rolls the year over in December", () => {
    expect(firstBillablePeriod("2026-12-31")).toBe("2027-01");
    expect(firstBillablePeriod("2026-01-31")).toBe("2026-02");
  });

  it("pads a single-digit month, so string comparison stays date order", () => {
    // "2026-9" would sort AFTER "2026-10", which would silently unblock a
    // month that ought to be refused.
    expect(firstBillablePeriod("2026-08-15")).toBe("2026-09");
    expect(firstBillablePeriod("2026-08-15")).toMatch(/^\d{4}-\d{2}$/);
  });

  it("treats a missing or malformed go-live date as NO restriction", () => {
    // Most parks join with no handover at all. Blocking them would be a worse
    // failure than the one this prevents.
    for (const bad of [null, undefined, "", "   ", "December 15", "2026-12"]) {
      expect(firstBillablePeriod(bad)).toBeNull();
      expect(periodIsBillable("2020-01", bad)).toBe(true);
    }
  });
});

describe("which months we may bill", () => {
  const CUT = "2026-12-15";

  it("refuses the handover month and everything before it", () => {
    expect(periodIsBillable("2026-12", CUT)).toBe(false);
    expect(periodIsBillable("2026-11", CUT)).toBe(false);
    expect(periodIsBillable("2019-07", CUT)).toBe(false);
  });

  it("allows every month from the first whole one onward", () => {
    expect(periodIsBillable("2027-01", CUT)).toBe(true);
    expect(periodIsBillable("2027-02", CUT)).toBe(true);
    expect(periodIsBillable("2030-06", CUT)).toBe(true);
  });

  it("compares across a year boundary correctly", () => {
    // "2027-01" > "2026-12" lexically as well as in time; this guards the day
    // somebody swaps the format.
    expect(periodIsBillable("2027-01", "2026-12-15")).toBe(true);
    expect(periodIsBillable("2026-12", "2027-01-01")).toBe(false);
  });
});

describe("what the owner is told", () => {
  it("says nothing at all when the month is ours", () => {
    expect(preCutoverRefusal("2027-01", "2026-12-15", prettyMonth)).toBeNull();
    expect(preCutoverRefusal("2020-05", null, prettyMonth)).toBeNull();
  });

  it("names the month, the go-live date, and where we start", () => {
    // All three, because the fix is either "that's right, wait" or "my go-live
    // date is wrong", and the sentence has to be enough to tell which.
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).toContain("December 2026");
    expect(said).toContain("December 15, 2026");
    expect(said).not.toContain("2026-12-15");   // never a raw date on screen
    expect(said).toContain("January 2027");
  });

  it("blames nobody and mentions no seller", () => {
    // Most parks were never bought. Whoever was collecting rent before may be
    // the same person reading this sentence.
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).not.toMatch(/seller|closing|purchase|owe/i);
  });

  it("writes the month in words, never as 2026-12", () => {
    const said = preCutoverRefusal("2026-12", "2026-12-15", prettyMonth)!;
    expect(said).not.toMatch(/\b2026-12\b(?!-)/);
  });
});

describe("every path that raises a charge is gated", () => {
  // BOTH ENTRY POINTS, NOT JUST THE ONE THE BUTTON CALLS. `previewChargeRun`
  // and `runCharges` are separately exported server actions; a gate in only one
  // of them is not a gate. The database refuses this too (0131), but a caller
  // that skips the check gets a raw Postgres error instead of a sentence.
  const source = () => {
    const raw = readFileSync(
      new URL("../app/park/ledger-actions.ts", import.meta.url), "utf8");
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };

  it("finds both functions it is scanning for", () => {
    const s = source();
    expect(s).toMatch(/export async function previewChargeRun/);
    expect(s).toMatch(/export async function runCharges/);
  });

  it("checks the go-live gate twice — once per entry point", () => {
    const hits = source().match(/preCutoverRefusal\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("reads cutover_date wherever it reads the due day", () => {
    // The gate is only as good as the column reaching it. Both entry points
    // select the park row already; this catches a future edit that trims the
    // select back and leaves the gate reading undefined — which would pass
    // silently, because undefined means "no restriction".
    const s = source();
    const selects = s.match(/select\("rent_due_day[^"]*"\)/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const sel of selects) expect(sel).toContain("cutover_date");
  });
});
