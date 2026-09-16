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
 *
 * ONE MONTH WAS THE WRONG QUESTION. This used to ask, per lot, "is this month
 * billed?". A row written from a lapsed agreement's own end (decision 3)
 * makes past months billable; the run visits a month once; so "is this month
 * billed" answered yes about a lot whose February was never raised, every
 * night, forever. The caller now hands over EVERY unbilled month per lot
 * (unbilled-months.ts), and the sentence names them.
 */

import { prettyMonth, monthList } from "./ledger-helpers";
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
    /**
     * LIVED ON, PAPERWORK RUN OUT — the roll's own `lapsed` (park-helpers
     * lapsedRowOf): a held monthly row behind today with nothing current,
     * nothing coming and nobody closed out after it. Somebody lives there;
     * the roll counts the lot as taken, and so does this read.
     */
    lapsed: boolean;
    /**
     * Every month from the lot's held rows' coverage, floored at the first
     * billable period and capped at the current month, with no live charge
     * on that row — the current month included. Empty means every month it
     * should have a bill for has one. Built by `unbilledMonthsFor`; only
     * rows the run would bill (term monthly, approved/active, a live lot)
     * put a month here, so nothing named is a month the rent screen refuses.
     */
    unbilledMonths: string[];
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

/** Up to `max` of `items` the way a person lists them, then "and N more". */
function listOf(items: readonly string[], max = 4): string {
  const shown = items.slice(0, max);
  if (items.length <= max) {
    if (shown.length === 1) return shown[0];
    return shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1];
  }
  return `${shown.join(", ")} and ${items.length - max} more`;
}

function nameList(lots: string[], max = 4): string {
  return listOf(lots.map((l) => `lot ${l}`), max);
}

export function reconcile(input: ReconcileInput): Finding[] {
  const out: Finding[] = [];
  const { lots, openClaims, month, cutoverDate } = input;

  /**
   * A MONTH WE MAY NOT BILL IS NEVER CALLED UNBILLED.
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
   * reconciler goes quiet about exactly the months the ledger will not charge
   * for, and about no others. It is applied PER MONTH now, not once to the
   * current month: a lot whose rows reach back over the takeover still has
   * December struck out and January named.
   */
  const unbilled = lots
    .map((l) => ({
      ...l,
      months: [...l.unbilledMonths].sort().filter((m) => periodIsBillable(m, cutoverDate)),
    }))
    // A LAPSED LOT IS LIVED ON. The roll and Today count it as taken; the
    // run WOULD bill its months from the rent screen (classifyForRun says
    // "bill" for a row that covers the month, however it stands today). So
    // "occupied" here is the roll's, not the current link's — on
    // `occupiedToday` alone the one lot reading "Ran out … nothing billed
    // since" with an interior hole was the one lot this line never named.
    .filter((l) => (l.occupiedToday || l.lapsed) && l.months.length > 0)
    // EARLIEST HOLE FIRST. On the night of the 1st, before he presses Bill,
    // every occupied lot is missing the current month — and in read order
    // the one lot missing February as well sat inside "and 15 more" until
    // the run. The list names at most four lots, so the four it names must
    // be the ones with the oldest gap. Stable, so ties keep read order.
    .sort((a, b) => (a.months[0] < b.months[0] ? -1 : a.months[0] > b.months[0] ? 1 : 0));

  // SOMEBODY LIVES THERE AND NOBODY IS BILLING THEM. This is the failure with
  // no error anywhere: a lapsed range, a dropped charge, and the money just
  // stops while the household stays put.
  if (unbilled.length > 0) {
    const names = unbilled.map((l) => l.lotNumber);
    const n = names.length;
    // THE NIGHT BEFORE THE RUN is the common case: every named lot is missing
    // exactly the current month, and the sentence he has read every month
    // since the check began still says it best. Anything else — an older
    // month on any lot — gets the sentence that names the months, because
    // "no bill for March" about a lot with no bill for February is the lie
    // this file exists to stop telling.
    const onlyThisMonth = unbilled.every(
      (l) => l.months.length === 1 && l.months[0] === month,
    );
    const line = onlyThisMonth
      ? `${n} occupied ${n === 1 ? "lot has" : "lots have"} ` +
        `no bill for ${prettyMonth(month)} — ${nameList(names)}. Somebody lives there and ` +
        `nothing is being charged.`
      // "the rent screen's month links reach back" is an instruction the
      // screen HAS: ParkRent.tsx's month nav steps back a month at a time to
      // any earlier month, and each month's page carries its own Bill button.
      : `${n} occupied ${n === 1 ? "lot has" : "lots have"} months with no bill — ` +
        `${listOf(unbilled.map((l) => `lot ${l.lotNumber} (${monthList(l.months)})`))}. ` +
        `Somebody lives there and nothing is being charged for ` +
        `${n === 1 ? "them" : "those months"}; the rent screen's month links reach back ` +
        `to bill them.`;
    out.push({ kind: "live_lot_unbilled", urgent: true, lotNumbers: names, line });
  }

  // A tenancy that ran out while the household stayed. Never auto-ended: the
  // trigger is the office not having done paperwork, not anybody leaving.
  const expired = lots.filter((l) => l.lapsed);
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
