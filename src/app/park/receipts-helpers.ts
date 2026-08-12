/**
 * WHAT CAME IN, BETWEEN TWO DATES. CASH BASIS.
 *
 * The owner's accountant works on CASH BASIS, so there is exactly one income
 * event in this whole system: a row in `park_payments`, taken at its `amount`,
 * dated its `received_on`. Nothing else is income.
 *
 * Everything this module refuses to do is the point of it:
 *
 *   IT NEVER READS `paid_total`. That column is a trigger-maintained all-time
 *   balance stapled to the month the bill was RAISED. Summing it would date
 *   October's cash to August, which is the exact error cash basis exists to
 *   avoid.
 *
 *   IT NEVER FILTERS ON CHARGE STATUS. A payment against a bill that was later
 *   cancelled is money that is in the bank. The accrual ledger is right to skip
 *   void charges; a cash statement that skipped them would understate income
 *   and nobody would notice.
 *
 *   IT NEVER CLAMPS A RECEIPT TO THE BILL. If somebody pays $500 against a
 *   $455 bill, $500 arrived. The overpayment is reported, not trimmed.
 *
 *   IT NEVER SPLITS A PAYMENT ACROSS THE BILL'S LINES. Deciding how much of a
 *   part-payment was rent and how much was the grounds fee is an accounting
 *   policy nobody has chosen. The bill's own frozen breakdown is carried
 *   through verbatim so the accountant can allocate it however they need.
 *
 *   IT NEVER CONSTRUCTS A Date. Dates are ISO strings and compare as strings.
 *   `new Date("2026-07-01")` is UTC midnight, which in Indiana is the evening
 *   of June 30 — one timezone slip moves income across a tax year.
 *
 * Money is INTEGER CENTS throughout and divided exactly once, at the edge.
 * Two hundred receipts of $455.00 summed as floats is not $91,000.00.
 *
 * WHAT THIS IS NOT: it is not a profit-and-loss. There is no expense side yet
 * (see `park_costs.paid_on`), deposits and refunds cannot be recorded at all,
 * and the screen has to say so out loud. A number that looks complete and
 * isn't is worse than no number.
 */

import { prettyMonth } from "./ledger-helpers";

export type Method = "cash" | "check" | "card" | "ach" | "transfer" | "other";

export const METHOD_LABEL: Record<Method, string> = {
  cash: "Cash",
  check: "Check",
  card: "Card",
  ach: "Bank transfer",
  transfer: "Transfer",
  other: "Other",
};

/** Fixed display order — a report whose rows reshuffle can't be compared. */
const METHOD_ORDER: Method[] = ["check", "cash", "card", "ach", "transfer", "other"];

export interface ChargeLine {
  label: string;
  amountCents: number;
}

export interface Receipt {
  paymentId: string;
  chargeId: string;
  /** Integer cents. */
  amountCents: number;
  method: Method;
  reference: string | null;
  /** YYYY-MM-DD — the day the office took the money. THE cash date. */
  receivedOn: string;
  lotNumber: string;
  payerName: string | null;
  /** The month the BILL was for. Memo only — never used to date the cash. */
  periodMonth: string;
  chargeAmountCents: number;
  chargeStatus: "open" | "paid" | "void";
  /** The bill's frozen breakdown. Carried, never parsed. */
  chargeLines: ChargeLine[];
  /**
   * Taken back — a bounced check, a transposed digit. The row survives with
   * its receipt number; the cash did not.
   */
  reversedAt: string | null;
  reversedReason: string | null;
}

export interface Period {
  key: string;
  label: string;
  /** Inclusive. */
  from: string;
  /** Inclusive. */
  to: string;
  /** True when the window runs to today or beyond — more may still come in. */
  open: boolean;
}

// ------------------------------------------------------------- periods -----

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Last day of a month, by string arithmetic. Leap years included. */
function lastDayOf(year: number, month1: number): string {
  const thirty = [4, 6, 9, 11];
  let d = 31;
  if (thirty.includes(month1)) d = 30;
  else if (month1 === 2) d = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function seal(key: string, label: string, from: string, to: string, todayISO: string): Period {
  return { key, label, from, to, open: to >= todayISO };
}

export function monthPeriod(month: string, todayISO: string): Period | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  // The KEY stays machine-shaped; the LABEL is what goes on the heading of the
  // statement the accountant reads. "Q3 2026" and "2026" were already in
  // words; only the month was still "2026-08".
  return seal(`m-${month}`, prettyMonth(month), `${month}-01`, lastDayOf(y, m), todayISO);
}

export function quarterPeriod(year: number, q: 1 | 2 | 3 | 4, todayISO: string): Period {
  const startM = (q - 1) * 3 + 1;
  const endM = startM + 2;
  return seal(
    `q-${year}-${q}`,
    `Q${q} ${year}`,
    `${year}-${String(startM).padStart(2, "0")}-01`,
    lastDayOf(year, endM),
    todayISO,
  );
}

