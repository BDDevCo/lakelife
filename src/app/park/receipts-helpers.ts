import { lakeDateOf } from "@/lib/booking";
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
import { csvCell as csvText } from "@/lib/csv";

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
  /** Integer cents. RENT ONLY — never includes the card fee below. */
  amountCents: number;
  /**
   * THE CARD CONVENIENCE FEE CHARGED ON TOP, in cents. 0 for every other rail.
   *
   * Required, not optional: 0109 wrote this column and NOTHING read it, so a
   * resident's card was debited `amount + fee` while every screen, receipt and
   * CPA statement showed `amount`. The processor deposits one number and the
   * books carried another. Making it required means no future constructor can
   * quietly drop it again.
   *
   * It is never added to amountCents, never bucketed by method, and never
   * counted toward what a household has paid — it is not rent and it is not the
   * park's money. It is reported BESIDE the total so the file reconciles.
   */
  feeCents: number;
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
  /**
   * THE BANK PULLED IT BACK — an ACH return or a card chargeback (0155).
   *
   * NOT a second name for `reversedAt`, and the distinction is forced by the
   * database rather than chosen here: since 0142 a card or ACH payment CANNOT
   * be reversed, because the money genuinely moved. So every chargeback and
   * every ACH return in this product's future arrives on this field and on no
   * other — and until it existed, the statement had no way to represent the
   * single most likely way money leaves again once ACH is live.
   *
   * An accountant needs both words. A reversal says the payment was never
   * real; a return says it was real, and then it was not. Both are excluded
   * from every total, which is the part that matters for tax.
   */
  bankReturnedAt: string | null;
  /** The processor's own code for the return — R01, R02, R10. Free text. */
  returnCode: string | null;
}

/**
 * Money that was recorded and then did not stay, by either route.
 *
 * One place, because the alternative is `reversedAt` checked in six places
 * and `bankReturnedAt` remembered in four of them — which is how this file
 * came to exclude bounced cheques from the totals and would have gone on
 * counting bounced ACH debits as income.
 */
