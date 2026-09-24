/**
 * THE CREW SETS THE PRICE — the arithmetic, and nothing else.
 *
 * Brendon, 23 September 2026: "Lake life doesnt set the pricing, crew does
 * still... crew prices 2 acre yard at $50, we add on 12% to the home owner and
 * take 12% from the Crew... I do not want lakelife setting the pricing for
 * crews, that doesnt make us 3rd part enough."
 *
 * He is buying a POSTURE, not margin. The counsel draft's independent-
 * contractor paragraph opens "Crews independently set rate cards"
 * (docs/user-agreement-counsel-draft-v2.txt), and who sets the price is one of
 * the facts a worker-classification test weighs hardest. A LakeLife menu price
 * falsifies that sentence; a published percentage on top of a number the crew
 * chose does not.
 *
 * THE THREE NUMBERS, AND WHY THEY ARE DERIVED RATHER THAN STORED:
 *
 *   q             the crew's own quote, from the crew's own rate card
 *   customerPrice round2(q × (1 + customerPct))   what the customer is billed
 *   crewPayout    round2(q × (1 − crewPct))       what we actually pay the crew
 *   platformTake  customerPrice − crewPayout      what LakeLife keeps
 *
 * `platformTake` is NEVER computed as round2(q × (c + k)). Rounding it on its
 * own is how the three stop tying: the customer's invoice, the crew's payout
 * and the ledger would each be right to the cent and wrong against each other
 * by a cent, forever, on every job. It is the difference of the two ROUNDED
 * ends by construction, so customerPrice − crewPayout === platformTake is an
 * identity and not a hope.
 *
 * CENTS ARE CARRIED ON PURPOSE. $416 at 12/12 is $465.92, not $466: the
 * percentage is now published to BOTH sides of the transaction, and a crew
 * with a calculator who is told "12%" and paid a rounded number learns that
 * the stated fee is not the fee. Rounding is Math.round(x × 100) / 100, which
 * is what the rest of this codebase does with money (automation.ts, pricing.ts)
 * — a second rounding convention in a money path is a bug with a schedule.
 *
 * LAKELIFE'S SHARE IS A CONSTANT. (c + k) / (1 + c) — 21.43% at 12/12, on
 * every job, forever, whatever the crew charges. That fact retires the margin
 * floor on this path (see dispatch.ts): a floor that is the same number for
 * every crew is not a filter, it is a global on/off switch.
 *
 * NO IMPORTS. This file is pure arithmetic so it can be called from a server
 * action, a screen, a test and a migration's worth of reasoning without
 * dragging the app in behind it.
 */

/** The two dials, frozen onto a job at booking so a later tune never reprices sold work. */
export interface PlatformFee {
  /** Added on top of the crew's quote to make the customer's price. 0.12 = 12%. */
  customerPct: number;
  /** Taken out of the crew's quote to make their payout. 0.12 = 12%. */
  crewPct: number;
}

/**
 * House money rounding: half-up to cents, the same as everywhere else.
 *
 * EXPORTED so that a caller adding one of these numbers to another — an
 * accepted add-on joining the visit it belongs to (0180) — repairs float
 * subtraction with THIS convention rather than inventing a second one. The
 * file's own comment says why that matters: a second rounding convention in a
 * money path is a bug with a schedule.
 */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A quote we cannot price is ZERO, not a guess.
 *
 * Non-finite (a failed read arriving as NaN) and negative both land here. Zero
 * is already the platform's word for "this has no price": dispatch refuses a
 * crew whose rate is not strictly positive, and every booking surface treats a
 * $0 price as not-bookable. Inventing a number here would be the opposite of
 * the house rule — an unpriced service is the SAFE state.
 */
function usableQuote(crewQuote: number): number {
  return Number.isFinite(crewQuote) && crewQuote > 0 ? crewQuote : 0;
}

/**
 * A FEE OUT OF BAND IS LOUD, NOT SILENT.
 *
 * The only producer of a PlatformFee is `getPlatformSettings`, which clamps
 * both dials to [0, 0.5]. So anything outside [0, 1) reaching here is a
 * hand-built object or a bug — and the specific bug that matters is crewPct of
 * 1.0, which pays a real contractor exactly $0 for a day's work and produces
 * a payout row that looks deliberate. Refusing it here means the clamp and
 * this function have to BOTH fail before anybody works for nothing.
 */
function assertFee(fee: PlatformFee): void {
  for (const [name, pct] of [["customerPct", fee?.customerPct], ["crewPct", fee?.crewPct]] as const) {
    if (!Number.isFinite(pct as number) || (pct as number) < 0 || (pct as number) >= 1) {
      throw new RangeError(
        `platform fee ${name} is ${String(pct)} — it must be a fraction in [0, 1); 0.12 means 12%`,
      );
    }
  }
}

/** What the customer is billed for a crew's quote. */
export function customerPrice(crewQuote: number, fee: PlatformFee): number {
  assertFee(fee);
  return round2(usableQuote(crewQuote) * (1 + fee.customerPct));
}

/** What the crew is actually paid for their own quote. */
export function crewPayout(crewQuote: number, fee: PlatformFee): number {
  assertFee(fee);
  return round2(usableQuote(crewQuote) * (1 - fee.crewPct));
}

/**
 * What LakeLife keeps. DERIVED from the two rounded ends so all three tie.
 *
 * The round2 here repairs float subtraction (465.92 − 366.08 lands on
 * 99.83999999999997), it is not a second rounding of the fee: both inputs are
 * already whole cents, so this can only ever return their exact difference.
 */
export function platformTake(crewQuote: number, fee: PlatformFee): number {
  return round2(customerPrice(crewQuote, fee) - crewPayout(crewQuote, fee));
}

/**
 * LakeLife's constant share of the customer's bill: (c + k) / (1 + c).
 *
 * 21.43% at 12/12. It does not depend on the quote — that is the whole point,
 * and it is why a per-crew margin test has nothing left to compare.
 */
export function platformTakePct(fee: PlatformFee): number {
  assertFee(fee);
  return (fee.customerPct + fee.crewPct) / (1 + fee.customerPct);
}

/**
 * The three numbers at once, for a screen or a snapshot.
 *
 * Every crew-facing surface must print BOTH ends of this in plain words. Today
 * a crew types $100 and is paid $100; under this model they type $100 and are
 * paid $88 — same column, same screen, opposite meaning. A silent deduction on
 * a contractor's invoice is the worst outcome available here, so the breakdown
 * is returned whole rather than leaving each screen to do its own subtraction.
 */
export function quoteBreakdown(crewQuote: number, fee: PlatformFee): {
  crewQuote: number;
  customerPrice: number;
  crewPayout: number;
  platformTake: number;
} {
  const q = usableQuote(crewQuote);
  const customer = customerPrice(q, fee);
  const crew = crewPayout(q, fee);
  return {
    crewQuote: q,
    customerPrice: customer,
    crewPayout: crew,
    platformTake: round2(customer - crew),
  };
}
