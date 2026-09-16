/**
 * WHAT CAN STILL GO BACK, AND WHAT TO SAY WHEN NOTHING CAN.
 *
 * Pulled out of `refundParkPayment` so the arithmetic is testable without a
 * database. Money maths that only runs inside a server action is money maths
 * nobody can check.
 */

import { money } from "./ledger-helpers";

/** Only the parts of a payment a refund decision depends on. */
export interface RefundablePayment {
  amount: number | null;
  /** The card surcharge, charged ON TOP of amount (0109). Null when none. */
  fee_amount: number | null;
  method: string | null;
  reference: string | null;
  /**
   * WHAT THE MONEY IS, for the sentence that names the other door. Cash and
   * cheques cannot be refunded through a processor, and the right act for
   * them depends on the row: a deposit goes back from its own line, rent on
   * account (kind 'rent', no charge) is handed back across the window and
   * recorded from its line (0168), and money against a bill has no hand-back
   * at all. REQUIRED, like `returned_at` below and for the same reason: an
   * optional field is a branch that silently never fires. Pinned against
   * refundableOn's select in refund-helpers.test.ts.
   */
  charge_id: string | null;
  kind: string | null;
  reversed_at: string | null;
  /**
   * The bank pulled this money back. NOT `returned_on`, which is a security
   * deposit handed back to a departing tenant (0102) — the two names are one
   * letter apart and mean opposite things, so they are never both read here.
   *
   * REQUIRED, and it used to be optional. Optional meant `refundableOn` could
   * omit it from its select and still compile, which is exactly what happened:
   * the branch below read `undefined`, never fired, and the screen offered
   * "Refund to card" on a payment the bank had already reclaimed. The refusal
   * that actually holds is 0155's `guard_park_refund`, but a person meeting a
   * constraint name instead of a sentence is a defect of its own.
   *
   * `?` on a field a guard reads is how a guard gets switched off silently.
   * The select is pinned in refund-helpers.test.ts.
   */
  returned_at: string | null;
}

/** Only the parts of a refund row the remaining maths depends on. */
export interface RecordedRefund {
  amount: number | null;
  fee_amount: number | null;
}

