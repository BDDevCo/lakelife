/**
 * WHAT CAN STILL GO BACK, AND WHAT TO SAY WHEN NOTHING CAN.
 *
 * Pulled out of `refundParkPayment` so the arithmetic is testable without a
 * database. Money maths that only runs inside a server action is money maths
 * nobody can check.
 */

/** Only the parts of a payment a refund decision depends on. */
export interface RefundablePayment {
  amount: number | null;
  /** The card surcharge, charged ON TOP of amount (0109). Null when none. */
  fee_amount: number | null;
  method: string | null;
  reference: string | null;
  reversed_at: string | null;
  /**
   * The bank pulled this money back. NOT `returned_on`, which is a security
   * deposit handed back to a departing tenant (0102) — the two names are one
   * letter apart and mean opposite things, so they are never both read here.
   *
   * Optional because the guard that actually holds is 0155's, inside
   * `guard_park_refund`. This is the sentence a person reads instead of a
   * constraint name, and it only reaches them once `refundableOn` selects the
   * column — until then it is undefined and this test is simply skipped.
   */
  returned_at?: string | null;
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
    return `That was paid by ${pay.method ?? "hand"}, so there is no card to send it back to — hand it back at the office and reverse the record instead.`;
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
    return `That's more than is left on this payment — at most $${left.amount.toFixed(2)} can still go back.`;
  }
  if (!feeIsNumber || feeAmount < 0) {
    return "The card fee to return has to be a number, or nothing.";
  }
  if (round2(feeAmount) > left.fee) {
    return left.fee > 0
      ? `Only $${left.fee.toFixed(2)} of card fee is left to return.`
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
export function refundSignal(amount: number, feeAmount: number, hasCharge: boolean): string {
  // A FEE-ONLY REFUND IS NOT "$0.00 PLUS $12.00". That sentence reads as a bug
  // to the person who just pressed the button, and it is the one they will
  // quote to the household. Say what actually went back.
  const what =
    amount <= 0
      ? `$${feeAmount.toFixed(2)} card fee`
      : `$${amount.toFixed(2)}${feeAmount > 0 ? ` plus $${feeAmount.toFixed(2)} of card fee` : ""}`;
  // AND THE BILL DID NOT MOVE. `recompute_charge_paid` subtracts
  // `park_refunds.amount` — the rent — and never the surcharge, because the
  // surcharge was never in `paid_total` to begin with (0109). So a fee-only
  // refund leaves the balance exactly where it was, and saying otherwise sends
  // the office looking for a number that did not change.
  if (amount <= 0) {
    return `${what} sent back to their card. The rent on it is untouched, and the record shows why.`;
  }
  return (
    `${what} sent back to their card. ` +
    (hasCharge
      ? "The bill is outstanding again by that much, and the record shows why."
      : "It's off the household's account, and the record shows why.")
  );
}
