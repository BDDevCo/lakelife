/**
 * Pure helpers for CREW EARNINGS. No I/O, no server imports, fully unit-testable
 * — so vitest loads this file directly and the client component can import it too.
 *
 * CLAUDE.md rule 1: a crew's payout `amount` is THEIR OWN take-home (their
 * vendor_cost) — safe for them to see. Nothing in this file touches a customer
 * price or margin; those never reach the vendor surface at all.
 *
 * All date math is done on plain "YYYY-MM-DD" strings via UTC so the result is
 * deterministic regardless of the server's timezone. Nothing here calls
 * Date.now()/new Date() at module load — callers pass "today" in.
 */

/** One payout as the crew sees it (take-home only — never a customer price). */
export interface EarningRow {
  id: string;
  jobDate: string; // "YYYY-MM-DD" (job date, or the payout's created date as fallback)
  service: string | null;
  address: string | null;
  amount: number; // the crew's take-home for this job (negative for adjustments)
  status: string; // 'released' | 'pending'
  // 'earning' = job pay; 'adjustment' = a refund clawback (docs/refunds-design.md,
  // migration 0043). Optional so existing test fixtures without it still type-check
  // — treat missing as 'earning'.
  kind?: "earning" | "adjustment";
}

/** A week bucket of payouts with its subtotal. */
export interface WeekGroup {
  key: string; // ISO week key, e.g. "2026-W30"
  label: string; // human label, e.g. "Week of Jul 20, 2026"
  weekStart: string; // Monday of the week ("YYYY-MM-DD"), for sorting; "" when undated
  rows: EarningRow[];
  subtotal: number;
}

export interface DateRange {
  from: string; // inclusive "YYYY-MM-DD"
  to: string; // inclusive "YYYY-MM-DD"
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse a "YYYY-MM-DD" into a UTC Date at midnight (timezone-stable). */
function utcDate(dateISO: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * ISO-8601 week number + week-owning year for a date. Week 1 is the week
 * containing the first Thursday, so late-December / early-January dates can
 * belong to the neighbouring year (that's the point of the ISO scheme).
 */
export function isoWeekParts(dateISO: string): { year: number; week: number } {
  const d = utcDate(dateISO);
  // Shift to the Thursday of this week; the year of that Thursday owns the week.
  const dayNum = d.getUTCDay() || 7; // Sun=0 -> 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** Stable ISO week key, e.g. "2026-W07". */
export function isoWeekKey(dateISO: string): string {
  const { year, week } = isoWeekParts(dateISO);
  return `${year}-W${pad2(week)}`;
}

/** The Monday ("YYYY-MM-DD") of the week that contains dateISO. */
export function weekStartMonday(dateISO: string): string {
  const d = utcDate(dateISO);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return toISODate(d);
}

/** "Jul 20, 2026" — short, timezone-stable human date. */
export function formatDateHuman(dateISO: string): string {
  return utcDate(dateISO).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Week of Jul 20, 2026" — labelled by the Monday of the week. */
export function weekLabel(dateISO: string): string {
  return `Week of ${formatDateHuman(weekStartMonday(dateISO))}`;
}

/** "$1,234.50" — take-home only. Negative-safe; null/blank -> "$0.00". */
export function formatCurrency(amount: number | string | null | undefined): string {
  const n = Math.round((Number(amount) || 0) * 100) / 100;
  const neg = n < 0;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? "-" : ""}$${abs}`;
}

/**
 * Fixed reporting windows anchored to a caller-supplied "today" ("YYYY-MM-DD").
 * Each window runs from the period start up to and including today (running
 * totals). Quarter starts snap to Jan/Apr/Jul/Oct.
 */
export function periodRanges(todayISO: string): {
  thisMonth: DateRange;
  thisQuarter: DateRange;
  ytd: DateRange;
} {
  const [y, m] = todayISO.split("-").map(Number);
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1; // 1, 4, 7, or 10
  return {
    thisMonth: { from: `${y}-${pad2(m)}-01`, to: todayISO },
    thisQuarter: { from: `${y}-${pad2(qStartMonth)}-01`, to: todayISO },
    ytd: { from: `${y}-01-01`, to: todayISO },
  };
}

/** Inclusive membership test on plain ISO date strings (lexicographic works). */
export function withinRange(dateISO: string, from: string, to: string): boolean {
  return dateISO >= from && dateISO <= to;
}

/** Sum take-home for the rows whose jobDate falls in [from, to], rounded to cents. */
export function sumInRange(rows: EarningRow[], from: string, to: string): number {
  const total = rows.reduce((acc, r) => (withinRange(r.jobDate, from, to) ? acc + r.amount : acc), 0);
  return Math.round(total * 100) / 100;
}

/** Sum take-home for rows with a given status, rounded to cents. */
export function sumByStatus(rows: EarningRow[], status: string): number {
  const total = rows.reduce((acc, r) => (r.status === status ? acc + r.amount : acc), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Bucket payouts into ISO weeks with a per-week subtotal, newest week first.
 * Rows keep their incoming order within a week (the data layer hands us newest
 * first). Rows with a blank jobDate collect under an "Undated" bucket sorted last.
 */
export function groupByWeek(rows: EarningRow[]): WeekGroup[] {
  const map = new Map<string, WeekGroup>();
  for (const r of rows) {
    let key: string;
    let label: string;
    let weekStart: string;
    if (r.jobDate) {
      key = isoWeekKey(r.jobDate);
      weekStart = weekStartMonday(r.jobDate);
      label = weekLabel(r.jobDate);
    } else {
      key = "undated";
      label = "Undated";
      weekStart = "";
    }
    let g = map.get(key);
    if (!g) {
      g = { key, label, weekStart, rows: [], subtotal: 0 };
      map.set(key, g);
    }
    g.rows.push(r);
    g.subtotal = Math.round((g.subtotal + r.amount) * 100) / 100;
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.weekStart === b.weekStart) return 0;
    if (a.weekStart === "") return 1; // undated last
    if (b.weekStart === "") return -1;
    return a.weekStart < b.weekStart ? 1 : -1; // newest first
  });
  return groups;
}

/** Escape one CSV cell per RFC 4180 (quote when it holds a comma, quote, or newline). */
export function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join one CSV row from cells, escaping each. */
export function csvRow(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvCell).join(",");
}

/** Human status label shared by the list, statement, and CSV. */
export function statusLabel(status: string): string {
  if (status === "released") return "In Friday's payout";
  if (status === "pending") return "Awaiting release";
  return status;
}

/**
 * The line-item label shared by the list, statement, and CSV. An 'adjustment'
 * row (negative, a refund clawback per docs/refunds-design.md §Crew clawback)
 * is deliberately generic — it never names the job's service so it can't read
 * as "you got docked for the pier install," and it never references a customer
 * amount (rule 1 in reverse: the crew sees only their own number).
 */
export function earningsRowLabel(row: Pick<EarningRow, "kind" | "service">): string {
  if (row.kind === "adjustment") return "Adjustment per service terms";
  return row.service ?? "Service";
}
