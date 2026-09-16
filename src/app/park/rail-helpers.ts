/**
 * WHICH RAIL THE MONEY CAME IN ON decides which correction is honest.
 *
 * Cash, a cheque, a bank transfer keyed by hand: nothing left anybody's
 * account on our say-so, so the record can be un-made — a reversal. Card and
 * ACH money demonstrably moved through the processor, so the only truthful
 * correction is sending it back — a refund (0142 makes the database refuse
 * the other one, and reversePayment says so in a sentence).
 *
 * ONE PREDICATE, because the rule was in one doorway of three. Statements
 * hid its Take it back on card and ACH rows with an inline test; the held-
 * money panel hid Hand it back the same way two lines above a Take it back
 * it offered on every row — and 0169 put card-paid rows on that panel for
 * the first time, so a control the server always refuses sat on each of
 * them. Every screen that offers a reversal reads this, and nothing else.
 */
export function canReverse(method: string): boolean {
  return method !== "card" && method !== "ach";
}

/**
 * THE RAIL, NAMED AS reversePayment AND guard_park_payment NAME IT — "by
 * card" or "by bank transfer" — for the sentence that stands where the
 * reversal control would have been. Saying "card" about an ACH debit is a
 * sentence wrong in the one word that tells the office where to look. Null
 * for hand-keyed money, which has no rail to name.
 */
export function processorRail(method: string): "by card" | "by bank transfer" | null {
  if (method === "card") return "by card";
  if (method === "ach") return "by bank transfer";
  return null;
}
