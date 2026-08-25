/**
 * THE NIGHTLY READ — what the machine noticed, in sentences.
 *
 * This is the whole automation story at a 21-lot park. It writes nothing to the
 * ledger, sends nothing to a resident, and decides nothing. It reads the roll
 * against the charges against the payments and says what does not line up,
 * because THE ONLY ERROR-DETECTION SURFACE THIS PARK WILL EVER HAVE IS BRENDON
 * READING A SCREEN. There is no bank feed, no processor, no external validator.
 *
 * TWO RULES, AND EVERYTHING ELSE FOLLOWS:
 *
 *   IT ABSTAINS RATHER THAN GUESSES. A lot whose rent nobody has confirmed
 *   produces "I don't know what lot 9 should pay", never a zero. An abstention
 *   still produces a SENTENCE — a silent skip is how nineteen households become
 *   "everything looks fine".
 *
 *   EVERY HEADLINE CARRIES ITS OWN DENOMINATOR. "17 of 21 lots have a rent I
 *   trust" is honest. "$5,200 billed" alone is a claim about a whole park made
 *   from whatever happened to be readable.
 */

import { prettyMonth } from "./ledger-helpers";
import { periodIsBillable } from "@/lib/billing-start";

export type FindingKind =
  | "live_lot_unbilled"
  | "tenancy_expired"
  | "rent_unknown"
  | "claim_ageing"
  | "zero_total_statement";

export interface Finding {
  kind: FindingKind;
  /** Ordering only — the screen decides how loud to be. */
  urgent: boolean;
  line: string;
  lotNumbers: string[];
}

export interface ReconcileInput {
  today: string;
  month: string;
  /** Live lots, and whether each has a tenancy covering today. */
  lots: {
    lotNumber: string;
    occupiedToday: boolean;
    /** Null when nobody ever set a rent — NOT zero. */
    quotedAmount: number | null;
    /** True when a tenancy exists but its range has already ended. */
    tenancyExpired: boolean;
    /** True when this lot has a charge for the current month. */
    billedThisMonth: boolean;
    /** The statement totalled to zero, so the charge run silently dropped it. */
    statementZero: boolean;
  }[];
  /** Unresolved payment claims, with how old they are in days. */
  openClaims: { lotNumber: string; ageDays: number }[];
  /**
   * The day the park changed hands, NOT the month it falls in.
   *
   * In the takeover month the machine never says "late" — the seller collected
   * the first half and the roll is half-entered, so it is a claim this data
   * cannot support.
   *
   * THE DAY MATTERS, which is why this is no longer pre-sliced to a month by
   * the caller. `billing-start.ts` already holds the rule: a go-live on the
   * FIRST is the claim "this whole month is mine to bill", and a month that is
   * wholly ours has no half the seller collected and nothing half-entered. The
   * silence below is for a PART-month, and only the day can tell them apart.
   */
  cutoverDate: string | null;
}

/** Above this many days, a disagreement nobody answered is itself the problem. */
export const CLAIM_STALE_DAYS = 14;

function nameList(lots: string[], max = 4): string {
  const shown = lots.slice(0, max).map((l) => `lot ${l}`);
  if (lots.length <= max) {
    if (shown.length === 1) return shown[0];
    return shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1];
  }
  return `${shown.join(", ")} and ${lots.length - max} more`;
}

