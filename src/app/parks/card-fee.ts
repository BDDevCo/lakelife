/**
 * WHAT A CARD PAYMENT COSTS THE RESIDENT — THE ONE PLACE THAT DECIDES.
 *
 * A park may add a percentage to rent paid by card (`parks.card_fee_pct`,
 * 0109). The Haven has it set to 3.00 and `accepts_online_rent` true, which is
 * the owner's decision and stays his.
 *
 * WHAT IS NOT HIS TO DECIDE IS WHICH CARDS IT MAY TOUCH. Surcharging a DEBIT
 * card is forbidden by the card networks at any rate, in every state — the
 * owner's own processor brief (docs/processor-questions.md) says so, and
 * `onlineRentCautions` has been telling him so on the setup screen since 0109.
 * Until now the software could only warn: `payment_methods` recorded a brand
 * and no funding type, so every card was surcharged alike. The day
 * LAKELIFE_PAYMENTS_LIVE is set, every debit payment at The Haven becomes a
 * network-rule violation.
 *
 * THE ASYMMETRY THAT SETS THE DEFAULT. A surcharge that should not have been
 * applied is a rule violation and a refund the product cannot make (0142: a
 * card payment is never reversed, it is a separate outbound leg). A surcharge
 * that should have been applied and was not is lost margin on one bill. So
 * anything we cannot positively identify as CREDIT is charged nothing extra —
 * 'debit', 'prepaid' and 'unknown' alike.
 *
 * 'unknown' is the state of every card on file today, and it stays that way
 * until the real tokenize adapter reports a funding type. That is the point:
 * the safe answer is the one that needs no processor.
 */

export const CARD_FUNDINGS = ["credit", "debit", "prepaid", "unknown"] as const;
export type CardFunding = (typeof CARD_FUNDINGS)[number];

/**
 * Whatever the column holds, said in one of four words.
 *
 * A processor that starts sending "Credit", or a value nobody has taught this
 * function, must not fall through to the surchargeable answer — so anything
 * unrecognised is 'unknown', which surcharges nothing.
 */
export function normaliseFunding(raw: unknown): CardFunding {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (CARD_FUNDINGS as readonly string[]).includes(v) ? (v as CardFunding) : "unknown";
}

/** Only a credit card. This is the whole rule. */
export function mayBeSurcharged(funding: unknown): boolean {
  return normaliseFunding(funding) === "credit";
}

/**
 * The percentage that may actually be added to THIS card, given the park's
 * dial. Both doors — the screen that discloses the fee and the action that
 * charges it — go through here, so a resident cannot be quoted one number and
 * billed another.
 *
 * The park's rate is passed through untouched when it applies. It is capped on
 * the way in (`buildOnlineRentRow`, and 0116's CHECK); re-clamping it here
 * would quietly edit his dial, which is not this function's business.
 */
export function surchargePct(parkFeePct: unknown, funding: unknown): number {
  if (!mayBeSurcharged(funding)) return 0;
  const pct = Number(parkFeePct ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return pct;
}

/**
 * The fee in WHOLE CENTS, rounded once.
 *
 * Money reaches the processor as an integer number of cents and is rounded a
 * single time on the way. Rounding dollars, adding, then converting rounds
 * twice and drifts a cent on exactly the kind of number rent is made of.
 */
export function cardFeeCents(owedCents: number, pct: number): number {
  if (!Number.isInteger(owedCents) || owedCents <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.round((owedCents * pct) / 100);
}
