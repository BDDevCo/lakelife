import { describe, it, expect } from "vitest";
import {
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
  it("maps payout statuses to crew-facing text", () => {
    expect(statusLabel("released")).toBe("In Friday's payout");
    expect(statusLabel("pending")).toBe("Awaiting release");
    expect(statusLabel("other")).toBe("other");
  });
});
