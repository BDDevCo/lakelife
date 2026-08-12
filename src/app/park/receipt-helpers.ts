/**
 * RECEIPTS AND DROP SLIPS — proof that goes to the person who paid.
 *
 * The ledger's structural flaw is that a payment is a two-party event recorded
 * by one party. Claims and the `disputed` state mitigate that AFTER it goes
 * wrong. This is the part that stops it going wrong: the renter walks away
 * holding something.
 *
 * TWO MOMENTS, TWO ARTEFACTS.
 *
 *   A RECEIPT is for money handed to a person. It carries a number from the
 *   park's own book, so a gap in the sequence is visible — that is the whole
 *   reason receipt books are numbered, and it is worth more than any wording.
 *
 *   A DROP SLIP is for money put in a box when nobody is there, which is what
 *   this park will actually have. It is printed BEFORE the payment, in two
 *   halves with the same serial: one goes in the box with the money, one stays
 *   in their pocket. No phone, no account, no app — which matters because the
 *   households most exposed to an unrecorded cash drop are exactly the ones who
 *   will never use software.
 *
 * NEITHER IS A PROMISE THAT MONEY CLEARED. A receipt for a check is a receipt
 * for a piece of paper; it can still bounce. The copy says so, because a
 * receipt that overstates itself is worse than none.
 */

import { prettyMonth } from "./ledger-helpers";

export interface ReceiptLines {
  parkName: string;
  officeLine: string;
  receiptNo: number | null;
  lotNumber: string;
  payerName: string | null;
  amount: number;
  method: string;
  reference: string | null;
  receivedOn: string;
  /** The month the bill was for. */
  periodMonth: string;
  billAmount: number;
  /** What is left on that bill AFTER this payment. */
  balanceAfter: number;
  /**
   * Where the renter confirms this from their OWN phone.
   *
   * Null on the printed copy for a household with no way to open a link — the
   * counterfoil they sign is their confirmation instead. Printing a URL nobody
   * can type is worse than printing nothing.
   */
  confirmUrl?: string | null;
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const METHOD_WORD: Record<string, string> = {
  cash: "cash", check: "check", card: "card",
  ach: "bank transfer", transfer: "transfer", other: "other",
};

/** A human-quotable reference: park initials, year, receipt number. */
export function receiptRef(parkName: string, receiptNo: number | null, receivedOn: string): string {
  if (receiptNo == null) return "—";
  const initials = parkName
    .split(/\s+/).filter(Boolean).slice(0, 3)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "P";
  return `${initials}-${receivedOn.slice(0, 4)}-${String(receiptNo).padStart(4, "0")}`;
}

/**
 * The receipt itself.
 *
 * Says what was taken, for which bill, and what is left — because "what's left"
 * is the question they actually have, and a receipt that omits it sends them
 * back to the office to ask.
 */
export function receiptBody(r: ReceiptLines): string {
  const who = r.payerName?.split(",")[0].trim() || `Lot ${r.lotNumber}`;
  const lines = [
    `${r.parkName} — receipt ${receiptRef(r.parkName, r.receiptNo, r.receivedOn)}`,
    ``,
    `Received from   ${who}`,
    `Lot             ${r.lotNumber}`,
    `Amount          ${money(r.amount)}`,
    `How             ${METHOD_WORD[r.method] ?? r.method}${r.reference ? ` ${r.reference}` : ""}`,
    `Date taken      ${r.receivedOn}`,
    `Against         ${prettyMonth(r.periodMonth)} rent — ${money(r.billAmount)}`,
  ];

  if (r.balanceAfter > 0) {
    lines.push(`Still owing     ${money(r.balanceAfter)}`);
  } else if (r.balanceAfter < 0) {
    lines.push(`In credit       ${money(-r.balanceAfter)}`);
  } else {
    lines.push(`Balance         nothing further owing on this one`);
  }

  lines.push(``);
  // A receipt for a check is a receipt for a piece of paper. Saying so here is
  // what stops it being read as a guarantee later.
  if (r.method === "check") {
    lines.push(`This is a receipt for the check itself. If it doesn't clear, the`);
    lines.push(`bill goes back to outstanding and we'll be in touch.`);
    lines.push(``);
  }
  lines.push(r.officeLine);
  lines.push(``);
  if (r.confirmUrl) {
    // The renter's own act, from their own phone. The park cannot perform it,
    // which is the whole reason it is worth anything.
    lines.push(`Does this match what you handed over? Say so here:`);
    lines.push(r.confirmUrl);
    lines.push(``);
  }
  lines.push(`Keep this. It's your record of what you handed over.`);
  return lines.join("\n");
}

/**
 * The half the office keeps, with the renter's signature on it.
 *
 * For the quarter to a third of this park who cannot open a link, THIS is the
 * second party's act: their own hand, on a numbered document, at the moment.
 * Printed alongside their copy so both exist or neither does.
 */
export function receiptCounterfoil(r: ReceiptLines): string {
  const who = r.payerName?.split(",")[0].trim() || `Lot ${r.lotNumber}`;
  return [
    `${r.parkName} — office copy  ·  ${receiptRef(r.parkName, r.receiptNo, r.receivedOn)}`,
    ``,
    `Lot ${r.lotNumber}   ${who}   ${money(r.amount)}   ${METHOD_WORD[r.method] ?? r.method}`,
    `Taken ${r.receivedOn}${r.reference ? `   ref ${r.reference}` : ""}`,
    ``,
    `I received a receipt for this and it matches what I handed over.`,
    ``,
    `Signed ______________________________  Date ______________`,
    ``,
    `Keep this in the lot's file. It is the renter's own confirmation for`,
    `anyone who can't tap a link.`,
  ].join("\n");
}

// ------------------------------------------------------------ drop slips ---

export interface DropSlip {
  serial: string;
  parkName: string;
}

/**
 * Serials for a printed sheet.
 *
 * A slip is only evidence because its number was issued once. `from` comes from
 * the park's own counter, which the print advances — so reprinting a sheet
 * never re-issues a serial.
 */
export function dropSlipSerials(parkName: string, from: number, count: number): DropSlip[] {
  const initials = parkName
    .split(/\s+/).filter(Boolean).slice(0, 3)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "P";
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    parkName,
    serial: `${initials}-${String(from + i).padStart(5, "0")}`,
  }));
}

/**
 * One half of a slip, as plain text.
 *
 * Deliberately blank fields rather than pre-filled ones: the slip is printed
 * before anybody knows who will use it, and a stack by the box that anyone can
 * pick up is the only version that works for a household with no account.
 */
export function dropSlipHalf(
  slip: DropSlip,
  half: "box" | "keep",
  officeLine: string,
): string {
  return [
    `${slip.parkName} — rent drop  ·  ${slip.serial}`,
    half === "box" ? `PUT THIS IN THE BOX WITH THE MONEY` : `KEEP THIS — it's your proof`,
    ``,
    `Lot ______________   Name ____________________`,
    ``,
    `Date ____________    Amount $ ________________`,
    ``,
    `Cash [  ]   Check [  ]  number ______________`,
    ``,
    half === "keep"
      ? `If this isn't credited to you, bring this slip in. ${officeLine}`
      : officeLine,
  ].join("\n");
}

/** What the owner is told before printing a sheet. */
export function dropSlipSummary(from: number, count: number): string {
  if (count <= 0) return "Nothing to print.";
  const to = from + count - 1;
  return (
    `${count} slips, numbered ${from} to ${to}. ` +
    `Printing these uses those numbers up — the next sheet starts at ${to + 1}, ` +
    `so no two people can ever hold the same serial.`
  );
}
