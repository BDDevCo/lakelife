import { describe, it, expect } from "vitest";
import { monthsCovered, unbilledMonthsFor } from "./unbilled-months";

const billedMap = (o: Record<string, string[]>) =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe("which months a held row covers", () => {
  it("is half-open: a row ending on the 1st was not there that month", () => {
    expect(monthsCovered({ start: "2027-01-01", end: "2027-02-01" }, "2026-12", "2027-03"))
      .toEqual(["2027-01"]);
  });

  it("counts a single day of a month as covering it", () => {
    // A row ending on the 2nd was here on the 1st; the ledger prorates that
    // day, so it is a month with a bill.
    expect(monthsCovered({ start: "2027-01-15", end: "2027-03-02" }, "2027-01", "2027-12"))
      .toEqual(["2027-01", "2027-02", "2027-03"]);
  });

  it("stays inside [from, to]", () => {
    expect(monthsCovered({ start: "2026-01-01", end: "2028-01-01" }, "2027-02", "2027-04"))
      .toEqual(["2027-02", "2027-03", "2027-04"]);
    expect(monthsCovered({ start: "2026-01-01", end: "2028-01-01" }, "2027-04", "2027-02"))
      .toEqual([]);
  });

  it("refuses a malformed period rather than looping on it", () => {
    // shiftMonth hands a malformed period back unchanged; a loop stepping on
    // it would never reach `to`.
    expect(monthsCovered({ start: "2027-01-01", end: "2027-06-01" }, "March", "2027-06")).toEqual([]);
    expect(monthsCovered({ start: "2027-01-01", end: "2027-06-01" }, "2027-01", "")).toEqual([]);
  });
});

describe("every month with no bill, per lot", () => {
  const TODAY = "2027-03-16";
  const row = (o: Partial<Parameters<typeof unbilledMonthsFor>[0][number]> = {}) => ({
    reservationId: "r1", lotId: "L9",
    range: { start: "2027-02-01", end: "2027-05-01" } as { start: string; end: string } | null,
    ...o,
  });

  it("names the months a backfilled row has no bill for, the current one included", () => {
    const m = unbilledMonthsFor([row()], billedMap({}), { today: TODAY, cutoverDate: "2027-01-01" });
    expect(m.get("L9")).toEqual(["2027-02", "2027-03"]);
  });

  it("floors at the first billable period — nothing before go-live", () => {
    // The Haven closes 15 December: December was the seller's to collect.
    const m = unbilledMonthsFor(
      [row({ range: { start: "2026-11-01", end: "2027-05-01" } })],
      billedMap({}), { today: "2027-02-10", cutoverDate: "2026-12-15" },
    );
    expect(m.get("L9")).toEqual(["2027-01", "2027-02"]);
  });

  it("with no go-live day there is no floor, the ledger's own reading", () => {
    const m = unbilledMonthsFor(
      [row({ range: { start: "2026-11-01", end: "2027-05-01" } })],
      billedMap({}), { today: "2027-01-10", cutoverDate: null },
    );
    expect(m.get("L9")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("caps at the current month — a month that hasn't started has nothing to bill", () => {
    const m = unbilledMonthsFor([row()], billedMap({}), { today: "2027-02-03", cutoverDate: null });
    expect(m.get("L9")).toEqual(["2027-02"]);
  });

  it("an approved future row has no unbilled month", () => {
    const m = unbilledMonthsFor(
      [row({ range: { start: "2027-06-01", end: "2027-09-01" } })],
      billedMap({}), { today: TODAY, cutoverDate: null },
    );
    expect(m.get("L9")).toEqual([]);
  });

  it("is keyed per RESERVATION: the prior's February never covers the successor's", () => {
    // Prior [Nov, Feb 15) billed through February on its own id; successor
    // from 15 Feb written in March with nothing raised on it yet. February
    // has a bill — on the wrong row for the successor's days.
    const rows = [
      row({ reservationId: "prior", range: { start: "2026-11-01", end: "2027-02-15" } }),
      row({ reservationId: "next", range: { start: "2027-02-15", end: "2027-05-15" } }),
    ];
    const billed = billedMap({ prior: ["2026-11", "2026-12", "2027-01", "2027-02"] });
    expect(unbilledMonthsFor(rows, billed, { today: TODAY, cutoverDate: null }).get("L9"))
      .toEqual(["2027-02", "2027-03"]);
    // And once the successor's months are raised on ITS id, nothing is missing.
    const done = billedMap({
      prior: ["2026-11", "2026-12", "2027-01", "2027-02"], next: ["2027-02", "2027-03"],
    });
    expect(unbilledMonthsFor(rows, done, { today: TODAY, cutoverDate: null }).get("L9")).toEqual([]);
  });

  it("a lot with two rows unions and sorts their months", () => {
    const rows = [
      row({ reservationId: "b", range: { start: "2027-03-01", end: "2027-06-01" } }),
      row({ reservationId: "a", range: { start: "2027-01-01", end: "2027-03-01" } }),
    ];
    const billed = billedMap({ a: ["2027-02"] });
    expect(unbilledMonthsFor(rows, billed, { today: TODAY, cutoverDate: null }).get("L9"))
      .toEqual(["2027-01", "2027-03"]);
  });

  it("keeps lots apart", () => {
    const rows = [
      row({ reservationId: "a", lotId: "L1" }),
      row({ reservationId: "b", lotId: "L2" }),
    ];
    const m = unbilledMonthsFor(rows, billedMap({ b: ["2027-02", "2027-03"] }),
      { today: TODAY, cutoverDate: null });
    expect(m.get("L1")).toEqual(["2027-02", "2027-03"]);
    expect(m.get("L2")).toEqual([]);
  });

  it("a row whose range could not be read contributes nothing — never a guess", () => {
    const m = unbilledMonthsFor([row({ range: null })], billedMap({}), { today: TODAY, cutoverDate: null });
    expect(m.get("L9")).toEqual([]);
  });

  /**
   * THE RUN BILLS MONTHS ONLY. A row filed as paid yearly, or by the night,
   * is one the run refuses ("filed as paid yearly …", classifyForRun
   * notMonthly), so naming its months here would print "the rent screen's
   * month links reach back to bill them" about months the screen refuses —
   * every night, forever.
   */
  it("never names a month on a row the run would refuse as not monthly", () => {
    for (const term of ["annual", "seasonal", "nightly", "weekly"]) {
      const m = unbilledMonthsFor([row({ term })], billedMap({}), { today: TODAY, cutoverDate: null });
      expect(m.get("L9"), term).toEqual([]);
    }
  });

  it("a monthly row, or one that did not carry its term, is judged", () => {
    // Both halves: the filter is on the TERM, not on the field being present.
    expect(unbilledMonthsFor([row({ term: "monthly" })], billedMap({}), { today: TODAY, cutoverDate: null })
      .get("L9")).toEqual(["2027-02", "2027-03"]);
    expect(unbilledMonthsFor([row({ term: null })], billedMap({}), { today: TODAY, cutoverDate: null })
      .get("L9")).toEqual(["2027-02", "2027-03"]);
  });
});
