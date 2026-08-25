/**
 * WHAT ONE HOUSEHOLD OWES THIS MONTH.
 *
 * Everything built so far describes money — a rent, a grounds fee, an
 * agreement, a cost. This is the piece that adds them into a single number a
 * person is actually asked for, and it is the first thing in the park module
 * that a resident will ever read closely.
 *
 * SO IT SHOWS ITS WORKING. Every line says what it is and how it was arrived
 * at: "$400 rent", "$55 grounds fee", "12 of 31 days". A total with no
 * breakdown is a number people argue with; a breakdown is a number they check
 * once and then trust.
 *
 * BILLING IS MONTHLY, ON THE PARK'S DUE DAY. That is separate from the
 * AGREEMENT, which is the legal wrapper around the stay — a month-to-month
 * agreement running the 15th to the 15th is still billed on the 1st. Conflating
 * the two would produce a bill on a date nobody expects.
 *
 * WHAT IT REFUSES TO DO:
 *
 *   NEVER TREAT A MISSING RENT AS ZERO. A tenancy with no amount set produces
 *   a statement that SAYS the rent is not set, and no total. Billing somebody
 *   $55 because their $400 was never entered is worse than billing nothing.
 *
 *   NEVER CHARGE FOR DAYS THEY WERE NOT THERE. A tenancy starting on the 20th
 *   owes 12 of 31 days, not a month. The park may well decide otherwise, but
 *   that has to be a decision somebody makes rather than an accident of the
 *   arithmetic.
 */

import type { DateRange } from "@/lib/parks";

export interface StatementLine {
  label: string;
  amount: number;
  /** How it was worked out, in the resident's language. */
  basis: string;
}

export interface Statement {
  /** The calendar month billed, as YYYY-MM. */
  month: string;
  /** When it is due. */
  dueOn: string;
  lines: StatementLine[];
  /** Null when something is missing and no honest total exists. */
  total: number | null;
  /** Days billed of days in the month. Equal when it is a whole month. */
  daysBilled: number;
  daysInMonth: number;
  prorated: boolean;
  /** Why there is no total. Empty when there is one. */
  problems: string[];
}

/**
 * A SHARE OF A COST THE PARK ALREADY PAID — the water bill, the trash bill.
 *
 * Never prorated. A fee is a monthly RATE, so half a month is half of it; a
 * cost share is an amount already worked out for a period that has closed, and
 * cutting it by the days lived would quietly under-recover a bill the park has
 * genuinely paid out.
 */
export interface StatementCostShare {
  label: string;
  amount: number;
  /** "your share of July water" — the reason, in the resident's language. */
  basis: string;
}

export interface StatementFee {
  label: string;
  amount: number;
  /** Only monthly fees land on a monthly statement. */
  cadence: string;
  /** Prorated with the rent when the stay is partial. */
  prorate?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthRange(month: string): DateRange {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, end };
}


/**
 * How many days of this month the tenancy actually covers.
 *
 * Half-open throughout, matching the database: a stay ending on the 1st was
 * not there in that month at all.
 */
