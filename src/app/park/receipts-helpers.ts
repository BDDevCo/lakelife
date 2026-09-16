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
 * (see `park_costs.paid_on`), and the screen has to say so out loud. Deposits,
 * money on account and refunds to a card ARE recorded (0102, 0142) and are
 * carried as their own rows beside the rent. A number that looks complete and
 * isn't is worse than no number.
 */

import { prettyMonth } from "./ledger-helpers";
import { longDate } from "@/lib/lake-time";
import { csvCell as csvText } from "@/lib/csv";

export type Method = "cash" | "check" | "card" | "ach" | "transfer" | "other";

/**
 * SAME ROW, ONE NAME. The resident's receipt calls `transfer` a "bank
 * transfer" (receipt-helpers METHOD_WORD); this called it "Transfer" and
 * reserved "Bank transfer" for processor `ach`, so the accountant's statement
 * and the resident's receipt named the same row two ways. Both are a bank
 * transfer; what differs is who recorded it — the processor, or the office
 * seeing it land in the park's own account — and the label says which.
 */
export const METHOD_LABEL: Record<Method, string> = {
  cash: "Cash",
  check: "Check",
  card: "Card",
  ach: "Bank transfer (processor)",
  transfer: "Bank transfer (to the park)",
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
export function notCollectedAt(r: Pick<Receipt, "reversedAt" | "bankReturnedAt">): string | null {
  return r.reversedAt ?? r.bankReturnedAt;
}

/** The four fields that say whether, when and why a payment did not stay. */
export type TakenBack = Pick<Receipt, "reversedAt" | "reversedReason" | "bankReturnedAt" | "returnCode">;

/**
 * WHY IT DID NOT STAY, in the words the record carries: the bank's own code
 * for a return (or "returned by the bank" when it gave none — the code is
 * the thing somebody has to act on), the office's typed reason for a
 * reversal. Null while the payment stands, or when a reversal carries no
 * reason.
 *
 * ONE WRITER. This derivation existed four times — the file's Reason cell,
 * the statement screen's "and then taken back: …", the resident's home
 * screen and her /paid link — each a copy of the last, and the screen copy
 * reimplemented the cell it could have read. Every reader of these four
 * fields now says the same words, or says nothing.
 */
export function takenBackWhy(r: TakenBack): string | null {
  if (r.bankReturnedAt) return r.returnCode ?? "returned by the bank";
  if (r.reversedAt) return r.reversedReason ?? null;
  return null;
}

/**
 * The same four fields off a `park_payments` row as supabase-js hands it —
 * so a loader that reads snake_case columns can ask `takenBackWhy` and
 * `notCollectedAt` without spelling the rule out again. `returned_at` is the
 * BANK pulling a settled payment back; `returned_on` (a deposit or rent on
 * account handed back across the window) is a different act and is not
 * read here.
 */
export function takenBackOfRow(p: {
  reversed_at?: unknown; reversed_reason?: unknown; returned_at?: unknown; return_code?: unknown;
}): TakenBack {
  return {
    reversedAt: (p.reversed_at as string | null) ?? null,
    reversedReason: (p.reversed_reason as string | null) ?? null,
    bankReturnedAt: (p.returned_at as string | null) ?? null,
    returnCode: (p.return_code as string | null) ?? null,
  };
}

/**
 * THE FOUR "TAKEN BACK" CELLS, for any row that can be taken back — rent
 * against a bill, or the deposit / on-account / amenity rows beside it. One
 * writer, because the second row-writer used to pad these with four blanks by
 * hand, so a bounced on-account cheque printed as money that stayed.
 *
 * "YES" rather than a date alone, so it survives a spreadsheet filter and is
 * legible to somebody scanning the column rather than reading rows. "How" is
 * separate because the two routes reconcile differently: a bank return is a
 * second line on the bank statement, an office correction never touches it.
 * The date is lake-local, like `receivedOn` beside it — sliced from UTC, a
 * reversal recorded at 7:30pm on 31 Dec printed 2027-01-01, outside the very
 * window the statement was generated for.
 */
export function takenBackCells(r: TakenBack): [string, string, string, string] {
  return [
    notCollectedAt(r) ? "YES" : "",
    r.bankReturnedAt ? "bank return" : r.reversedAt ? "office correction" : "",
    notCollectedAt(r) ? lakeDateOf(String(notCollectedAt(r))) ?? "" : "",
    // The one derivation of the reason — the screen reads the same helper.
    takenBackWhy(r) ?? "",
  ];
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
   * migration or arrives by a path nobody has written yet. A refund to a card
   * (0142) is its own row in `otherReceipts`, kind "refund", dated the day the
   * money went back — so a payment against a cancelled bill that was then
   * refunded shows here AND as a negative row, and the two tie to the bank.
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
    return `No money is recorded as coming in between ${longDate(period.from)} and ${longDate(period.to)}.`;
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
 * account, or income from something the park rents out — and money that went
 * back OUT: to a card through the processor (kind "refund", 0142) or across
 * the window by a person (kind "handed_back" — a deposit's return since
 * 0102, rent on account since 0168). Both NEGATIVE.
 *
 * It is deliberately outside the rent total — a deposit is not income and
 * on-account money has not been applied to anything yet — but it DID hit the
 * bank, so it has to be in the file or the file cannot be reconciled.
 *
 * MONEY GOING OUT IS ITS OWN ROW, NOT A COLUMN ON THE PAYMENT. Money
 * received stays the row it was; a correction is a new row. A refund or a
 * hand-back is dated the day it went back, carries a negative Amount (and a
 * negative Card fee when a surcharge went back with a refund), the
 * processor's reference — or, for a hand-back, the office's reason — and
 * the household, so the Amount column still adds up to the bank and the
 * original receipt is untouched. `paymentId` on either is the PAYMENT it
 * came off, which is how the accountant ties the two. Until this row
 * existed a $500 deposit received in December and given back by park
 * cheque in February was, in February's file, nothing.
 */
export interface OtherReceipt {
  paymentId: string;
  kind: string;
  receivedOn: string;
  amountCents: number;
  feeCents: number;
  method: string;
  reference: string | null;
  /**
   * THE HOUSEHOLD, when the row carries one. Every on-account row and every
   * deposit is somebody's money; the file printed both cells blank, so the
   * accountant tying cheque 2101 to a household ledger had nothing. Null when
   * the record genuinely names nobody (an amenity guest with no file).
   */
  payerName: string | null;
  /**
   * THE LOT THE HOUSEHOLD IS ON — their link covering today, else the next to
   * start, else any live one, else the one they most recently LEFT: the
   * accountant tying cheque 2101 to a lot ledger in April for a household
   * gone in February still gets the lot it was for. Only when they hold no
   * link at all does it fall back to the lot of the bills the money was put
   * against, and null (a cheque at signing, nothing applied yet) prints as
   * nothing rather than "?".
   */
  lotNumber: string | null;
  /**
   * TAKEN BACK, by either route — the same four fields as `Receipt`, REQUIRED
   * so no constructor can quietly drop them: the off-book read used to filter
   * reversed and returned rows out, so a bounced quarter-ahead cheque left the
   * file with no row, no note and a hole in the receipt-number sequence, while
   * the same cheque against a bill was kept and marked. Kept out of every
   * total; kept IN the file, marked, like a rent row.
   */
  reversedAt: string | null;
  reversedReason: string | null;
  bankReturnedAt: string | null;
  returnCode: string | null;
  /**
   * WHERE MONEY ON ACCOUNT HAS SINCE GONE (0167): which bill months it was put
   * against, and how much to each. Cash basis is untouched — the row is still
   * dated `receivedOn` and counted once — but the accountant can now tie
   * "$1,627.59 received 28 December" to January, February and March instead
   * of carrying it as unapplied forever. Absent or empty for a deposit, for
   * amenity money, and for on-account money nothing has touched yet.
   */
  appliedTo?: Array<{ periodMonth: string; amountCents: number }>;
  /**
   * WHAT IS STILL HELD of an on-account row — the view's `remaining`
   * (park_payment_remaining: amount − live allocations − refunds), never
   * amount − applied here. Absent for a deposit and for amenity money, and
   * when the loader did not look; present (possibly 0) whenever
   * `appliedTo` is. A row with nothing applied and nothing held has gone
   * back to a card.
   */
  remainingCents?: number;
}

/** What a person calls each kind, for the Kind column. */
const KIND_LABEL: Record<string, string> = {
  deposit: "Deposit (not income)",
  amenity: "Rented out (income)",
  rent: "Rent",
  // Money that went back OUT through the processor (0142). Negative Amount,
  // dated the day it went back — the Kind that lets an accountant filter the
  // outflows and still sum the column to the bank.
  refund: "Refund (given back)",
  // Money that went back OUT across the window — a deposit returned, rent on
  // account handed back (0168). The same shape as a refund: negative, dated
  // the day it went back, tied to the payment it came off.
  handed_back: "Handed back (given back)",
};

/** The same kinds once the money did not stay — a filterable word, never "not yet applied" about a bounced cheque. */
const KIND_TAKEN_BACK: Record<string, string> = {
  deposit: "Deposit (taken back)",
  amenity: "Rented out (taken back)",
};

/** Deposits, amenity income, refunds and hand-backs are never "on account"; everything else is. */
export function isOnAccountRow(o: Pick<OtherReceipt, "kind">): boolean {
  return !(o.kind in KIND_LABEL) || o.kind === "rent";
}

/**
 * The Kind an on-account row prints, by how much of it has been applied. A
 * filterable label, so "not yet applied" still finds exactly the money the
 * office has yet to put anywhere.
 *
 * TAKEN BACK FIRST. A reversed or bank-returned row has nothing applied and
 * nothing held, and "not yet applied" would send the office looking for
 * money to apply; "given back" would say it went back to a card. It was
 * taken back, and the label says so.
 */
export function onAccountKindLabel(o: OtherReceipt): string {
  if (notCollectedAt(o)) return "On account (taken back)";
  const applied = (o.appliedTo ?? []).reduce((s, a) => s + a.amountCents, 0);
  // "Applied" means nothing is left — the view's word when the loader
  // carried it, so a row with $57.47 refunded and the rest on bills is
  // "applied", not "partly", and one with nothing applied and nothing held
  // is not "not yet applied" (it went back). Without the figure, applied vs
  // amount is the only test available and is right for every row a hand-
  // keyed door writes.
  const held = o.remainingCents;
  if (applied <= 0) return held === 0 ? "On account (given back)" : "On account (not yet applied)";
  if (held != null ? held === 0 : applied >= o.amountCents) return "On account (applied)";
  return "On account (partly applied)";
}

/** The Kind cell for ANY off-book row — one place, so the screen and the file cannot disagree. */
export function otherKindLabel(o: OtherReceipt): string {
  if (isOnAccountRow(o)) return onAccountKindLabel(o);
  if (notCollectedAt(o)) return KIND_TAKEN_BACK[o.kind] ?? `${KIND_LABEL[o.kind]} (taken back)`;
  return KIND_LABEL[o.kind];
}

/** "2027-01: 542.53; 2027-02: 542.53" — the months an on-account row settled, for the Bill month cell. */
export function appliedToCell(o: OtherReceipt): string {
  return [...(o.appliedTo ?? [])]
    .filter((a) => a.amountCents > 0)
    .sort((a, b) => a.periodMonth.localeCompare(b.periodMonth))
    .map((a) => `${a.periodMonth}: ${decimal(a.amountCents)}`)
    .join("; ");
}

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
      // Taken back / how / on / reason — the one writer, shared with the
      // billless rows below.
      ...takenBackCells(r).map(csvText),
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
  // a zero would be a figure somebody could sum. The one exception is the
  // Bill month cell of money on account that has since been put against
  // bills (0167): it names the months and the split, so the accountant can
  // tie December's cheque to the quarter it paid for.
  //
  // A REFUND OR HAND-BACK ROW is negative in Amount, Card fee and Charged
  // total — csvCell passes a well-formed "-542.53" through as a number
  // (lib/csv) — and its Payment ID is the payment it came off, so the two
  // rows tie. A hand-back's Reference cell is the office's reason.
  for (const o of other) {
    const isOnAccount = isOnAccountRow(o);
    out.push([
      csvText(meta.parkName),
      csvText(meta.generatedAt),
      csvText("cash"),
      csvText(otherKindLabel(o)),
      csvText(o.receivedOn),
      csvText(decimal(o.amountCents)),
      csvText(decimal(o.feeCents)),
      csvText(decimal(o.amountCents + o.feeCents)),
      csvText(METHOD_LABEL[o.method as Method] ?? o.method),
      csvText(o.reference ?? ""),
      // Taken back / how / on / reason — the SAME writer as the rent rows.
      // These used to be four hand-counted blanks, which is how a bounced
      // on-account cheque printed as money that stayed. The width assertion
      // in the test file keeps both branches as wide as HEADERS.
      ...takenBackCells(o).map(csvText),
      csvText(o.lotNumber ?? ""), csvText(o.payerName ?? ""),
      csvText(isOnAccount ? appliedToCell(o) : ""),        // bill month: where on-account money went
      csvText(""), csvText(""), csvText(""),   // bill total/status/breakdown
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
   * OF THE MONEY RECEIVED ON ACCOUNT IN THIS WINDOW, how much has since been
   * put against bills (0167). Still not "rent received" — cash basis counts
   * it once, on the day it arrived, under on-account — but the sentence must
   * not say "hasn't been put against a bill" about money that has.
   */
  onAccountAppliedCents?: number;
  /**
   * OF THAT SAME MONEY, what is STILL HELD — the sum of the view's
   * `remaining` over the window's on-account rows. The note prints THIS for
   * "is still held", never received − applied: that subtraction ignores a
   * refund and is the second copy of park_payment_remaining this codebase
   * keeps finding as a bug. Absent when the loader did not read it, and then
   * no held figure is printed at all.
   */
  onAccountHeldCents?: number;
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
  /**
   * DEPOSITS, MONEY ON ACCOUNT AND AMENITY MONEY received in this window and
   * SINCE TAKEN BACK — a bounced cheque, an office correction, a bank return
   * — in cents. Not in any figure above (those sum the rows that still
   * stand) and not in `summary.reversed` (that is rent against bills). Said
   * out loud because the rows are kept in the file, marked, and a reader of
   * the note must not sum them.
   */
  otherTakenBackCents?: number;
  /**
   * MONEY SENT BACK TO A CARD in this window (0142), one entry per refund. A
   * refund reduces what the bill counts as paid and what is still held on
   * account, but it is NOT taken off the total above: cash basis counts the
   * money on the day it arrived, and the refund is its own negative row on
   * the day it went back, so the file's Amount column still ties to the bank.
   * The note names each one so the owner is not surprised by a negative
   * line in a file he is about to forward.
   */
  refunds?: Array<{
    amountCents: number;
    feeCents: number;
    /** YYYY-MM-DD, lake-local — the day it went back. */
    refundedOn: string;
    lotNumber: string | null;
    payerName: string | null;
    /** The refunded payment's rail — "card" or "ach" — so the sentence names the right one. */
    method: string;
  }>;
  /**
   * MONEY HANDED BACK ACROSS THE WINDOW in this window, one entry per
   * hand-back — a deposit returned (0102), rent on account handed back
   * (0168). The fourth way money leaves, and the one that needs no processor:
   * a park cheque or cash across a counter. Like a refund it is NOT taken off
   * the total above and IS its own negative row in the file, dated the day it
   * went back; the note names each so the negative line is no surprise.
   */
  handedBack?: Array<{
    amountCents: number;
    /** YYYY-MM-DD — the day the office handed it back. */
    on: string;
    lotNumber: string | null;
    payerName: string | null;
    /** What the money was — "deposit" or "rent" (on account). */
    kind: string;
    /** The office's reason, when the record carries one. */
    note: string | null;
  }>;
}

/** "a card", "cards", "a bank account", "bank accounts", or "cards and bank accounts" — whichever rails the refunds went back on. */
function refundRails(methods: readonly string[]): string {
  const ach = methods.filter((m) => m === "ach").length;
  const card = methods.length - ach;
  if (ach > 0 && card > 0) return "cards and bank accounts";
  if (ach > 0) return ach === 1 ? "a bank account" : "bank accounts";
  return card === 1 ? "a card" : "cards";
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
    "Deposits and money held on account aren't counted as rent received — a deposit goes back, and money on account is counted here on the day it arrived, not on the bills it later pays. Any amounts are listed below so this still reconciles to your bank.",
    "This is the day your office took the money, not the day it cleared the bank. A check taken at the end of a month may clear in the next one.",
    "Payments aren't split between rent and fees. Each one sits against a whole bill, and the file carries that bill's own breakdown so your accountant can split it.",
  ];
  const dep = ctx.depositsReceivedCents ?? 0;
  const acct = ctx.onAccountReceivedCents ?? 0;
  const applied = Math.min(acct, ctx.onAccountAppliedCents ?? 0);
  // THE VIEW'S FIGURE, or nothing. `held` is what the database says is still
  // on account; "All of it has gone against bills" is said only when the
  // database says nothing is held AND the applied lines cover what came in —
  // a row refunded in full has nothing held and nothing applied.
  const held = ctx.onAccountHeldCents;
  if (dep > 0 || acct > 0) {
    const bits: string[] = [];
    if (dep > 0) bits.push(`${money(dep)} in deposits taken`);
    if (acct > 0) bits.push(`${money(acct)} received on account`);
    lines.push(
      `Also received in this period, and NOT in the total above: ${bits.join(" and ")}. ` +
      `It reached the bank; it just isn't rent yet.` +
      // WHERE IT HAS GONE SINCE. Money paid ahead settles bills the run raises
      // later; the file's Bill month column names them per row.
      (applied > 0
        ? held === 0 && applied >= acct
          ? ` All of the money on account has since been put against bills — the file says which months.`
          : ` ${money(applied)} of the money on account has since been put against bills — the file says which months` +
            (held == null
              ? `.`
              : held > 0
                ? ` — and ${money(held)} is still held.`
                : ` — and none of it is still held.`)
        : ""),
    );
  }
  // MONEY THAT ARRIVED IN THIS WINDOW AS A DEPOSIT, ON ACCOUNT OR FOR AN
  // AMENITY AND THEN DID NOT STAY. The rows are in the file, marked "Taken
  // back", and in none of the figures above — the same judgement the rent
  // rows get. Named so the receipt numbers do not look like a hole.
  const gone = ctx.otherTakenBackCents ?? 0;
  if (gone > 0) {
    lines.push(
      // Every off-book kind — a bank-returned amenity card is in this figure too.
      `${money(gone)} that arrived in this period as a deposit, on account or for something you rent out was later taken back — a bounced check, a correction, or the bank pulling it back. ` +
      `It reached the bank and went back out, so it counts toward nothing above. ` +
      `Each of those rows is still in the file, marked "Taken back", so the receipt numbers run without a gap.`,
    );
  }
  const amenity = ctx.amenityReceivedCents ?? 0;
  if (amenity > 0) {
    lines.push(
      `Also received: ${money(amenity)} for things you rent out — the boat, the pavilion and so on. ` +
      `That IS your income, but it is not rent, so it sits outside the total above and should be its own line in your books.`,
    );
  }
  // MONEY THAT WENT BACK OUT TO A CARD (0142). Not taken off the total —
  // cash basis counts what arrived on the day it arrived — but named one by
  // one, because each is a NEGATIVE line in the file he is about to forward,
  // dated the day it went back, and a negative he was not told about is the
  // line his accountant rings him over.
  const refunds = ctx.refunds ?? [];
  if (refunds.length > 0) {
    const back = refunds.reduce((n, r) => n + r.amountCents, 0);
    const fees = refunds.reduce((n, r) => n + r.feeCents, 0);
    const each = refunds.map((r) => {
      const who = r.lotNumber ? `Lot ${r.lotNumber}` : (r.payerName ?? "a household");
      return `${who} ${money(r.amountCents)} on ${longDate(r.refundedOn)}`;
    });
    lines.push(
      // By rail: 0142 refunds ACH money too, and that goes back to a bank
      // account, not a card.
      `${money(back)} was sent back to ${refundRails(refunds.map((r) => r.method))} in this period — ${each.join("; ")}. ` +
      (fees > 0 ? `${money(fees)} of card fee went back with it. ` : "") +
      `It is NOT taken off the total above: each refund is its own line in the file, dated the day it went back, with a negative amount, so the Amount column still adds up to your bank.`,
    );
  }
  // MONEY HANDED BACK ACROSS THE WINDOW — a deposit returned, rent on account
  // handed back to a household that has left. No processor, no bank line of
  // its own until the park's cheque clears; the record is the stamp on the
  // payment (returned_on). The same treatment as a refund: not taken off the
  // total, its own negative line in the file on the day it went back, named
  // here one by one so the negative is no surprise.
  const handed = ctx.handedBack ?? [];
  if (handed.length > 0) {
    const back = handed.reduce((n, h) => n + h.amountCents, 0);
    const each = handed.map((h) => {
      const who = h.lotNumber ? `Lot ${h.lotNumber}` : (h.payerName ?? "a household");
      const what = h.kind === "deposit" ? "of their deposit" : "of their money on account";
      return `${who} ${money(h.amountCents)} ${what} on ${longDate(h.on)}${h.note ? ` (${h.note})` : ""}`;
    });
    lines.push(
      `${money(back)} was handed back across the window in this period — ${each.join("; ")}. ` +
      `It is NOT taken off the total above: each hand-back is its own line in the file, dated the day it went back, with a negative amount, so the Amount column still adds up to your bank.`,
    );
  }
  const fees = ctx.cardFeesReceivedCents ?? 0;
  if (fees > 0) {
    lines.push(
      `Residents also paid ${money(fees)} in card fees on top of what they paid — on rent, on money on account, or for things you rent out. ` +
      `That is NOT in the total above and it is not your income — it covers what the card costs. ` +
      `It reached the bank, and the file carries it row by row in the Card fee column.`,
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
