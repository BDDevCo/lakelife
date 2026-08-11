import { describe, it, expect } from "vitest";
import {
  ledgerState, balanceOf, toRows, summarise, ledgerHeadline,
  planRun, runSummary, daysBetween,
  type Charge,
} from "./ledger-helpers";

const TODAY = "2027-03-10";

const charge = (over: Partial<Charge> = {}): Charge => ({
  id: "c1", lotNumber: "1", renterName: "Wexler, Donna",
  periodMonth: "2027-03", dueOn: "2027-03-01",
  amount: 455, paidTotal: 0, status: "open", ...over,
});

describe("THE FALSE-ALARM PROBLEM", () => {
  it("does NOT call a charge late inside the office's catch-up window", () => {
    // Due the 1st, today is the 10th, office runs 14 days behind. Eleven
    // households who paid on Tuesday must not appear as delinquent — an owner
    // who learns the overdue list is usually wrong stops reading it.
    expect(ledgerState(charge(), TODAY, 14)).toBe("due");
  });

  it("calls it late once the window has passed", () => {
    expect(ledgerState(charge(), TODAY, 3)).toBe("late");
  });

  it("honours a same-day office with no lag at all", () => {
    expect(ledgerState(charge(), TODAY, 0)).toBe("late");
    // ...but not before it is even due.
    expect(ledgerState(charge({ dueOn: "2027-03-20" }), TODAY, 0)).toBe("due");
  });

  it("is never late when it is not yet due", () => {
    expect(ledgerState(charge({ dueOn: "2027-04-01" }), TODAY, 0)).toBe("due");
  });
});

describe("states", () => {
  it("paid in full", () => {
    expect(ledgerState(charge({ paidTotal: 455 }), TODAY, 0)).toBe("paid");
  });

  it("part paid is not late while inside the window", () => {
    expect(ledgerState(charge({ paidTotal: 200 }), TODAY, 14)).toBe("part_paid");
  });

  it("part paid IS late once past it — a partial payment doesn't buy time", () => {
    expect(ledgerState(charge({ paidTotal: 200 }), TODAY, 3)).toBe("late");
  });

  it("overpayment is a credit, not a paid charge", () => {
    const c = charge({ paidTotal: 500 });
    expect(balanceOf(c)).toBe(-45);
    expect(ledgerState(c, TODAY, 0)).toBe("credit");
  });

  it("a voided charge stays void however much arrives against it", () => {
    expect(ledgerState(charge({ status: "void", paidTotal: 455 }), TODAY, 0)).toBe("void");
  });
});

describe("the roll-up", () => {
  const rows = toRows([
    charge({ id: "a", paidTotal: 455 }),
    charge({ id: "b", paidTotal: 0 }),
    charge({ id: "c", paidTotal: 200 }),
    charge({ id: "d", status: "void", amount: 455 }),
  ], TODAY, 3);

  it("leaves a cancelled charge out of the billed total", () => {
    // Counting it would overstate the roll and make every collection rate wrong.
    const s = summarise(rows);
    expect(s.billed).toBe(1365);      // 3 × 455, not 4
    expect(s.collected).toBe(655);
    expect(s.outstanding).toBe(710);
  });

  it("counts only what is GENUINELY late, not everything unpaid", () => {
    const s = summarise(rows);
    expect(s.lateCount).toBe(2);
    expect(s.lateAmount).toBe(710);

    const forgiving = summarise(toRows(rows, TODAY, 30));
    expect(forgiving.lateCount).toBe(0);
    expect(forgiving.dueCount).toBe(2);
  });

  it("leads with late, and says nothing about it when nothing is", () => {
    expect(ledgerHeadline(summarise(rows), 3)).toMatch(/2 households are late/);
    // An empty state reading "0 late" trains an owner to skim past the number
    // on the day it isn't zero.
    const clean = summarise(toRows([charge({ paidTotal: 455 })], TODAY, 3));
    expect(ledgerHeadline(clean, 3)).toMatch(/everything's in/i);
    expect(ledgerHeadline(clean, 3)).not.toMatch(/late/i);
  });

  it("explains the grace when money is outstanding but nothing is late", () => {
    const s = summarise(toRows([charge({ paidTotal: 100 })], TODAY, 30));
    expect(ledgerHeadline(s, 30)).toMatch(/30 days for the office/);
  });

  it("says so plainly before anything is billed", () => {
    expect(ledgerHeadline(summarise([]), 3)).toMatch(/nothing billed yet/i);
  });
});

describe("the charge run", () => {
  const candidates = [
    { reservationId: "r1", lotNumber: "1", amount: 455 },
    { reservationId: "r2", lotNumber: "2", amount: 455 },
    { reservationId: "r3", lotNumber: "13B", amount: null },
  ];

  it("skips a household with no rent set rather than billing zero", () => {
    // Billing it as zero hides the problem behind a paid charge.
    const p = planRun(candidates, new Set());
    expect(p.toBill).toHaveLength(2);
    expect(p.skippedNoTotal).toBe(1);
    expect(p.total).toBe(910);
    expect(runSummary(p, "2027-03")).toMatch(/1 skipped — no rent set/);
  });

  it("adds NOTHING on a second run", () => {
    // The unique constraint enforces this anyway, but he should see zero
    // rather than trust it.
    const p = planRun(candidates, new Set(["r1", "r2"]));
    expect(p.toBill).toHaveLength(0);
    expect(runSummary(p, "2027-03")).toMatch(/already billed/i);
  });

  it("bills a clean park in one go", () => {
    const p = planRun(candidates.slice(0, 2), new Set());
    expect(runSummary(p, "2027-03")).toBe("Bill 2 households for 2027-03 — $910.00");
  });
});

describe("daysBetween", () => {
  it("counts forward and back across a month boundary", () => {
    expect(daysBetween("2027-03-01", "2027-03-10")).toBe(9);
    expect(daysBetween("2027-03-01", "2027-02-25")).toBe(-4);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);   // leap year
  });
});