export function daysCovered(stay: DateRange, month: string): number {
  const m = monthRange(month);
  const from = stay.start > m.start ? stay.start : m.start;
  const to = stay.end < m.end ? stay.end : m.end;
  if (to <= from) return 0;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export interface StatementInput {
  month: string;
  /** The tenancy's half-open range. */
  stay: DateRange;
  /** What they pay a month. NULL is a problem, never a zero. */
  rent: number | null;
  fees: readonly StatementFee[];
  /** Day of the month rent is due. */
  dueDay: number;
  /**
   * Costs the park paid and is passing on, already allocated to this tenancy.
   * They arrive as lines on the bill rather than as a separate charge, which
   * is both how a park actually bills them and how this sidesteps the
   * one-live-charge-per-month index entirely.
   */
  costShares?: readonly StatementCostShare[];
}

export function buildStatement(input: StatementInput): Statement {
  const { month, stay, rent, fees, dueDay, costShares = [] } = input;

  const total = daysInMonth(month);
  const days = daysCovered(stay, month);
  const prorated = days > 0 && days < total;

  // Clamp the due day to a month that has fewer days — the 31st of February
  // is not a date, and silently rolling into March would move a due date.
  const clamped = `${month}-${String(Math.min(dueDay, total)).padStart(2, "0")}`;

  // AND NEVER BEFORE THE TENANCY EXISTED.
  //
  // The due day is a park dial; the stay's own start never entered this, even
  // though the amount two blocks down is prorated by exactly that start. So a
  // household moving in on 18 February, at a park whose rent is due on the 1st,
  // got a bill for 11 of 28 days dated due 1 February — seventeen days before
  // they lived there. ledgerState then reads it as `late` on the day it is
  // raised, the roll shows them in arrears, and planReminders drafts them an
  // overdue notice on day one. A first impression that is entirely our error.
  //
  // Only ever moves the date LATER, and only within the month, so a sitting
  // tenant's due day is untouched.
  const firstCovered = stay.start > `${month}-01` ? stay.start.slice(0, 10) : clamped;
  const due = days > 0 && firstCovered > clamped ? firstCovered : clamped;

  const base: Statement = {
    month, dueOn: due, lines: [], total: null,
    daysBilled: days, daysInMonth: total, prorated, problems: [],
  };

  if (days === 0) {
    return { ...base, total: 0, problems: [] };
  }

  const share = (amount: number) => round2((amount * days) / total);
  const proratedBasis = `${days} of ${total} days`;

  const lines: StatementLine[] = [];
  const problems: string[] = [];

  if (rent == null) {
    // The whole statement is withheld rather than billed short. A resident
    // asked for $55 when they owe $455 will pay the $55 and consider it done.
    problems.push("No rent is set for this lot, so we can't total this.");
  } else {
    lines.push({
      label: "Lot rent",
      amount: prorated ? share(rent) : round2(rent),
      basis: prorated ? proratedBasis : "for the month",
    });
  }

  // Cost shares first among the extras, because they are the line a resident
  // is most likely to query and they should sit where they can be found.
  for (const c of costShares) {
    lines.push({ label: c.label, amount: round2(c.amount), basis: c.basis });
  }

  for (const f of fees) {
    // A per-stay or one-off fee is not a monthly charge and must not quietly
    // appear every month.
    if (f.cadence !== "monthly") continue;
    // A $0.00 LINE IS NOT A CHARGE, IT IS A QUESTION. `saveFee` now refuses a
    // zero amount, but the database still allows `amount >= 0` and these lines
    // are FROZEN into park_charges.lines the moment the run raises the bill —
    // there is no editing one out afterwards. A resident reading "$0.00" beside
    // a fee name learns nothing and rings the office.
    if (round2(f.amount) === 0) continue;
    const doProrate = prorated && f.prorate !== false;
    lines.push({
      label: f.label,
      amount: doProrate ? share(f.amount) : round2(f.amount),
      basis: doProrate ? proratedBasis : "for the month",
    });
  }

  return {
    ...base,
    lines,
    problems,
    total: problems.length > 0 ? null : round2(lines.reduce((s, l) => s + l.amount, 0)),
  };
}

/**
 * The one line a park owner scans down a roll of twenty.
 *
 * States the PROBLEM rather than a number when there is one — a row reading
 * "$55" beside nineteen reading "$455" looks like a cheap lot, not a missing
 * rent, and that is exactly the kind of error that survives a year.
 */
export function statementLine(s: Statement): string {
  if (s.problems.length > 0) return s.problems[0];
  if (s.total === 0) return "Nothing this month";
  const money = `$${s.total!.toFixed(2)}`;
  return s.prorated
    ? `${money} — part month, ${s.daysBilled} of ${s.daysInMonth} days`
    : money;
}

/** What the whole park is owed this month, and what is not yet answerable. */
export function rollUp(statements: readonly Statement[]): {
  total: number;
  billable: number;
  blocked: number;
} {
  let total = 0;
  let billable = 0;
  let blocked = 0;
  for (const s of statements) {
    if (s.total == null) { blocked += 1; continue; }
    if (s.total > 0) billable += 1;
    total = round2(total + s.total);
  }
  return { total, billable, blocked };
}
