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
  /**
   * What the CREW is told — `reportedPayoutStatus`, which deliberately
   * overrides a released row the moment it joins a batch: queued, exported,
   * paid. Right for the row list; wrong to sum lifetime money over.
   */
  status: string; // 'released' | 'pending'
  /**
   * THE PAYOUT ROW'S OWN STATUS, which batching never touches —
   * `runMonthlyPayoutBatches` filters ON status='released' and writes only
   * `batch_id` (automation.ts:3339). Summing the reported status made
   * "released so far" fall to $0.00 the night a batch was assembled, because
   * every row then reported 'queued'. Optional so existing fixtures without it
   * still type-check; treat missing as equal to `status`.
   */
  rawStatus?: string;
  // 'earning' = job pay; 'adjustment' = a refund clawback (docs/refunds-design.md,
  // migration 0043). Optional so existing test fixtures without it still type-check
  // — treat missing as 'earning'.
  kind?: "earning" | "adjustment" | "trip" | "tip";
  /**
   * WHICH CREW WAS ON IT — the truck/crew name from the route the job was on
   * (`routes.unit_name`), null when the job was never routed to a named unit.
   *
   * This exists because LakeLife pays ONE bank account per company. A tip is
   * earned by the people who were actually in the driveway, and the company
   * owner is the one who has to hand it on — so the statement has to tell them
   * WHO, or a tip quietly becomes company revenue by default.
   *
   * `routes.unit_name` is a SNAPSHOT taken when the route was built, not a
   * live join to `crew_units`. That is the right choice for a payout record:
   * renaming a truck next season must not rewrite what last season's statement
   * said.
   */
  crew?: string | null;
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

/** Sum take-home for rows with a given REPORTED status, rounded to cents. */
export function sumByStatus(rows: EarningRow[], status: string): number {
  const total = rows.reduce((acc, r) => (r.status === status ? acc + r.amount : acc), 0);
  return Math.round(total * 100) / 100;
}

/**
 * EVERYTHING EVER RELEASED TO THIS CREW — including what has since been
 * batched, exported and paid.
 *
 * `sumByStatus(rows, "released")` cannot answer this. It reads the REPORTED
 * status, and `reportedPayoutStatus` overrides a released row the instant it
 * belongs to a batch. So the footer's "$X released so far" went to $0.00 on
 * the night `runMonthlyPayoutBatches` assembled the batch — before a cent had
 * left the bank — on the very screen a crew uses to reconcile against their
 * deposits. The label and the field name both promise a LIFETIME figure.
 *
 * The row's own status is the durable fact: batching writes `batch_id` and
 * nothing else.
 */
export function sumEverReleased(rows: EarningRow[]): number {
  const total = rows.reduce(
    (acc, r) => ((r.rawStatus ?? r.status) === "released" ? acc + r.amount : acc),
    0,
  );
  return Math.round(total * 100) / 100;
}

/**
 * How many JOBS this crew has completed.
 *
 * `rows.length` counted every payout row, and since 0090/0091 that includes a
 * tip, a trip fee for a visit where no work was possible, and a refund
 * clawback — two of which are explicitly NOT completed work. Three real jobs
 * with two tips, a trip fee and a clawback read as "7 completed jobs".
 *
 * `payouts_one_earning_per_job` already makes kind='earning' one row per job,
 * so counting those rows and counting distinct job ids among them are the same
 * number.
 */
