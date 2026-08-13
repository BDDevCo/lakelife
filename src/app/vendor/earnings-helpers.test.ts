import { describe, it, expect } from "vitest";
import {
  earningsRowLabel,
  tipsByCrew,
  isoWeekKey,
  isoWeekParts,
  weekStartMonday,
  weekLabel,
  formatDateHuman,
  formatCurrency,
  periodRanges,
  withinRange,
  sumInRange,
  sumByStatus,
  groupByWeek,
  csvCell,
  csvRow,
  statusLabel,
  type EarningRow,
} from "./earnings-helpers";

const row = (over: Partial<EarningRow>): EarningRow => ({
  id: "x",
  jobDate: "2026-07-20",
  service: "Pier install",
  address: "1 Lake Rd",
  amount: 100,
  status: "released",
  ...over,
});

describe("isoWeekKey / isoWeekParts", () => {
  it("keys the first ISO week of the year", () => {
    // 2026-01-01 is a Thursday -> ISO week 1 of 2026.
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekParts("2026-01-05")).toEqual({ year: 2026, week: 2 });
  });
  it("attributes late-December dates to the next ISO year", () => {
    // 2024-12-30 (Mon) belongs to ISO week 1 of 2025.
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
  });
  it("pads single-digit weeks", () => {
    expect(isoWeekKey("2026-02-16")).toMatch(/^2026-W\d{2}$/);
  });
});

describe("weekStartMonday / weekLabel / formatDateHuman", () => {
  it("snaps any weekday back to its Monday", () => {
    expect(weekStartMonday("2026-07-20")).toBe("2026-07-20"); // Monday
    expect(weekStartMonday("2026-07-23")).toBe("2026-07-20"); // Thursday -> Mon
    expect(weekStartMonday("2026-07-26")).toBe("2026-07-20"); // Sunday -> Mon
  });
  it("labels a week by its Monday", () => {
    expect(weekLabel("2026-07-23")).toBe("Week of Jul 20, 2026");
  });
  it("formats a plain date timezone-stably", () => {
    expect(formatDateHuman("2026-01-01")).toBe("Jan 1, 2026");
  });
});

describe("formatCurrency", () => {
  it("formats dollars with cents and thousands separators", () => {
    expect(formatCurrency(120)).toBe("$120.00");
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });
  it("treats null/blank as zero and rounds to the cent", () => {
    expect(formatCurrency(null)).toBe("$0.00");
    expect(formatCurrency("")).toBe("$0.00");
    expect(formatCurrency(48.005)).toBe("$48.01");
  });
  it("keeps negatives readable", () => {
    expect(formatCurrency(-40)).toBe("-$40.00");
  });
});

describe("periodRanges", () => {
  it("computes month and YTD from today", () => {
    const r = periodRanges("2026-07-21");
    expect(r.thisMonth).toEqual({ from: "2026-07-01", to: "2026-07-21" });
    expect(r.ytd).toEqual({ from: "2026-01-01", to: "2026-07-21" });
  });
  it("snaps quarter starts across all four boundaries", () => {
    expect(periodRanges("2026-02-15").thisQuarter.from).toBe("2026-01-01");
    expect(periodRanges("2026-04-01").thisQuarter.from).toBe("2026-04-01");
    expect(periodRanges("2026-09-30").thisQuarter.from).toBe("2026-07-01");
    expect(periodRanges("2026-12-31").thisQuarter.from).toBe("2026-10-01");
  });
});

describe("withinRange / sumInRange / sumByStatus", () => {
  it("is inclusive on both ends", () => {
    expect(withinRange("2026-01-01", "2026-01-01", "2026-01-31")).toBe(true);
    expect(withinRange("2026-01-31", "2026-01-01", "2026-01-31")).toBe(true);
    expect(withinRange("2026-02-01", "2026-01-01", "2026-01-31")).toBe(false);
  });
  it("sums take-home inside a range and by status", () => {
    const rows = [
      row({ jobDate: "2026-07-01", amount: 100, status: "released" }),
      row({ jobDate: "2026-07-15", amount: 250, status: "released" }),
      row({ jobDate: "2026-06-30", amount: 999, status: "pending" }),
    ];
    expect(sumInRange(rows, "2026-07-01", "2026-07-31")).toBe(350);
    expect(sumByStatus(rows, "released")).toBe(350);
    expect(sumByStatus(rows, "pending")).toBe(999);
  });
});

