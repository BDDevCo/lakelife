import { describe, it, expect } from "vitest";
import {
  planReRate, addDays, reRateSummary, reRateProblemText,
  type ReRateTarget, type ReRateProblem,
} from "./rerate-helpers";

/** The Haven's 19 paying lots, at their real in-place rents. */
const HAVEN: ReRateTarget[] = [
  ["1", 325], ["2", 250], ["4", 275], ["5", 275], ["6", 275], ["8", 275],
  ["9", 275], ["10", 250], ["11", 275], ["12", 300], ["13", 275], ["14", 300],
  ["15", 300], ["16", 250], ["17", 250], ["18", 250], ["19", 250], ["20", 300],
  ["21", 250],
].map(([lotLabel, amt]) => ({
  reservationId: `res-${lotLabel}`,
  lotLabel: String(lotLabel),
  currentAmount: amt as number,
  term: "monthly",
  endsOn: "2027-12-15",
}));

const CLOSING = "2026-12-15";

describe("the day-one re-rate", () => {
  it("plans The Haven's real day-one move to $400", () => {
    const p = planReRate({
      targets: HAVEN,
      toAmount: 400,
      effectiveOn: "2027-01-14",
      noticeGivenOn: CLOSING,
      noticeDays: 30,
    });

    expect(p.changing).toHaveLength(19);
    expect(p.skipped).toHaveLength(0);
    // The in-place roll, to the dollar.
    expect(p.monthlyBefore).toBe(5200);
    expect(p.monthlyAfter).toBe(7600);
    expect(p.monthlyDelta).toBe(2400);
    // Lot 2 at $250 → $400 is the steepest: +60%.
    expect(p.biggestIncreasePct).toBe(60);
    expect(p.tooSoon).toBe(false);
  });

  it("REFUSES an effective date inside the notice period", () => {
    // The whole point. Serving short is unenforceable, and with 19 households
    // on the other side it is not a mistake worth making.
    const p = planReRate({
      targets: HAVEN, toAmount: 400,
      effectiveOn: "2027-01-01",       // 17 days out
      noticeGivenOn: CLOSING, noticeDays: 30,
    });
    expect(p.tooSoon).toBe(true);
    expect(p.earliestEffective).toBe("2027-01-14");
  });

  it("counts the notice window from the day notice GOES OUT, not from today", () => {
    const p = planReRate({
      targets: HAVEN.slice(0, 1), toAmount: 400,
      effectiveOn: "2027-02-01",
      noticeGivenOn: "2027-01-02", noticeDays: 30,
    });
    expect(p.earliestEffective).toBe("2027-02-01");
    expect(p.tooSoon).toBe(false);
  });

  it("uses the park's dial and never a number of its own", () => {
    for (const days of [0, 15, 30, 60, 90]) {
      const p = planReRate({
        targets: HAVEN.slice(0, 1), toAmount: 400,
        effectiveOn: "2030-01-01", noticeGivenOn: CLOSING, noticeDays: days,
      });
      expect(p.earliestEffective).toBe(addDays(CLOSING, days));
    }
  });

  it("leaves out a lot already at the new rent", () => {
    const p = planReRate({
      targets: [
        ...HAVEN.slice(0, 2),
        { reservationId: "res-x", lotLabel: "X", currentAmount: 400, term: "monthly", endsOn: null },
      ],
      toAmount: 400, effectiveOn: "2027-01-14", noticeGivenOn: CLOSING, noticeDays: 30,
    });
    expect(p.changing).toHaveLength(2);
    expect(p.skipped[0].problem).toBe("already_at_amount");
  });

  it("leaves out a stay that ends before the new rent starts", () => {
    const p = planReRate({
      targets: [{ reservationId: "r", lotLabel: "9", currentAmount: 275, term: "monthly", endsOn: "2026-12-31" }],
      toAmount: 400, effectiveOn: "2027-01-14", noticeGivenOn: CLOSING, noticeDays: 30,
    });
    expect(p.changing).toHaveLength(0);
    expect(p.skipped[0].problem).toBe("ends_before_effective");
  });

  it("leaves nightly and weekly stays alone", () => {
    const p = planReRate({
      targets: [{ reservationId: "r", lotLabel: "9", currentAmount: 60, term: "nightly", endsOn: null }],
      toAmount: 400, effectiveOn: "2027-01-14", noticeGivenOn: CLOSING, noticeDays: 30,
    });
    expect(p.skipped[0].problem).toBe("not_monthly");
  });

  it("never treats a missing rent as zero", () => {
    const p = planReRate({
      targets: [{ reservationId: "r", lotLabel: "3", currentAmount: null, term: "monthly", endsOn: null }],
      toAmount: 400, effectiveOn: "2027-01-14", noticeGivenOn: CLOSING, noticeDays: 30,
    });
    expect(p.changing).toHaveLength(1);
    expect(p.changing[0].delta).toBeNull();
    expect(p.monthlyBefore).toBe(0);
    // A null "before" must not become a 100%-increase headline.
    expect(p.biggestIncreasePct).toBeNull();
  });

  it("says the thing he needs, not just the thing he wants", () => {
    const p = planReRate({
      targets: HAVEN, toAmount: 400, effectiveOn: "2027-01-14",
      noticeGivenOn: CLOSING, noticeDays: 30,
    });
    const s = reRateSummary(p);
    expect(s).toContain("19 households");
    expect(s).toContain("60%");         // the number that decides whether he staggers
    expect(s).toContain("$2,400");
  });

  it("gives every problem a sentence", () => {
    const all: ReRateProblem[] = ["no_tenancy", "already_at_amount", "ends_before_effective", "not_monthly"];
    for (const p of all) {
      const s = reRateProblemText(p, "7");
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(/undefined|null/);
    }
  });

  it("handles a month-end effective date across a year boundary", () => {
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2028-02-01", 29)).toBe("2028-03-01"); // leap year
  });
});