export function completedJobCount(rows: EarningRow[]): number {
  return rows.filter((r) => (r.kind ?? "earning") === "earning").length;
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

/**
 * CSV escaping now lives in src/lib/csv.ts, shared with the park receipts and
 * the ACH export.
 *
 * THIS FILE'S VERSION HAD NO FORMULA GUARD. It quoted commas and newlines
 * correctly and stopped there, while both sibling writers prefixed a leading
 * =, + , - or @ so a spreadsheet reads the cell as text. Two of the six columns
 * here are free text somebody else typed — `Property` is the address on the
 * homeowner's property record, and `Crew` is the name the crew tapped into
 * their own roster — and this is the file a crew hands their bookkeeper.
 *
 * Re-exported rather than replaced at every call site so the export route and
 * its tests keep the names they already use.
 */
export { csvCell, csvRow } from "@/lib/csv";

/**
 * WHAT THIS PAYOUT'S STATUS ACTUALLY IS, given the batch it belongs to.
 *
 * Nothing in this codebase ever writes 'queued', 'exported' or 'paid' onto a
 * PAYOUT row — I grepped every writer. settleJob inserts 'released', disputes
 * flip 'held'/'released', refunds write 'clawed'. The money moving is recorded
 * on the BATCH: runMonthlyPayoutBatches and requestEarlyPayout create one and
 * stamp `batch_id` on the rows; the ACH export flips it to 'exported'; ops
 * marks it 'paid'.
 *
 * So the three branches below for queued/exported/paid were unreachable, and a
 * crew who had ALREADY BEEN PAID still read "In the next month-end payout" —
 * on their screen, on the statement they print, and in the CSV their
 * bookkeeper opens. Deriving it here rather than denormalising a second copy
 * onto the payout row means the two can never disagree.
 *
 * The row's own status wins where it is about the ROW rather than the money:
 * a held payout is held whatever its batch says, and a clawed one is clawed.
 */
export function reportedPayoutStatus(rowStatus: string, batchStatus: string | null | undefined): string {
  if (rowStatus === "held" || rowStatus === "clawed" || rowStatus === "pending") return rowStatus;
  if (!batchStatus) return rowStatus;              // not in a batch yet
  if (batchStatus === "paid") return "paid";
  if (batchStatus === "exported") return "exported";
  // 'queued' and 'building' are both "in a payout we are sending" from the
  // crew's side. `building` is a batch that never finished being assembled —
  // see the sweep in automation.ts — and until it is cleaned up the honest
  // thing is to say the money is in flight, not that it is still waiting.
  return "queued";
}

/** Human status label shared by the list, statement, and CSV. */
export function statusLabel(status: string): string {
  // "IN FRIDAY'S PAYOUT" WAS NOT TRUE. `runMonthlyPayoutBatches` gates on
  // `isLastDayOfMonth` — there is no Friday cadence anywhere in the system.
  // Telling a crew the wrong week for their own money is the fastest way to
  // lose one.
  if (status === "released") return "In the next month-end payout";
  if (status === "pending") return "Awaiting release";
  if (status === "held") return "On hold — make-it-right in progress";
  // `refund-core` writes this when a refund claws a payout back. It used to
  // fall through and print the literal word "clawed" — on the crew's earnings
  // screen AND in the CSV that goes to their bookkeeper.
  if (status === "clawed") return "Adjusted — a refund went back to the customer";
  if (status === "paid") return "Paid";
  if (status === "queued" || status === "exported") return "In a payout being sent";
  // Anything genuinely unknown reads as plain English rather than a database
  // value the crew has to guess at.
  return "Being worked out";
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
  // A TRIP FEE AND A TIP ARE NOT JOB PAY, and this is the document a crew's
  // bookkeeper reads. Both used to collapse into 'earning' and print as the
  // job's service name — so a $35 fee for driving to a locked house and a $50
  // thank-you appeared on the statement as ordinary pay for a pier install
  // that never happened. Totals right, classification wrong, on the one
  // artifact where classification is the whole point.
  if (row.kind === "trip") return `Trip fee — ${row.service ?? "visit"} (no work possible)`;
  if (row.kind === "tip") return `Tip from the homeowner — ${row.service ?? "visit"}`;
  return row.service ?? "Service";
}

/** One crew's share of the tips in a period. */
export interface CrewTipShare {
  /** The truck/crew name, or null for tips we cannot attribute. */
  crew: string | null;
  total: number;
  count: number;
  rows: EarningRow[];
}

export interface TipBreakdown {
  byCrew: CrewTipShare[];
  total: number;
  count: number;
  /** Tips we could not attribute to a named crew. Never silently dropped. */
  unattributed: number;
}

/**
 * WHO GETS TIPPED OUT, for one statement period.
 *
 * LakeLife pushes money to a single bank account per company, so every tip
 * lands with the owner regardless of who earned it. Without this breakdown the
 * owner has a lump sum and no way to split it — and the crew who actually got
 * thanked never sees a cent. The whole point of `tipSplit` returning
 * `toLakeLife: 0` is defeated one layer down if the money stops at the office.
 *
 * Unattributed tips are reported SEPARATELY rather than folded into a bucket
 * or dropped. A job that was never routed to a named unit genuinely has no
 * crew on record, and saying "we don't know which crew, here is the job" is
 * the only honest output — the owner can still recognise their own job.
 */
export function tipsByCrew(rows: EarningRow[], range?: DateRange): TipBreakdown {
  const tips = rows.filter(
    (r) => r.kind === "tip" && (!range || withinRange(r.jobDate, range.from, range.to)),
  );

  const buckets = new Map<string, CrewTipShare>();
  for (const r of tips) {
    const name = r.crew ?? null;
    const key = name ?? "\u0000unattributed";
    const b = buckets.get(key) ?? { crew: name, total: 0, count: 0, rows: [] };
    b.total = Math.round((b.total + r.amount) * 100) / 100;
    b.count += 1;
    b.rows.push(r);
    buckets.set(key, b);
  }

  const byCrew = [...buckets.values()].sort((a, b) => {
    // Named crews first, largest share first; the unknown bucket sits last so
    // it reads as a loose end rather than as a crew called "unattributed".
    if ((a.crew == null) !== (b.crew == null)) return a.crew == null ? 1 : -1;
    return b.total - a.total;
  });

  return {
    byCrew,
    total: Math.round(tips.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    count: tips.length,
    unattributed: Math.round(
      tips.filter((r) => !r.crew).reduce((s, r) => s + r.amount, 0) * 100,
    ) / 100,
  };
}
