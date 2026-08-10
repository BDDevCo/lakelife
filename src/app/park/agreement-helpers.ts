/**
 * AGREEMENTS THAT END, AND RENEWALS THAT CHAIN.
 *
 * The Haven's rule: no stay runs longer than three months. Somebody may stay
 * as long as they like, but each further period is a NEW three-month agreement
 * executed on its own — and if the periods are CONSECUTIVE, no second deposit
 * is collected.
 *
 * Three things follow from that, and they are the whole of this file:
 *
 *   1. An agreement's end is computed from its start and the park's cap, with
 *      real month arithmetic. Not 90 days. Dec 15 → Mar 15.
 *   2. A renewal is a SUCCESSOR, not a wider date range. Widening would erase
 *      the discrete signed period the structure exists to create.
 *   3. CONSECUTIVE is a precise thing — the next agreement starts the day the
 *      last one ends — and it is the only thing that carries a deposit
 *      forward. A gap means they left, and coming back is a new chain.
 */

/**
 * Add whole months, clamping to the end of the target month.
 *
 * Jan 31 + 1 month is Feb 28, not Mar 3. Naive date arithmetic rolls over and
 * would quietly hand somebody three extra days on a lot — and, at renewal
 * time, drift the whole chain later month by month.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

export interface AgreementTerms {
  /** NULL means the park writes agreements of any length. */
  maxAgreementMonths: number | null;
  /** What the park collects once per chain. NULL means none. */
  depositAmount: number | null;
}

/**
 * The end date of an agreement starting on `startISO`.
 *
 * Half-open, matching the database: the tenant is there through the night
 * before this date, and it is checkout morning.
 */
export function agreementEnd(startISO: string, terms: AgreementTerms): string | null {
  if (terms.maxAgreementMonths == null) return null;
  return addMonths(startISO, terms.maxAgreementMonths);
}

export interface PriorAgreement {
  id: string;
  chainId: string;
  seq: number;
  /** Half-open. `end` is checkout morning. */
  start: string;
  end: string;
  quotedAmount: number | null;
  term: string;
}

export type RenewalRefusal =
  | "no_cap"
  | "already_ended"
  | "not_yet_renewable";

export function renewalRefusalText(r: RenewalRefusal): string {
  switch (r) {
    case "no_cap":
      return "This park doesn't write fixed-length agreements, so there's nothing to renew — the stay just continues.";
    case "already_ended":
      return "That agreement has already ended. Start a new one instead — it won't carry the old deposit.";
    case "not_yet_renewable":
      return "It's too early to renew this one.";
  }
}

export interface PlannedRenewal {
  ok: boolean;
  refusal?: RenewalRefusal;
  /** The successor's half-open range. */
  start?: string;
  end?: string;
  /** Same chain when consecutive; a brand-new chain when there was a gap. */
  continuesChain?: boolean;
  nextSeq?: number;
  /**
   * TRUE only when a deposit must actually be collected — which is to say,
   * only when this is NOT a consecutive renewal. This is the owner's rule
   * expressed as one boolean, and the database refuses to record a deposit on
   * a renewal regardless, so the two cannot drift apart.
   */
  depositDue?: boolean;
  depositAmount?: number | null;
  /**
   * How long this person will have held the lot once this agreement runs out,
   * counting the whole chain. The number that makes a two-year residency
   * visible instead of implied.
   */
  totalMonthsAfter?: number;
}

/**
 * Plan the next agreement in a chain.
 *
 * `startFrom` defaults to the prior agreement's end, which is what makes it
 * consecutive. Passing a later date is how somebody comes back after a gap —
 * and that starts a new chain and a new deposit, deliberately.
 */
export function planRenewal(
  prior: PriorAgreement,
  terms: AgreementTerms,
  todayISO: string,
  startFrom?: string,
): PlannedRenewal {
  if (terms.maxAgreementMonths == null) return { ok: false, refusal: "no_cap" };

  const start = startFrom ?? prior.end;
  const end = addMonths(start, terms.maxAgreementMonths);

  // CONSECUTIVE means the next one begins the morning the last one ends. Not
  // "close to"; not "within a few days". A gap is a period during which the
  // lot was theirs to lose, and the deposit went back.
  const continuesChain = start === prior.end;

  // A chain that already lapsed cannot be continued — that is a fresh start,
  // and the honest answer is to say so rather than quietly re-open it.
  if (!continuesChain && start < prior.end) {
    return { ok: false, refusal: "not_yet_renewable" };
  }
  if (!continuesChain && todayISO > prior.end && startFrom === undefined) {
    return { ok: false, refusal: "already_ended" };
  }

  const months = terms.maxAgreementMonths;
  const priorMonths = continuesChain ? prior.seq * months : 0;

  return {
    ok: true,
    start,
    end,
    continuesChain,
    nextSeq: continuesChain ? prior.seq + 1 : 1,
    // The whole point: consecutive costs nothing extra.
    depositDue: !continuesChain && terms.depositAmount != null && terms.depositAmount > 0,
    depositAmount: continuesChain ? null : terms.depositAmount,
    totalMonthsAfter: priorMonths + months,
  };
}

/**
 * What to say about a chain that has been going a while.
 *
 * Returns null for a short chain, because a first renewal needs no commentary.
 * Past a year of consecutive short agreements it says so plainly — not to
 * advise, but because the length of a chain is a fact the owner should be
 * looking at, and it is exactly what a court would look at too.
 */
export const LONG_CHAIN_MONTHS = 12;

export function chainNotice(totalMonths: number): string | null {
  if (totalMonths < LONG_CHAIN_MONTHS) return null;
  const years = Math.floor(totalMonths / 12);
  const rest = totalMonths % 12;
  const span = years >= 1
    ? `${years} year${years === 1 ? "" : "s"}${rest ? ` and ${rest} month${rest === 1 ? "" : "s"}` : ""}`
    : `${totalMonths} months`;
  return (
    `By the end of this one they'll have held the lot for ${span} on back-to-back ` +
    `agreements. Worth knowing — a long unbroken run can be treated differently ` +
    `from a short stay, whatever each agreement says. Ask your attorney how they ` +
    `want these handled.`
  );
}