export function yearPeriod(year: number, todayISO: string): Period {
  return seal(`y-${year}`, String(year), `${year}-01-01`, `${year}-12-31`, todayISO);
}

/** A hand-typed window — used at takeover, e.g. Dec 15 to Dec 31. */
export function customPeriod(from: string, to: string, todayISO: string): Period | null {
  if (!ISO.test(from) || !ISO.test(to) || to < from) return null;
  return seal(`c-${from}-${to}`, `${from} to ${to}`, from, to, todayISO);
}

/** Both ends inclusive. A payment taken on the last day of the month is in it. */
export function inPeriod(r: Receipt, p: Period): boolean {
  return r.receivedOn >= p.from && r.receivedOn <= p.to;
}

// ------------------------------------------------------------- summary -----

export interface Bucket {
  key: string;
  label: string;
  cents: number;
  count: number;
}

export interface ReceiptSummary {
  totalCents: number;
  count: number;
  byMethod: Bucket[];
  byMonth: Bucket[];
  byHousehold: Bucket[];
  /**
   * Cash taken against a bill that was later cancelled. Real income.
   *
   * 0072 makes this impossible to create going forward — a paid bill can no
   * longer be voided, and a payment can't be recorded against a void one. This
   * stays because it is the correct CASH answer for any row that predates that
   * migration or arrives by a path nobody has written yet, and because the day
   * a refund path exists this is where the mismatch will surface.
   */
  againstVoided: Receipt[];
  /**
   * MONEY THAT WAS RECORDED AND THEN TAKEN BACK. Kept out of every total —
   * a bounced check is not income — and reported HERE rather than silently
   * dropped, because a statement that quietly loses a receipt number is
   * exactly what makes an accountant stop trusting the whole file.
   */
  reversed: Receipt[];
  reversedCents: number;
  /** Paid in a different month than the bill was for. Normal; worth counting. */
  otherMonthCount: number;
  /** How much was taken above what was billed. */
  overpaidCents: number;
  /** Earliest and latest cash date actually seen in the window. */
  firstOn: string | null;
  lastOn: string | null;
}

function bump(map: Map<string, Bucket>, key: string, label: string, cents: number) {
  const b = map.get(key) ?? { key, label, cents: 0, count: 0 };
  b.cents += cents;
  b.count += 1;
  map.set(key, b);
}