export function reconcile(input: ReconcileInput): Finding[] {
  const out: Finding[] = [];
  const { lots, openClaims, month, cutoverDate } = input;

  /**
   * A MONTH WE MAY NOT BILL IS THE ONLY MONTH THIS SILENCE IS FOR.
   *
   * This read `cutoverMonth === month`, which suppressed the alarm for the
   * takeover month WHATEVER DAY the takeover fell on. Set go-live to the first
   * of a month — the supported way to say "this whole month is mine" — and the
   * suppression covered a month that was wholly ours and fully billable.
   *
   * At The Haven that is January 2027: the first month he bills, nineteen
   * occupied lots, and the one night the first-ever charge run is most likely
   * to have been forgotten. `cutoverMonthNote` gives the game away — it calls
   * the month it is explaining "your first PART-month", which a month starting
   * on the 1st is not.
   *
   * `periodIsBillable` is the same function the ledger refuses on, so the
   * reconciler now goes quiet about exactly the months the ledger will not
   * charge for, and about no others.
   */
  const cannotBillThisMonth = !periodIsBillable(month, cutoverDate);

  // SOMEBODY LIVES THERE AND NOBODY IS BILLING THEM. This is the failure with
  // no error anywhere: a lapsed range, a dropped charge, and the money just
  // stops while the household stays put.
  const unbilled = lots.filter((l) => l.occupiedToday && !l.billedThisMonth);
  if (unbilled.length > 0 && !cannotBillThisMonth) {
    const names = unbilled.map((l) => l.lotNumber);
    out.push({
      kind: "live_lot_unbilled",
      urgent: true,
      lotNumbers: names,
      line:
        `${names.length} occupied ${names.length === 1 ? "lot has" : "lots have"} ` +
        `no bill for ${prettyMonth(month)} — ${nameList(names)}. Somebody lives there and ` +
        `nothing is being charged.`,
    });
  }

  // A tenancy that ran out while the household stayed. Never auto-ended: the
  // trigger is the office not having done paperwork, not anybody leaving.
  const expired = lots.filter((l) => l.tenancyExpired);
  if (expired.length > 0) {
    const names = expired.map((l) => l.lotNumber);
    out.push({
      kind: "tenancy_expired",
      urgent: true,
      lotNumbers: names,
      line:
        `${names.length} ${names.length === 1 ? "household is" : "households are"} ` +
        `living here with no agreement that has not run out — ${nameList(names)}.`,
    });
  }

  // ABSTENTION, SAID OUT LOUD. A rent nobody set is not a rent of zero, and
  // the difference is the whole reason this line exists.
  const unknown = lots.filter((l) => l.occupiedToday && l.quotedAmount == null);
  if (unknown.length > 0) {
    const names = unknown.map((l) => l.lotNumber);
    const trusted = lots.filter((l) => l.quotedAmount != null).length;
    out.push({
      kind: "rent_unknown",
      urgent: false,
      lotNumbers: names,
      line:
        `${trusted} of ${lots.length} lots have a rent I can use. ` +
        `I don't know what ${nameList(names)} should pay, so ` +
        `${names.length === 1 ? "it isn't" : "they aren't"} in any total above.`,
    });
  }

  // A statement that totalled zero was DROPPED by the charge run, silently.
  const zeroed = lots.filter((l) => l.statementZero);
  if (zeroed.length > 0) {
    const names = zeroed.map((l) => l.lotNumber);
    out.push({
      kind: "zero_total_statement",
      urgent: false,
      lotNumbers: names,
      line:
        `${nameList(names)} worked out to nothing for ${prettyMonth(month)}, so ` +
        `${names.length === 1 ? "it was" : "they were"} left off the bills ` +
        `rather than charged $0.`,
    });
  }

  // A disagreement with no clock is a bill out of arrears forever.
  const stale = openClaims.filter((c) => c.ageDays >= CLAIM_STALE_DAYS);
  if (stale.length > 0) {
    const oldest = stale.reduce((m, c) => (c.ageDays > m.ageDays ? c : m), stale[0]);
    const names = stale.map((c) => c.lotNumber);
    out.push({
      kind: "claim_ageing",
      urgent: true,
      lotNumbers: names,
      line:
        `${stale.length} ${stale.length === 1 ? "household has" : "households have"} ` +
        `said they paid and nobody has answered — the oldest is ${oldest.ageDays} ` +
        `days (lot ${oldest.lotNumber}). Those bills sit out of your arrears ` +
        `until you settle them.`,
    });
  }

  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/**
 * What the reconciler says about a month it cannot honestly judge.
 *
 * The takeover month is half somebody else's: the seller collected the first
 * part, the roll is half-entered, and "late" is a claim this data cannot
 * support. Saying so is better than a confident wrong list.
 */
export function cutoverMonthNote(month: string, cutoverDate: string | null): string | null {
  const cutoverMonth = cutoverDate ? cutoverDate.slice(0, 7) : null;
  if (cutoverMonth == null || cutoverMonth !== month) return null;
  // A month that starts on the go-live day is wholly ours: no part of it was
  // the seller's, so this sentence would be a lie and there is nothing to
  // explain — the reconciler is not staying quiet about it either.
  if (periodIsBillable(month, cutoverDate)) return null;
  return (
    `This is your first part-month, so nobody is being called late. The seller ` +
    `collected part of ${prettyMonth(month)} and the roll is still going in.`
  );
}

/** One line for the run log and the evening email subject. */
export function reconcileSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "Nothing out of place.";
  const urgent = findings.filter((f) => f.urgent).length;
  return urgent > 0
    ? `${urgent} ${urgent === 1 ? "thing needs" : "things need"} you, ` +
      `${findings.length - urgent} worth a look.`
    : `${findings.length} worth a look.`;
}
