/**
 * RE-RATING SITTING TENANTS — the pure part.
 *
 * The Haven closes Dec 15 2026 and 19 households go from ~$272 to $400 on the
 * same day. That is the operation this file plans, and the reason it is worth
 * its own module is that a rent increase is not an edit — it is a scheduled,
 * noticed event with a before, an after, and a date it becomes true.
 *
 * Three things this refuses to do, all for the same reason (the number belongs
 * to a household, not to a spreadsheet):
 *
 *   1. It never changes what somebody pays TODAY. It plans a change for a date.
 *   2. It never lets the effective date fall inside the notice period.
 *   3. It never invents the notice period. That is a park dial set by counsel;
 *      this only does the arithmetic on whatever it is given.
 */

/** What a lot currently is and pays. */
export interface ReRateTarget {
  reservationId: string;
  lotLabel: string;
  /** Null when nobody is on the lot — those are excluded, not defaulted. */
  currentAmount: number | null;
  term: string;
  /** So a change is never scheduled onto a tenancy that has already ended. */
  endsOn: string | null;
}

export type ReRateProblem =
  | "no_tenancy"
  | "already_at_amount"
  | "ends_before_effective"
  | "not_monthly";

export function reRateProblemText(p: ReRateProblem, lotLabel: string): string {
  switch (p) {
    case "no_tenancy":
      return `Nobody is on lot ${lotLabel}, so there's no rent to change. Set the asking rate instead.`;
    case "already_at_amount":
      return `Lot ${lotLabel} is already at that rent.`;
    case "ends_before_effective":
      return `Lot ${lotLabel}'s stay ends before the new rent would start.`;
    case "not_monthly":
      return `Lot ${lotLabel} isn't a monthly tenancy — change that one on its own.`;
  }
}

export interface ReRateLine {
  reservationId: string;
  lotLabel: string;
  from: number | null;
  to: number;
  /** Positive is an increase. Null when there was no prior number to compare. */
  delta: number | null;
  problem: ReRateProblem | null;
}

export interface ReRatePlan {
  /** Will be scheduled. */
  changing: ReRateLine[];
  /** Will not, each with a reason in words. */
  skipped: ReRateLine[];
  monthlyBefore: number;
  monthlyAfter: number;
  monthlyDelta: number;
  /**
   * How many of `changing` had NO rent on file, and so are absent from the
   * three figures above.
   *
   * This was computed and then dropped — the comment beside the calculation
   * promised "the unknowns are reported separately instead" and nothing
   * returned them, so nothing could report them. That left the summary saying
   * "19 households — $2,432 more a month" where the count includes lots the
   * money does not: a headline that is not wrong about either number and is
   * wrong about the two together, on the screen where he decides what to
   * charge nineteen households.
   */
  unknownBefore: number;
  /** The soonest date this change may legally take effect. */
  earliestEffective: string;
  /** True when the date he picked is inside the notice window. */
  tooSoon: boolean;
  /** The largest single increase, as a percentage. Renders as a warning. */
  biggestIncreasePct: number | null;
}

export interface ReRateInput {
  targets: readonly ReRateTarget[];
  /** The new monthly amount. One number for the whole selection. */
  toAmount: number;
  /** The day he wants it to start. */
  effectiveOn: string;
  /** The day notice goes out — usually today, but he may have served it already. */
  noticeGivenOn: string;
  /** The park's dial. NEVER defaulted here. */
  noticeDays: number;
}