export function summariseReceipts(all: readonly Receipt[], period: Period): ReceiptSummary {
  const inWindow = all.filter((r) => inPeriod(r, period));

  // A REVERSED PAYMENT IS NOT CASH. It is a check that bounced or a number
  // typed wrong, and counting it as income is how a park pays tax on money it
  // never had. Split out rather than dropped — the receipt number still exists
  // and a statement that quietly loses one is a statement nobody trusts.
  const reversed = inWindow.filter((r) => r.reversedAt != null);
  const reversedCents = reversed.reduce((n, r) => n + r.amountCents, 0);
  const rows = inWindow.filter((r) => r.reversedAt == null);

  const byMethod = new Map<string, Bucket>();
  const byMonth = new Map<string, Bucket>();
  const byHousehold = new Map<string, Bucket>();
  const againstVoided: Receipt[] = [];

  let totalCents = 0;
  let otherMonthCount = 0;
  let overpaidCents = 0;
  let firstOn: string | null = null;
  let lastOn: string | null = null;

  // Overpayment is per BILL, not per payment — two part-payments that together
  // exceed the bill are one overpayment, not two.
  const paidPerCharge = new Map<string, { paid: number; billed: number }>();

  for (const r of rows) {
    totalCents += r.amountCents;
    bump(byMethod, r.method, METHOD_LABEL[r.method] ?? r.method, r.amountCents);
    bump(byMonth, r.receivedOn.slice(0, 7), r.receivedOn.slice(0, 7), r.amountCents);
    bump(byHousehold, r.lotNumber, `Lot ${r.lotNumber}`, r.amountCents);

    if (r.chargeStatus === "void") againstVoided.push(r);
    if (r.receivedOn.slice(0, 7) !== r.periodMonth) otherMonthCount += 1;

    const agg = paidPerCharge.get(r.chargeId) ?? { paid: 0, billed: r.chargeAmountCents };
    agg.paid += r.amountCents;
    paidPerCharge.set(r.chargeId, agg);

    if (firstOn === null || r.receivedOn < firstOn) firstOn = r.receivedOn;
    if (lastOn === null || r.receivedOn > lastOn) lastOn = r.receivedOn;
  }

  for (const { paid, billed } of paidPerCharge.values()) {
    if (paid > billed) overpaidCents += paid - billed;
  }

  return {
    totalCents,
    count: rows.length,
    byMethod: METHOD_ORDER.map((m) => byMethod.get(m)).filter((b): b is Bucket => !!b),
    byMonth: [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byHousehold: [...byHousehold.values()].sort(
      (a, b) => b.cents - a.cents || a.key.localeCompare(b.key, undefined, { numeric: true }),
    ),
    againstVoided,
    reversed,
    reversedCents,
    otherMonthCount,
    overpaidCents,
    firstOn,
    lastOn,
  };
}

// ----------------------------------------------------------- formatting ----

export function money(cents: number): string {
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${neg ? "-" : ""}$${s}`;
}

/** Plain decimal for the file — no currency symbol, no thousands separator. */
export function decimal(cents: number): string {
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/**
 * The line at the top.
 *
 * Says nothing came in rather than "$0.00 received" — a zero that looks like a
 * measurement reads as "the park took nothing", when what it usually means is
 * "nobody has keyed anything in yet".
 */
export function receiptsHeadline(s: ReceiptSummary, period: Period): string {
  if (s.count === 0) {
    return `No money is recorded as coming in between ${period.from} and ${period.to}.`;
  }
  const n = `${s.count} ${s.count === 1 ? "payment" : "payments"}`;
  return `${money(s.totalCents)} came in — ${n}.`;
}

// ------------------------------------------------------------- the file ----

/**
 * One cell.
 *
 * A leading =, +, - or @ makes Excel and Sheets treat the cell as a FORMULA.
 * A payer called "-Smith" or a check reference somebody typed oddly would
 * execute rather than display, so anything starting with one is prefixed with a
 * single quote first, and then quoted normally.
 */
export function csvText(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/["\n\r,]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** The bill's frozen breakdown, in one cell, unparsed. */
export function linesCell(lines: readonly ChargeLine[]): string {
  return lines.map((l) => `${l.label}: ${decimal(l.amountCents)}`).join("; ");
}

const HEADERS = [
  "Park", "Generated at", "Basis",
  "Date received", "Amount", "Method", "Reference",
  "Lot", "Payer", "Bill month", "Bill total", "Bill status", "Bill breakdown",
  "Payment ID", "Charge ID",
] as const;

/**
 * One row per payment, and nothing else.
 *
 * No trailing total row and no metadata header block: a ragged tail breaks the
 * pivot table this file exists to be dropped into. Park and generated-at are
 * constant COLUMNS instead, so they survive being forwarded, re-sorted or
 * pasted into a bigger sheet.
 */
export function receiptsCsv(
  rows: readonly Receipt[],
  meta: { parkName: string; generatedAt: string },
): string {
  const out: string[] = [HEADERS.map(csvText).join(",")];
  for (const r of rows) {
    out.push([
      csvText(meta.parkName),
      csvText(meta.generatedAt),
      csvText("cash"),
      csvText(r.receivedOn),
      csvText(decimal(r.amountCents)),
      csvText(METHOD_LABEL[r.method] ?? r.method),
      csvText(r.reference),
      csvText(r.lotNumber),
      csvText(r.payerName),
      csvText(r.periodMonth),
      csvText(decimal(r.chargeAmountCents)),
      csvText(r.chargeStatus === "void" ? "CANCELLED" : r.chargeStatus),
      csvText(linesCell(r.chargeLines)),
      csvText(r.paymentId),
      csvText(r.chargeId),
    ].join(","));
  }
  return out.join("\r\n");
}

export function receiptsFilename(parkName: string, period: Period): string {
  const slug = parkName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "park";
  return `${slug}-receipts-${period.from}-to-${period.to}${period.open ? "-partial" : ""}.csv`;
}

// --------------------------------------------------- what it does NOT say --

export interface ExclusionContext {
  /** Earliest payment ever recorded for this park; null when none. */
  recordsBeginOn: string | null;
  lagDays: number;
  /** Fees configured but never billed — money the accountant might expect. */
  unbilledFeeLabels: string[];
  anyMissingPayerName: boolean;
}

/**
 * The sentences the screen must say out loud.
 *
 * Every one of these is a hole a reader would otherwise fill in with an
 * assumption. The dangerous assumption is that a tidy total is a complete one —
 * so the page names what is missing in the owner's own vocabulary, and does it
 * next to the number rather than in a footnote.
 */
export function exclusionLines(ctx: ExclusionContext): string[] {
  const lines: string[] = [
    "This is money RECEIVED between these dates — not money billed. A bill you raised in August and got paid for in October counts in October.",
    "Expenses aren't in here. What you've spent isn't recorded with a date-paid yet, so give your accountant your bank and card statements for the outgoings.",
    "Deposits and refunds aren't in here either — there's nowhere in the system to record them yet.",
    "This is the day your office took the money, not the day it cleared the bank. A check taken at the end of a month may clear in the next one.",
    "Payments aren't split between rent and fees. Each one sits against a whole bill, and the file carries that bill's own breakdown so your accountant can split it.",
  ];
  if (ctx.lagDays > 0) {
    lines.push(
      `Anything handed over in the last few days may not be keyed in yet — your office runs about ${ctx.lagDays} days behind.`,
    );
  }
  if (ctx.anyMissingPayerName) {
    lines.push("Some households have no name on the roll, so the file identifies those by lot number.");
  }
  for (const label of ctx.unbilledFeeLabels) {
    lines.push(`Your ${label} is set up but has never been billed, so there's no money for it here.`);
  }
  return lines;
}