export interface Remaining {
  /** Rent still sendable back, in dollars. */
  amount: number;
  /** Card surcharge still sendable back, in dollars. */
  fee: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * DERIVED FROM THE ROWS, EVERY TIME.
 *
 * There is deliberately no `refunded_total` column on park_payments. It would
 * be a second answer to a question the refund rows already answer, and the
 * dominant defect in this codebase is exactly that shape: a number some
 * writers keep current and others forget, read by screens that trust it.
 *
 * Clamped at zero on both halves. A negative "remaining" is not a real state,
 * and if one ever arose from bad data it must not read as money owed back to
 * the park.
 */
export function remainingRefundable(
  pay: RefundablePayment,
  given: readonly RecordedRefund[],
): Remaining {
  const paid = Number(pay.amount ?? 0);
  const paidFee = Number(pay.fee_amount ?? 0);
  const back = given.reduce((t, r) => t + Number(r.amount ?? 0), 0);
  const backFee = given.reduce((t, r) => t + Number(r.fee_amount ?? 0), 0);
  return {
    amount: Math.max(0, round2(paid - back)),
    fee: Math.max(0, round2(paidFee - backFee)),
  };
}

/**
 * WHY THIS PAYMENT CANNOT BE REFUNDED, IN A SENTENCE, OR NULL IF IT CAN.
 *
 * Each of these is also enforced by 0142 at the database, which is the guard
 * that actually holds. These exist so a person reads why rather than a
 * constraint name — and the order matters: the most specific true thing first,
 * so "already reversed" never surfaces as "wrong payment method".
 */
export function refundRefusal(pay: RefundablePayment, left: Remaining): string | null {
  // A RETURN IS NOT A REFUND, AND IT COMES FIRST. An ACH debit can succeed and
  // then be pulled back by the bank days later. Refunding it would send the
  // money out a second time, out of the park's own account, against a debit
  // that never settled. 0155's guard refuses the row; this is the sentence.
  if (pay.returned_at) {
    return "The bank took that payment back, so it never settled — there is nothing to send back, and sending it would be the park's own money.";
  }
  if (pay.reversed_at) {
    return "That payment is recorded as never having arrived, so there is nothing to send back.";
  }
  if (pay.method !== "card" && pay.method !== "ach") {
    // NAME THE DOOR THAT EXISTS, NEVER "REVERSE THE RECORD". This used to
    // say "hand it back at the office and reverse the record instead" — and
    // a reversal says the money never arrived: on a split cheque it takes
    // the bill's half back too, and a paid January reads outstanding on
    // every screen for a household that paid it and has gone. The record of
    // money handed across the window is the stamp on the row (0102 for a
    // deposit, 0168 for rent on account), written from that row's own line
    // under "Money not against a bill" on the Rent screen. Money against a
    // bill has no hand-back: it is the bill's money, and the only correction
    // is taking a WRONG record back, with the reason.
    const by = `That was paid by ${pay.method ?? "hand"}, so there is no card to send it back to.`;
    if (pay.kind === "deposit") {
      return `${by} Give it back from its own line under Deposits on the Rent screen — that records the day and the amount.`;
    }
    if (!pay.charge_id) {
      return `${by} Hand it back across the window and record it with "Hand it back" on its line under Money not against a bill, on the Rent screen — never by taking the record back.`;
    }
    return `${by} It is against a bill, so it isn't handed back — if the record is wrong, take it back with the reason.`;
  }
  if (!String(pay.reference ?? "").trim()) {
    // 0108 refuses to record a card payment without one, so this is a payment
    // that predates that rule or arrived some other way. Either way we cannot
    // tell the processor which charge to reverse.
    return "That payment has no processor reference, so we cannot ask the processor to return it. Ring them with the receipt number.";
  }
  // BOTH HALVES, NOT JUST THE RENT. The surcharge is separate money charged on
  // top (0109), so a payment whose rent has all gone back can still owe its fee
  // — and a household surcharged in error on a debit card, which network rules
  // forbid, has nothing else left to be made whole with.
  if (left.amount <= 0 && left.fee <= 0) {
    return "All of that payment has already gone back.";
  }
  return null;
}

/**
 * IS THIS PARTICULAR REFUND ALLOWED? Null when yes.
 *
 * Kept separate from `refundRefusal` because these are about the numbers the
 * office just typed, not about the payment — a person retyping an amount
 * should not be told the payment is unrefundable.
 */
export function refundAmountRefusal(
  amount: number,
  feeAmount: number,
  left: Remaining,
): string | null {
  // ZERO RENT IS A REAL REFUND WHEN THE FEE IS NOT ZERO.
  //
  // A wrongly-applied 3% surcharge is refunded on its own: the rent was right
  // and stays put. The old rule refused any amount of 0, so the only way to
  // return a surcharge was to return rent with it — which would have been a
  // second error, undoing a charge nobody disputed.
  //
  // What stays refused is a refund that moves nothing (both zero) and a
  // NEGATIVE rent, which is a charge wearing a refund's clothes. The finite
  // check on the fee is left to its own rule below, so `0` rent with a
  // mistyped fee is told which field is wrong.
  const feeIsNumber = Number.isFinite(feeAmount);
  if (!Number.isFinite(amount) || amount < 0 || (feeIsNumber && amount + feeAmount <= 0)) {
    return "Enter how much to send back.";
  }
  if (round2(amount) > left.amount) {
    return `That's more than is left on this payment — at most ${money(left.amount)} can still go back.`;
  }
  if (!feeIsNumber || feeAmount < 0) {
    return "The card fee to return has to be a number, or nothing.";
  }
  if (round2(feeAmount) > left.fee) {
    return left.fee > 0
      ? `Only ${money(left.fee)} of card fee is left to return.`
      : "No card fee was charged on that payment, so there is none to return.";
  }
  return null;
}

/**
 * WHAT THE PROCESSOR IS ASKED FOR, IN CENTS.
 *
 * Rent and surcharge left the card as ONE charge — payRent charged
 * `owed + fee` against a single reference — so they come back as one refund.
 * They are separate only on our own row, where the office's decision about the
 * fee has to stay legible.
 */
export function refundCents(amount: number, feeAmount: number): number {
  return Math.round(round2(amount + feeAmount) * 100);
}

/** What the office is told once the money is on its way. */
export function refundSignal(amount: number, feeAmount: number, hasCharge: boolean, method: string | null = null): string {
  // "SENT BACK TO THEIR CARD" WAS SAID OF ACH TOO. The rail is a fact the
  // row carries; the sentence names it rather than assuming the common case.
  const rail = method === "ach" ? "their bank account" : "their card";
  // A FEE-ONLY REFUND IS NOT "$0.00 PLUS $12.00". That sentence reads as a bug
  // to the person who just pressed the button, and it is the one they will
  // quote to the household. Say what actually went back.
  const what =
    amount <= 0
      ? `${money(feeAmount)} card fee`
      : `${money(amount)}${feeAmount > 0 ? ` plus ${money(feeAmount)} of card fee` : ""}`;
  // AND THE BILL DID NOT MOVE. `recompute_charge_paid` subtracts
  // `park_refunds.amount` — the rent — and never the surcharge, because the
  // surcharge was never in `paid_total` to begin with (0109). So a fee-only
  // refund leaves the balance exactly where it was, and saying otherwise sends
  // the office looking for a number that did not change.
  if (amount <= 0) {
    return `${what} sent back to ${rail}. The rent on it is untouched, and the record shows why.`;
  }
  return (
    `${what} sent back to ${rail}. ` +
    (hasCharge
      ? "The bill is outstanding again by that much, and the record shows why."
      : "It's off the household's account, and the record shows why.")
  );
}