/** Add days to an ISO date without touching local time. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function planReRate(input: ReRateInput): ReRatePlan {
  const { targets, toAmount, effectiveOn, noticeGivenOn, noticeDays } = input;

  // The far edge of the notice period, counted from the day notice goes out.
  // This is the same arithmetic the database constraint enforces, so the screen
  // and the constraint cannot disagree.
  const earliestEffective = addDays(noticeGivenOn, noticeDays);
  const tooSoon = effectiveOn < earliestEffective;

  const changing: ReRateLine[] = [];
  const skipped: ReRateLine[] = [];

  for (const t of targets) {
    const line: ReRateLine = {
      reservationId: t.reservationId,
      lotLabel: t.lotLabel,
      from: t.currentAmount,
      to: toAmount,
      delta: t.currentAmount == null ? null : Math.round((toAmount - t.currentAmount) * 100) / 100,
      problem: null,
    };

    if (!t.reservationId) { line.problem = "no_tenancy"; skipped.push(line); continue; }
    if (t.term !== "monthly") { line.problem = "not_monthly"; skipped.push(line); continue; }
    if (t.currentAmount != null && t.currentAmount === toAmount) {
      line.problem = "already_at_amount"; skipped.push(line); continue;
    }
    // A stay that is over before the new rent starts must not be re-rated —
    // it would change a number for a period that has already been billed.
    if (t.endsOn && t.endsOn <= effectiveOn) {
      line.problem = "ends_before_effective"; skipped.push(line); continue;
    }
    changing.push(line);
  }

  // Totals count ONLY the ones that will actually change, and only the ones
  // that had a number to begin with — a null rent contributes nothing to a
  // "before" figure rather than counting as zero.
  // BOTH SIDES MUST COVER THE SAME HOUSEHOLDS. Counting a null rent as $0 in
  // the before-total while adding its full new rent to the after-total made
  // "$X more a month" bigger than the truth — on a decision affecting every
  // household in the park. The unknowns are reported separately instead.
  const known = changing.filter((l) => l.from != null);
  const monthlyBefore = known.reduce((s, l) => s + (l.from ?? 0), 0);
  const monthlyAfter = known.reduce((s, l) => s + l.to, 0);
  const unknownBefore = changing.length - known.length;

  const pcts = changing
    .filter((l) => l.from != null && l.from > 0)
    .map((l) => ((l.to - l.from!) / l.from!) * 100);

  return {
    changing,
    skipped,
    monthlyBefore,
    monthlyAfter,
    monthlyDelta: Math.round((monthlyAfter - monthlyBefore) * 100) / 100,
    unknownBefore,
    earliestEffective,
    tooSoon,
    biggestIncreasePct: pcts.length ? Math.round(Math.max(...pcts)) : null,
  };
}

/**
 * The sentence the screen puts in front of him before he commits.
 *
 * Deliberately states the HOUSEHOLD count and the biggest single increase
 * rather than only the money. "$2,432 more a month" is the number he wants;
 * "19 households, the largest going up 60%" is the number he needs, and it is
 * the one that decides whether he staggers it.
 */
export function reRateSummary(plan: ReRatePlan): string {
  const n = plan.changing.length;
  if (n === 0) return "Nothing would change.";
  const households = `${n} ${n === 1 ? "household" : "households"}`;
  const money = `$${plan.monthlyDelta.toLocaleString("en-US")} more a month`;
  const worst = plan.biggestIncreasePct != null
    ? `, the largest going up ${plan.biggestIncreasePct}%`
    : "";
  return `${households}${worst} — ${money}.`;
}

/**
 * WHAT THIS HOUSEHOLD'S RENT WAS DURING A GIVEN MONTH.
 *
 * `runCharges(parkId, month)` takes ANY month — the rent screen has month
 * navigation and its "Bill <month>" button is not gated to the current one —
 * and it billed `lot_reservations.quoted_amount`, which is whatever the rent is
 * TODAY. So on 2 February, re-raising a voided January bill charged January at
 * February's rate: the household is billed the increase for a month they were
 * never given notice for. Voiding and re-raising is an explicitly supported
 * flow, so this is not a corner.
 *
 * The rate for a month is reconstructable exactly, because a change records
 * both sides of itself:
 *
 *   - the newest change already in force by the end of that month → `to_amount`
 *   - else the oldest change still ahead of it → its `from_amount`, which IS
 *     the rate that was in force before it
 *   - else nothing has ever changed → today's rent is also that month's rent
 *
 * Cancelled changes are not history and must be filtered out before this.
 */
export interface RentChangePoint {
  effective_on: string;   // YYYY-MM-DD
  from_amount: number | null;
  to_amount: number | null;
}

export function rentForPeriod(
  changes: readonly RentChangePoint[],
  periodEnd: string,
  currentRent: number | null,
): number | null {
  const ordered = [...changes]
    .filter((c) => !!c.effective_on)
    .sort((a, b) => a.effective_on.localeCompare(b.effective_on));

  let inForce: RentChangePoint | null = null;
  for (const c of ordered) {
    if (c.effective_on <= periodEnd) inForce = c;
    else break;
  }
  if (inForce && inForce.to_amount != null) return Number(inForce.to_amount);

  const ahead = ordered.find((c) => c.effective_on > periodEnd);
  if (ahead && ahead.from_amount != null) return Number(ahead.from_amount);

  return currentRent == null ? null : Number(currentRent);
}

/** The last day of a YYYY-MM month, as YYYY-MM-DD. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