describe("groupByWeek", () => {
  it("buckets rows into ISO weeks with subtotals, newest first", () => {
    const rows = [
      row({ id: "a", jobDate: "2026-07-23", amount: 200 }), // week of Jul 20
      row({ id: "b", jobDate: "2026-07-20", amount: 100 }), // same week
      row({ id: "c", jobDate: "2026-07-13", amount: 50 }), // week of Jul 13
    ];
    const groups = groupByWeek(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Week of Jul 20, 2026");
    expect(groups[0].subtotal).toBe(300);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groups[1].label).toBe("Week of Jul 13, 2026");
    expect(groups[1].subtotal).toBe(50);
  });
  it("puts undated payouts in an Undated bucket sorted last", () => {
    const groups = groupByWeek([
      row({ id: "u", jobDate: "", amount: 10 }),
      row({ id: "d", jobDate: "2026-07-20", amount: 40 }),
    ]);
    expect(groups[0].label).toBe("Week of Jul 20, 2026");
    expect(groups[groups.length - 1].label).toBe("Undated");
  });
});

describe("csvCell / csvRow", () => {
  it("passes plain values through unquoted", () => {
    expect(csvCell("Pier install")).toBe("Pier install");
    expect(csvCell(120)).toBe("120");
    expect(csvCell(null)).toBe("");
  });
  it("quotes cells containing commas", () => {
    expect(csvCell("123 Lake Rd, Angola")).toBe('"123 Lake Rd, Angola"');
  });
  it("doubles embedded quotes and quotes newlines", () => {
    expect(csvCell('The "Big" Dock')).toBe('"The ""Big"" Dock"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("joins a full row, escaping each cell", () => {
    expect(csvRow(["2026-07-20", "Pier, install", 120, "Released"])).toBe(
      '2026-07-20,"Pier, install",120,Released',
    );
  });
});

describe("statusLabel", () => {
  it("names the REAL cadence — batches run at month end, not on Fridays", () => {
    // The old label promised a Friday. `runMonthlyPayoutBatches` gates on
    // `isLastDayOfMonth`; there is no Friday cadence anywhere in the system,
    // and telling a crew the wrong week for their own money loses crews.
    expect(statusLabel("released")).toBe("In the next month-end payout");
    expect(statusLabel("pending")).toBe("Awaiting release");
  });

  it("never prints a raw database word at a crew", () => {
    // `refund-core` writes 'clawed'. It used to fall straight through and
    // appear as the literal word — on the earnings screen AND in the CSV that
    // goes to the crew's bookkeeper.
    expect(statusLabel("clawed")).toMatch(/refund went back/);
    expect(statusLabel("clawed")).not.toContain("clawed");
    expect(statusLabel("something_new")).toBe("Being worked out");
  });
});

describe("the crew's statement says what each payment IS", () => {
  it("job pay is named by its service", () => {
    expect(earningsRowLabel({ kind: "earning", service: "Pier install" })).toBe("Pier install");
  });

  it("a clawback stays deliberately generic", () => {
    // Never names the service, so it can't read as "you got docked for the
    // pier install", and never carries a customer amount.
    expect(earningsRowLabel({ kind: "adjustment", service: "Pier install" }))
      .toBe("Adjustment per service terms");
  });

  it("A TRIP FEE IS NOT JOB PAY", () => {
    // It used to collapse into 'earning' and print as the service name, so a
    // $35 fee for driving to a locked house appeared on the crew's statement
    // and CSV as ordinary pay for a pier install that never happened.
    const s = earningsRowLabel({ kind: "trip", service: "Pier install" });
    expect(s).toContain("Trip fee");
    expect(s).toContain("no work possible");
  });

  it("A TIP IS NOT JOB PAY EITHER — it is different income to a bookkeeper", () => {
    const s = earningsRowLabel({ kind: "tip", service: "Housekeeping" });
    expect(s).toContain("Tip from the homeowner");
    expect(s).toContain("Housekeeping");
  });

  it("an unknown kind falls back to the service, never to a clawback", () => {
    // The safe default for a number a crew is owed is "we paid you for this
    // job", not "we took money off you".
    expect(earningsRowLabel({ kind: undefined, service: "Mowing" })).toBe("Mowing");
  });
});

describe("who gets tipped out — one bank account, several crews", () => {
  const rows = [
    { id: "1", jobDate: "2026-08-03", service: "Mowing",   address: "1 Pine", amount: 20, status: "released", kind: "tip" as const,     crew: "Truck 2" },
    { id: "2", jobDate: "2026-08-10", service: "Cleaning", address: "2 Oak",  amount: 35, status: "released", kind: "tip" as const,     crew: "Truck 2" },
    { id: "3", jobDate: "2026-08-11", service: "Pier",     address: "3 Elm",  amount: 50, status: "released", kind: "tip" as const,     crew: "Dave & Mike" },
    { id: "4", jobDate: "2026-08-12", service: "Mowing",   address: "4 Ash",  amount: 10, status: "released", kind: "tip" as const,     crew: null },
    { id: "5", jobDate: "2026-08-12", service: "Mowing",   address: "5 Bay",  amount: 400, status: "released", kind: "earning" as const, crew: "Truck 2" },
    { id: "6", jobDate: "2026-07-02", service: "Mowing",   address: "6 Fir",  amount: 15, status: "released", kind: "tip" as const,     crew: "Truck 2" },
  ];

  it("splits the lump sum by crew so the owner can hand it on", () => {
    const t = tipsByCrew(rows, { from: "2026-08-01", to: "2026-08-31" });
    expect(t.total).toBe(115);
    expect(t.count).toBe(4);
    expect(t.byCrew.map((c) => [c.crew, c.total])).toEqual([
      ["Truck 2", 55],
      ["Dave & Mike", 50],
      [null, 10],
    ]);
  });

  it("JOB PAY IS NOT A TIP — only kind='tip' is in here", () => {
    // The $400 earning on the same truck must never inflate what gets passed
    // on; that money is the company's, the tip is not.
    const t = tipsByCrew(rows, { from: "2026-08-01", to: "2026-08-31" });
    expect(t.total).toBe(115);
    expect(t.byCrew.find((c) => c.crew === "Truck 2")!.total).toBe(55);
  });

  it("respects the statement period — July's tip stays in July", () => {
    const aug = tipsByCrew(rows, { from: "2026-08-01", to: "2026-08-31" });
    const jul = tipsByCrew(rows, { from: "2026-07-01", to: "2026-07-31" });
    expect(aug.count).toBe(4);
    expect(jul.count).toBe(1);
    expect(jul.total).toBe(15);
  });

  it("UNATTRIBUTED TIPS ARE REPORTED, NEVER DROPPED", () => {
    // A job that never went on a named route has no crew on record. Hiding it
    // would lose $10 of somebody's money; guessing would send it to the wrong
    // person. So it is listed, last, and labelled as unknown.
    const t = tipsByCrew(rows, { from: "2026-08-01", to: "2026-08-31" });
    expect(t.unattributed).toBe(10);
    expect(t.byCrew[t.byCrew.length - 1].crew).toBe(null);
    // The sum of the parts is still the whole.
    expect(t.byCrew.reduce((s, c) => s + c.total, 0)).toBe(t.total);
  });

  it("named crews sort before the unknown bucket, biggest share first", () => {
    const t = tipsByCrew(rows, { from: "2026-08-01", to: "2026-08-31" });
    const names = t.byCrew.map((c) => c.crew);
    expect(names.indexOf(null)).toBe(names.length - 1);
  });

  it("no range means all time", () => {
    expect(tipsByCrew(rows).count).toBe(5);
  });

  it("no tips is an empty breakdown, not a crash", () => {
    const t = tipsByCrew([{ id: "x", jobDate: "2026-08-01", service: null, address: null, amount: 100, status: "released", kind: "earning" as const }]);
    expect(t.count).toBe(0);
    expect(t.total).toBe(0);
    expect(t.byCrew).toEqual([]);
  });
});
