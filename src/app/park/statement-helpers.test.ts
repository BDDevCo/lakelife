import { describe, it, expect } from "vitest";
import {
  buildStatement, daysCovered, daysInMonth, statementLine, rollUp,
  type StatementFee,
} from "./statement-helpers";

/** The Haven after the re-rate: $400 rent, $55 grounds fee. */
const GROUNDS: StatementFee = { label: "Grounds fee", amount: 55, cadence: "monthly" };
const WHOLE_YEAR = { start: "2027-01-01", end: "2028-01-01" };

describe("a normal month", () => {
  it("adds rent and the grounds fee into one number", () => {
    const s = buildStatement({
      month: "2027-03", stay: WHOLE_YEAR, rent: 400, fees: [GROUNDS], dueDay: 1,
    });
    expect(s.total).toBe(455);
    expect(s.dueOn).toBe("2027-03-01");
    expect(s.prorated).toBe(false);
    expect(s.lines.map((l) => l.label)).toEqual(["Lot rent", "Grounds fee"]);
    expect(s.lines[0].basis).toBe("for the month");
  });

  it("shows its working on every line", () => {
    // A total with no breakdown is a number people argue with.
    const s = buildStatement({
      month: "2027-03", stay: WHOLE_YEAR, rent: 400, fees: [GROUNDS], dueDay: 1,
    });
    for (const l of s.lines) {
      expect(l.basis.length).toBeGreaterThan(3);
      expect(l.amount).toBeGreaterThan(0);
    }
  });

  it("leaves a per-stay fee off a monthly statement", () => {
    const s = buildStatement({
      month: "2027-03", stay: WHOLE_YEAR, rent: 400,
      fees: [GROUNDS, { label: "Cleaning", amount: 90, cadence: "per_stay" }],
      dueDay: 1,
    });
    expect(s.lines.map((l) => l.label)).not.toContain("Cleaning");
    expect(s.total).toBe(455);
  });
});

describe("part months", () => {
  it("charges 12 of 31 days for a move-in on the 20th", () => {
    const s = buildStatement({
      month: "2027-03", stay: { start: "2027-03-20", end: "2028-01-01" },
      rent: 400, fees: [GROUNDS], dueDay: 1,
    });
    expect(s.daysBilled).toBe(12);
    expect(s.daysInMonth).toBe(31);
    expect(s.prorated).toBe(true);
    // 400 × 12/31 = 154.84 ; 55 × 12/31 = 21.29
    expect(s.lines[0].amount).toBe(154.84);
    expect(s.lines[1].amount).toBe(21.29);
    expect(s.total).toBe(176.13);
    expect(s.lines[0].basis).toBe("12 of 31 days");
  });

  it("charges nothing for a month they were not there", () => {
    const s = buildStatement({
      month: "2027-01", stay: { start: "2027-03-01", end: "2027-06-01" },
      rent: 400, fees: [GROUNDS], dueDay: 1,
    });
    expect(s.total).toBe(0);
    expect(s.lines).toHaveLength(0);
    expect(statementLine(s)).toMatch(/nothing this month/i);
  });

  it("treats a stay ENDING on the 1st as not there that month", () => {
    // Half-open: the 1st is checkout morning.
    expect(daysCovered({ start: "2026-01-01", end: "2027-03-01" }, "2027-03")).toBe(0);
  });

  it("bills the move-out month up to checkout only", () => {
    const s = buildStatement({
      month: "2027-03", stay: { start: "2026-01-01", end: "2027-03-10" },
      rent: 400, fees: [], dueDay: 1,
    });
    expect(s.daysBilled).toBe(9);
    expect(s.total).toBe(116.13);
  });

  it("handles February, leap and otherwise", () => {
    expect(daysInMonth("2027-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    const s = buildStatement({
      month: "2028-02", stay: { start: "2027-01-01", end: "2029-01-01" },
      rent: 400, fees: [], dueDay: 1,
    });
    expect(s.total).toBe(400);   // a whole month is a whole month, 29 days or 28
  });
});

describe("what it REFUSES to bill", () => {
  it("withholds the total when no rent is set — never bills just the fee", () => {
    // A resident asked for $55 when they owe $455 pays the $55 and considers
    // it done. Billing short is worse than billing nothing.
    const s = buildStatement({
      month: "2027-03", stay: WHOLE_YEAR, rent: null, fees: [GROUNDS], dueDay: 1,
    });
    expect(s.total).toBeNull();
    expect(s.problems[0]).toMatch(/no rent is set/i);
    expect(statementLine(s)).toMatch(/no rent is set/i);
  });

  it("says the problem instead of a number on the roll", () => {
    // "$55" beside nineteen rows reading "$455" looks like a cheap lot, not a
    // missing rent — the kind of error that survives a year.
    const s = buildStatement({
      month: "2027-03", stay: WHOLE_YEAR, rent: null, fees: [GROUNDS], dueDay: 1,
    });
    expect(statementLine(s)).not.toMatch(/\$/);
  });

  it("clamps a due day past the end of a short month", () => {
    // The 31st of February is not a date, and rolling into March moves a due
    // date without anybody deciding to.
    const s = buildStatement({
      month: "2027-02", stay: WHOLE_YEAR, rent: 400, fees: [], dueDay: 31,
    });
    expect(s.dueOn).toBe("2027-02-28");
  });
});

describe("the whole park, this month", () => {
  it("totals what is owed and counts what cannot be answered", () => {
    const ok = buildStatement({ month: "2027-03", stay: WHOLE_YEAR, rent: 400, fees: [GROUNDS], dueDay: 1 });
    const missing = buildStatement({ month: "2027-03", stay: WHOLE_YEAR, rent: null, fees: [GROUNDS], dueDay: 1 });
    const gone = buildStatement({ month: "2027-03", stay: { start: "2028-01-01", end: "2028-06-01" }, rent: 400, fees: [], dueDay: 1 });

    const r = rollUp([ok, ok, missing, gone]);
    expect(r.total).toBe(910);      // the two real ones
    expect(r.billable).toBe(2);
    expect(r.blocked).toBe(1);      // the one with no rent, surfaced not hidden
  });
});
