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
import { longDate } from "@/lib/lake-time";
import { describeAllocations, type AllocationLine } from "@/lib/allocations";

export interface ReceiptLines {
  parkName: string;
  officeLine: string;
  receiptNo: number | null;
  lotNumber: string;
  payerName: string | null;
  /** The RENT. Never includes the card fee. */
  amount: number;
  /**
   * The card convenience fee charged on top, or null/0 when there wasn't one.
   *
   * 0109's own header notes that the card networks require a surcharge to be
   * disclosed at the point of sale AND on the receipt. The screen did the first
   * and nothing did the second, because nothing read the column.
   */
  feeAmount?: number | null;
  method: string;
  reference: string | null;
  receivedOn: string;
  /** The month the bill was for. */
  periodMonth: string;
  billAmount: number;
  /** What is left on that bill AFTER this payment. */
  balanceAfter: number;
  /**
   * The part of `amount` that did NOT go against the bill — recorded on
   * account for the household, with its own receipt number, because it was
   * more than the bill had left. Null when everything went against the bill.
   *
   * `appliedTo` and `remaining` say where that money went AT THE MOMENT OF
   * RECORDING (0167, R1): money on account settles the household's oldest
   * open bill as soon as it is keyed, so the paper can read "$542.53 to
   * February 2027, $57.47 on account" before they leave the window. Written
   * at record time by recordOnAccount (its own receipt, kind "on_account")
   * and by recordPayment when the excess settled an older open bill; absent
   * when nothing of it went anywhere, and then all of it is held. Nothing
   * reprints a receipt later. `remaining` is the view's figure and is left
   * out when that read failed — receiptBody then says it wasn't read rather
   * than printing the whole as held.
   */
  onAccount?: {
    amount: number;
    receiptNo: number | null;
    appliedTo?: AllocationLine[];
    remaining?: number;
  } | null;
  /**
   * MONEY OF THEIRS THE OFFICE WAS ALREADY HOLDING, put against this bill
   * beside what they handed over today (0167). Without it "still owing" is a
   * figure the household cannot reconcile to what they paid.
   */
  fromOnAccount?: number | null;
  /**
   * A RECEIPT FOR MONEY ON ACCOUNT ITSELF — a cheque taken before its bill
   * existed, a quarter paid ahead. Built by recordOnAccount (money-actions)
   * and printed by the held-money panel. There is no "Against … rent" line
   * and no bill balance; instead the paper says where the money went the
   * moment it was recorded (`onAccount.appliedTo`) and what is still held.
   * `periodMonth` and `billAmount` are ignored.
   */
  kind?: "bill" | "on_account";
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

// `transfer` is the bank push the OFFICE keys (Zelle, a wire, an online
// transfer to the park's account); `ach` is the same thing done through the
// processor. To the person holding the receipt both are a bank transfer, and
// the form that recorded the first one called it exactly that.
export const METHOD_WORD: Record<string, string> = {
  cash: "cash", check: "check", card: "card",
  ach: "bank transfer", transfer: "bank transfer", other: "other",
};

/**
 * WHAT IS STILL HELD, for the paper. Nothing applied at record time means
 * the whole of it is held — that is not a guess, it is what "nothing
 * applied" means the moment the row is written, and no receipt is printed
 * later. Once something HAS gone somewhere, only the database knows what is
 * left (`remaining`, the view's figure); when that read failed the writer
 * leaves it out, and this returns null so the paper says so rather than
 * printing the whole cheque as held beside a line saying $40 of it is on
 * December. Never `?? amount`.
 */
function stillHeld(
  amount: number,
  acct: { appliedTo?: readonly AllocationLine[]; remaining?: number } | null | undefined,
): number | null {
  const applied = acct?.appliedTo ?? [];
  // The view's figure when the writer read it; the whole when nothing of it
  // has gone anywhere — the one case where that is a fact, not a fallback.
  if (applied.length === 0) return acct?.remaining ?? amount;
  return acct?.remaining ?? null;
}

/** The line printed in place of a held figure nobody read. */
const NOT_READ_LINE = `What's still on account wasn't read when this was printed — ask at the office.`;

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
  ];

  // MONEY ON ACCOUNT, RECEIPTED ON ITS OWN. Where it has gone so far, and
  // what is still held — the whole record on one piece of paper.
  if (r.kind === "on_account") {
    const applied = r.onAccount?.appliedTo ?? [];
    const remaining = stillHeld(r.amount, r.onAccount);
    // Only once something HAS gone somewhere. Fresh from the window the held
    // sentence below is the whole story, and "Where it went: on account" is
    // a line that answers a question nobody asked.
    const where = applied.length > 0 ? describeAllocations(applied, remaining ?? 0) : "";
    lines.push(`How             ${METHOD_WORD[r.method] ?? r.method}${r.reference ? ` ${r.reference}` : ""}`);
    lines.push(`Date taken      ${longDate(r.receivedOn)}`);
    lines.push(`Against         money on account`);
    if (where) lines.push(`Where it went   ${where}`);
    lines.push(``);
    if (remaining == null) {
      lines.push(NOT_READ_LINE);
      lines.push(``);
    } else if (remaining > 0) {
      lines.push(`The ${money(remaining)} on account is held by the office and comes off your next`);
      lines.push(`bill. It stays yours until then.`);
      lines.push(``);
    }
    if (r.method === "check") {
      lines.push(`This is a receipt for the check itself. If it doesn't clear, any bill`);
      lines.push(`it was put against goes back to outstanding and we'll be in touch.`);
      lines.push(``);
    }
    lines.push(r.officeLine);
    lines.push(``);
    if (r.confirmUrl) {
      lines.push(`Does this match what you handed over? Say so here:`);
      lines.push(r.confirmUrl);
      lines.push(``);
    }
    lines.push(`Keep this. It's your record of what you handed over.`);
    return lines.join("\n");
  }

  // MORE THAN THE BILL. Both parts on the paper they keep, because "Amount
  // $600.00 / Against January rent — $542.53" with nothing between them is a
  // receipt that raises the question it exists to answer.
  const acct = r.onAccount && r.onAccount.amount > 0 ? r.onAccount : null;
  if (acct) {
    lines.push(`  to this bill  ${money(r.amount - acct.amount)}`);
    lines.push(`  on account    ${money(acct.amount)}`);
  }
  // AND WHAT THE OFFICE ALREADY HELD, put in beside it.
  const held = r.fromOnAccount && r.fromOnAccount > 0 ? r.fromOnAccount : 0;
  if (held > 0) {
    lines.push(`From on account ${money(held)}`);
  }

  // THE FEE, ON THE RECEIPT, BECAUSE THE NETWORKS REQUIRE IT THERE. Also
  // because a resident holding a card statement for $412 and a receipt for
  // $400 has no way to tell which one is wrong.
  const fee = r.feeAmount ?? 0;
  if (fee > 0) {
    lines.push(`Card fee        ${money(fee)}`);
    lines.push(`Charged total   ${money(r.amount + fee)}`);
  }

  lines.push(
    `How             ${METHOD_WORD[r.method] ?? r.method}${r.reference ? ` ${r.reference}` : ""}`,
    `Date taken      ${longDate(r.receivedOn)}`,
    `Against         ${prettyMonth(r.periodMonth)} rent — ${money(r.billAmount)}`,
  );

  if (fee > 0) {
    // Said in words as well as in the column, so it cannot be read as rent.
    lines.push(``);
    lines.push(`The card fee is what the card costs to accept. It is not rent`);
    lines.push(`and it is not credited against your bill.`);
  }

  if (r.balanceAfter > 0) {
    lines.push(`Still owing     ${money(r.balanceAfter)}`);
  } else if (r.balanceAfter < 0) {
    lines.push(`In credit       ${money(-r.balanceAfter)}`);
  } else {
    lines.push(`Balance         nothing further owing on this one`);
  }

  if (held > 0) {
    // Said in words too, so "$200 handed over, nothing further owing on a
    // $542.53 bill" does not read as a mistake on the only copy they keep.
    lines.push(``);
    lines.push(`${money(held)} you already had on account with the office went against this`);
    lines.push(`bill as well.`);
  }

  if (acct) {
    // WHERE THE REST IS, as of the moment this was written: the run puts
    // money on account against the next bill it raises for them (0167), and
    // the excess may already have settled an older open bill (R1).
    const applied = acct.appliedTo ?? [];
    const remaining = stillHeld(acct.amount, acct);
    lines.push(``);
    if (applied.length > 0) {
      lines.push(`Of the ${money(acct.amount)} on account: ${describeAllocations(applied, remaining ?? 0)}${
        acct.receiptNo != null ? ` (receipt ${receiptRef(r.parkName, acct.receiptNo, r.receivedOn)})` : ""}.`);
      if (remaining == null) {
        lines.push(NOT_READ_LINE);
      } else if (remaining > 0) {
        lines.push(`The ${money(remaining)} still on account comes off your next bill.`);
      }
    } else {
      lines.push(`The ${money(acct.amount)} on account is held by the office and comes off your next`);
      lines.push(`bill. It stays yours until then${
        acct.receiptNo != null ? ` (receipt ${receiptRef(r.parkName, acct.receiptNo, r.receivedOn)})` : ""}.`);
    }
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
    // The signed half must name the figure that actually left their card, or
    // the signature attests to a number their bank never shows.
    `Lot ${r.lotNumber}   ${who}   ${money(r.amount + (r.feeAmount ?? 0))}   ${METHOD_WORD[r.method] ?? r.method}`,
    (r.feeAmount ?? 0) > 0
      ? `Taken ${longDate(r.receivedOn)}   ${money(r.amount)} rent + ${money(r.feeAmount ?? 0)} card fee${r.reference ? `   ref ${r.reference}` : ""}`
      : `Taken ${longDate(r.receivedOn)}${r.reference ? `   ref ${r.reference}` : ""}`,
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