export function notCollectedAt(r: Receipt): string | null {
  return r.reversedAt ?? r.bankReturnedAt;
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
  /**
   * CARD FEES COLLECTED IN THIS WINDOW, in cents. Deliberately outside
   * `totalCents` and outside every bucket — the by-method rows must still sum
   * to the total, or the statement stops reconciling against itself.
   */
  cardFeesCents: number;
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
   * MONEY THAT WAS RECORDED AND THEN TAKEN BACK, by either route — an office
   * reversal (a bounced cheque, a transposed digit) or a bank return (an ACH
   * that came back, a chargeback). Kept out of every total, because neither
   * is income, and reported HERE rather than silently dropped: a statement
   * that quietly loses a receipt number is exactly what makes an accountant
   * stop trusting the whole file.
   *
   * The two are distinguishable per row — `reversedAt` vs `bankReturnedAt` —
   * and the CSV prints them in separate columns. They are pooled here because
   * the accountant's question at this level is one question: how much of what
   * arrived did not stay?
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
  // BOTH ROUTES, or the file overstates income by exactly the ACH that
  // bounced. `notCollectedAt` is the single place that decides.
  const reversed = inWindow.filter((r) => notCollectedAt(r) != null);
  const reversedCents = reversed.reduce((n, r) => n + r.amountCents, 0);
  const rows = inWindow.filter((r) => notCollectedAt(r) == null);

  const byMethod = new Map<string, Bucket>();
  const byMonth = new Map<string, Bucket>();
  const byHousehold = new Map<string, Bucket>();
  const againstVoided: Receipt[] = [];

  let totalCents = 0;
  let cardFeesCents = 0;
  let otherMonthCount = 0;
  let overpaidCents = 0;
  let firstOn: string | null = null;
  let lastOn: string | null = null;

  // Overpayment is per BILL, not per payment — two part-payments that together
  // exceed the bill are one overpayment, not two.
  const paidPerCharge = new Map<string, { paid: number; billed: number }>();

  for (const r of rows) {
    totalCents += r.amountCents;
    // Accumulated here, after reversed rows were partitioned out above: a fee
    // on a bounced payment came back too. Kept out of totalCents on purpose.
    cardFeesCents += r.feeCents;
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
    cardFeesCents,
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
 * One cell — now src/lib/csv.ts, shared with the crew's earnings file and the
 * ACH export, which had drifted apart in three different directions.
 *
 * This copy was the closest to right, and still guarded NEGATIVE NUMBERS:
 * `decimal()` returns "-45.00" for a negative, and the old rule prefixed it to
 * `'-45.00`, which imports as text. Every amount in this file goes through
 * `decimal`. The shared version exempts a well-formed decimal and guards
 * everything else, so "-Smith" is still quoted and -45.00 stays a number.
 */
export { csvText };

/** The bill's frozen breakdown, in one cell, unparsed. */
export function linesCell(lines: readonly ChargeLine[]): string {
  return lines.map((l) => `${l.label}: ${decimal(l.amountCents)}`).join("; ");
}

/**
 * Money the park received that is not rent against a bill: a deposit, money on
 * account, or income from something the park rents out.
 *
 * It is deliberately outside the rent total — a deposit is not income and
 * on-account money has not been applied to anything yet — but it DID hit the
 * bank, so it has to be in the file or the file cannot be reconciled.
 */
export interface OtherReceipt {
  paymentId: string;
  kind: string;
  receivedOn: string;
  amountCents: number;
  feeCents: number;
  method: string;
  reference: string | null;
}

/** What a person calls each kind, for the Kind column. */
const KIND_LABEL: Record<string, string> = {
  deposit: "Deposit (not income)",
  amenity: "Rented out (income)",
  rent: "Rent",
};

const HEADERS = [
  "Park", "Generated at", "Basis",
  // THE COLUMN THAT MAKES THE FILE ADD UP TO THE BANK.
  //
  // Every row used to be rent against a bill, and the deposits, on-account
  // money and amenity income were reported ONLY as sentences on the screen —
  // which the CSV writer never receives. Summing Amount therefore came up
  // short by exactly that money, and the amenity part of it is real, taxable
  // park income that appeared in no book anywhere. Naming the kind on every
  // row is what lets an accountant both tie the total to the bank AND keep
  // deposits out of income, which is the distinction that actually matters.
  "Kind",
  "Date received", "Amount", "Card fee", "Charged total", "Method", "Reference",
  // THE COLUMN WITHOUT WHICH THIS FILE OVERSTATES INCOME.
  //
  // The screen excludes reversed payments from every total and says so out
  // loud — "It is NOT counted in the totals above". The FILE was built from a
  // date filter alone, so a bounced cheque was in it, with its amount in the
  // Amount column and nothing anywhere marking it. The owner forwards the file
  // believing it matches the screen he just read; the accountant sums Amount
  // and books money the park never had. That is the exact error this module's
  // own header warns about.
  //
  // The row STAYS and is marked, rather than being dropped: receipt numbers
  // run in a sequence, and a file with a hole in it is a file an auditor has
  // to ask about.
  //
  // WIDENED RATHER THAN DUPLICATED. There are now two ways money does not
  // stay — an office reversal and a bank return (0155) — and the obvious move
  // was a second set of columns beside these. That would have been the same
  // bug again: an accountant who filters "Taken back = YES", exactly as this
  // column was designed to be filtered, would get the right answer for
  // bounced cheques and silently book every returned ACH as income. So the
  // column keeps its meaning — this did not stay — and covers both routes.
  //
  // "How" is separate because the two reconcile differently: a bank return
  // appears on the bank statement as a second line, an office correction
  // never touches the bank at all.
  "Taken back", "Taken back how", "Taken back on", "Reason",
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
  other: readonly OtherReceipt[],
  meta: { parkName: string; generatedAt: string },
): string {
  const out: string[] = [HEADERS.map(csvText).join(",")];
  for (const r of rows) {
    out.push([
      csvText(meta.parkName),
      csvText(meta.generatedAt),
      csvText("cash"),
      csvText("Rent"),
      csvText(r.receivedOn),
      csvText(decimal(r.amountCents)),
      // Both, because an accountant reconciling to a bank statement needs the
      // figure that actually left the resident's card, and the park's income
      // needs the figure that did not include the fee.
      csvText(decimal(r.feeCents)),
      csvText(decimal(r.amountCents + r.feeCents)),
      csvText(METHOD_LABEL[r.method] ?? r.method),
      csvText(r.reference),
      // "YES" rather than a date alone, so it survives a spreadsheet filter and
      // is legible to somebody scanning the column rather than reading rows.
      csvText(notCollectedAt(r) ? "YES" : ""),
      // Which route, because they reconcile against different documents.
      csvText(r.bankReturnedAt ? "bank return" : r.reversedAt ? "office correction" : ""),
      // Lake-local, like `receivedOn` and the period bounds beside it. Sliced
      // from UTC, a reversal recorded at 7:30pm on 31 Dec printed 2027-01-01 —
      // a date outside the very window the statement was generated for.
      csvText(notCollectedAt(r) ? lakeDateOf(String(notCollectedAt(r))) ?? "" : ""),
      // The bank's own code is the reason for a return, and it is the thing
      // the crew or resident has to act on. An office reversal carries the
      // words somebody typed.
      csvText(
        r.bankReturnedAt
          ? (r.returnCode ?? "returned by the bank")
          : r.reversedAt
            ? (r.reversedReason ?? "")
            : "",
      ),
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

  // The bill columns are EMPTY for these, not zero: a deposit has no bill, and
  // a zero would be a figure somebody could sum.
  for (const o of other) {
    out.push([
      csvText(meta.parkName),
      csvText(meta.generatedAt),
      csvText("cash"),
      csvText(KIND_LABEL[o.kind] ?? "On account (not yet applied)"),
      csvText(o.receivedOn),
      csvText(decimal(o.amountCents)),
      csvText(decimal(o.feeCents)),
      csvText(decimal(o.amountCents + o.feeCents)),
      csvText(METHOD_LABEL[o.method as Method] ?? o.method),
      csvText(o.reference ?? ""),
      // taken back / how / on / reason. FOUR, matching HEADERS. This list is
      // hand-counted against a list in another function, so adding a column
      // there silently shifts every cell after this point in these rows — a
      // payment ID landing under "Bill status". The width assertion in the
      // test file is what makes that impossible rather than merely unlikely.
      csvText(""), csvText(""), csvText(""), csvText(""),
      csvText(""), csvText(""),                // lot / payer
      csvText(""), csvText(""), csvText(""), csvText(""),  // bill month/total/status/breakdown
      csvText(o.paymentId),
      csvText(""),                             // no charge to point at
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
  /**
   * CASH THAT CAME IN BUT IS NOT RENT RECEIVED, in cents, for this period.
   *
   * Both are real money that hit the bank and neither belongs in a rent-received
   * figure: a deposit is a liability that goes back, and money on account has
   * not been applied to any bill. Stated rather than silently dropped —
   * otherwise this statement cannot be reconciled against a bank statement, and
   * the first person to notice is an accountant a year later.
   */
  depositsReceivedCents?: number;
  onAccountReceivedCents?: number;
  /**
   * CARD FEES COLLECTED, in cents. Money that hit the processor on top of the
   * rent and is not the park's income — it covers the cost of the rail. Named
   * for the same reason deposits are: without it, this statement cannot be
   * reconciled against a bank deposit, and the person who notices is an
   * accountant a year later.
   */
  cardFeesReceivedCents?: number;
  /**
   * WHAT THE PARK EARNED RENTING ITS OWN THINGS — the boat, the pavilion, a
   * cart. Real income, and NOT rent, so it is named rather than folded into a
   * rent total or mislabelled "on account".
   */
  amenityReceivedCents?: number;
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
    // WAS: "Deposits and refunds aren't in here either — there's nowhere in
    // the system to record them yet." That stopped being true the day deposits
    // could be recorded, and a statement carrying a stale disclaimer is worse
    // than one carrying none.
    "Deposits and money held on account aren't counted as rent received — a deposit goes back, and money on account hasn't been put against a bill yet. Any amounts are listed below so this still reconciles to your bank.",
    "This is the day your office took the money, not the day it cleared the bank. A check taken at the end of a month may clear in the next one.",
    "Payments aren't split between rent and fees. Each one sits against a whole bill, and the file carries that bill's own breakdown so your accountant can split it.",
  ];
  const dep = ctx.depositsReceivedCents ?? 0;
  const acct = ctx.onAccountReceivedCents ?? 0;
  if (dep > 0 || acct > 0) {
    const bits: string[] = [];
    if (dep > 0) bits.push(`$${(dep / 100).toFixed(2)} in deposits taken`);
    if (acct > 0) bits.push(`$${(acct / 100).toFixed(2)} received on account`);
    lines.push(
      `Also received in this period, and NOT in the total above: ${bits.join(" and ")}. ` +
      `It reached the bank; it just isn't rent yet.`,
    );
  }
  const amenity = ctx.amenityReceivedCents ?? 0;
  if (amenity > 0) {
    lines.push(
      `Also received: $${(amenity / 100).toFixed(2)} for things you rent out — the boat, the pavilion and so on. ` +
      `That IS your income, but it is not rent, so it sits outside the total above and should be its own line in your books.`,
    );
  }
  const fees = ctx.cardFeesReceivedCents ?? 0;
  if (fees > 0) {
    lines.push(
      `Residents also paid $${(fees / 100).toFixed(2)} in card fees on top of their rent. ` +
      `That is NOT in the total above and it is not your income — it covers what the card costs. ` +
      `Your bank deposits will be higher than this total by that amount.`,
    );
  }
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
