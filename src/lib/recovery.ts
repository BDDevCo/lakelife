/**
 * WHAT HAPPENS AFTER A VISIT WHERE NO WORK GOT DONE.
 *
 * Brendon's rule: "reschedule if both parties agree or they get charged."
 *
 * Two ways to get here, and they are NOT the same conversation:
 *
 *   NO ACCESS — the crew needed to get inside and nobody let them in. The
 *   trip was wasted on something the household controlled. This is the case
 *   his rule is about: offer another day, and if that is refused or ignored,
 *   the fee applies.
 *
 *   STOOD DOWN — the owner declined a correction the crew said they could not
 *   work around. The trip was wasted on OUR record being wrong: the profile
 *   said eight sections and there were twelve. Charging somebody for
 *   declining to pay more than they agreed to would be indefensible, and we
 *   already promised them in writing that nothing would be charged. So this
 *   one reschedules or cancels, and never proposes a fee.
 *
 * THE CREW DROVE THERE IN BOTH CASES. That asymmetry is real and it is not
 * solved here — see `crewIsOutOfPocket`, which surfaces it rather than
 * quietly deciding it.
 *
 * NOTHING IN THIS FILE CHARGES ANYTHING. It works out what the policy says
 * and hands it to a person. The house rule is that a job may run unattended
 * only if its worst outcome is a sentence on a screen, or a write the
 * database would refuse if it were wrong; a card charge triggered by a crew
 * tapping a button on a doorstep is neither.
 */

import { lateFee, type CancelDials } from "./cancellation";

/**
 * ISO date arithmetic, done in UTC on purpose.
 *
 * Every date in this codebase is a lake-time calendar day carried as a plain
 * "YYYY-MM-DD" string. Constructing a local Date from one lands on the
 * previous evening in Indiana; Date.UTC does not, and the string goes back out
 * the way it came in.
 */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type AttemptOutcome = "no_access" | "stood_down";

export type RecoveryState =
  | "awaiting_customer"
  | "rescheduled"
  | "fee_proposed"
  | "fee_charged"
  | "fee_waived";

/**
 * How long the customer gets to pick another day before a fee is proposed.
 *
 * Deliberately generous. These are lake houses — the owner may be three hours
 * away, or on the water with no signal, and the whole point of the window is
 * that "both parties agree" is a real possibility rather than a formality
 * nobody had time to satisfy. Seven days also spans a weekend, which is when
 * most of these people actually look at their phone.
 */
export const RESCHEDULE_DAYS = 7;

export function rescheduleDeadline(attemptedOnISO: string, days = RESCHEDULE_DAYS): string {
  return addDays(attemptedOnISO, days);
}

export interface RecoveryPlan {
  outcome: AttemptOutcome;
  /** May a fee EVER be proposed for this kind of attempt? */
  feeEligible: boolean;
  deadline: string;
  /** What the customer is asked to do. */
  ask: string;
  /** What happens if they do nothing — said up front, not discovered later. */
  ifNothingHappens: string;
}

export function planRecovery(
  outcome: AttemptOutcome,
  attemptedOnISO: string,
  opts: { serviceName: string; days?: number },
): RecoveryPlan {
  const deadline = rescheduleDeadline(attemptedOnISO, opts.days ?? RESCHEDULE_DAYS);

  if (outcome === "stood_down") {
    return {
      outcome,
      // Our record was wrong. Charging for that would be indefensible, and we
      // have already told them in writing that nothing would be charged.
      feeEligible: false,
      deadline,
      ask:
        `Pick another day for your ${opts.serviceName} and we'll send the crew ` +
        `back — with the right details this time.`,
      ifNothingHappens:
        `If you'd rather leave it, that's fine too. Nothing is charged either ` +
        `way, and we'll close it off after ${prettyDeadline(deadline)}.`,
    };
  }

  return {
    outcome,
    feeEligible: true,
    deadline,
    ask:
      `Pick another day for your ${opts.serviceName} — the crew came out and ` +
      `couldn't get in.`,
    ifNothingHappens:
      `If we haven't heard from you by ${prettyDeadline(deadline)}, our ` +
      `cancellation policy applies to the visit the crew made.`,
  };
}

function prettyDeadline(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

/**
 * What the policy says the fee would be.
 *
 * Shares the FORMULA and the DIAL with late cancellations (`lateFee`), not the
 * windowing — one number to change, in one place (rule 8).
 *
 * It deliberately does NOT call `cancellationQuote`. That function refuses
 * anything which is not a future scheduled job — "day-of = call us" — and a
 * visit the crew already made is never that. The first version of this passed
 * the job's own date as "now" to slip past the guard and silently returned
 * zero for every case; a test caught it. Faking a clock to reuse a function
 * whose preconditions do not hold is not reuse, it is a lie in the shape of
 * one.
 *
 * There is no window here on purpose. The crew did not hold a slot they might
 * still have sold — they drove to the lake.
 */
export function proposedFee(
  job: {
    hasCrew: boolean;
    customerPrice: number;
    vendorCost: number | null;
  },
  dials: CancelDials,
): { fee: number; crewShare: number; free: boolean } {
  // Scheduled-but-unassigned should not exist, and nobody was out of pocket
  // for it either way.
  if (!job.hasCrew) return { fee: 0, crewShare: 0, free: true };

  const { fee, crewShare } = lateFee(dials.cancelFeePct, job.customerPrice, job.vendorCost);
  return { fee, crewShare, free: fee <= 0 };
}

/**
 * IS THE CREW OUT OF POCKET?
 *
 * They drove to the lake and came home with nothing, in both cases. When a
 * fee is charged they get their share of it. When one is not — a stand-down,
 * or a waived no-show — they get nothing at all for the trip.
 *
 * This does not decide that; it reports it, so the ops screen can say so out
 * loud and somebody can choose. A crew quietly absorbing the cost of our bad
 * record is exactly the kind of thing that never shows up in a number until
 * the crew stops answering the phone.
 */
export function crewIsOutOfPocket(state: RecoveryState, outcome: AttemptOutcome): boolean {
  if (outcome === "stood_down") return true;              // never fee-eligible
  return state === "fee_waived" || state === "rescheduled";
}

/** Has the customer's window run out? Dates are ISO, lake time. */
export function deadlinePassed(deadlineISO: string | null, todayISO: string): boolean {
  return !!deadlineISO && todayISO > deadlineISO;
}

/**
 * The one line an ops screen shows for an unworked visit.
 *
 * Written so the state is obvious at a glance in a list — the person reading
 * it is triaging, not studying.
 */
export function recoveryHeadline(
  state: RecoveryState | null,
  opts: { outcome: AttemptOutcome; deadline: string | null; todayISO: string; fee?: number | null },
): string {
  const late = deadlinePassed(opts.deadline, opts.todayISO);
  switch (state) {
    case "rescheduled":
      return "Booked in again ✓";
    case "fee_charged":
      return `Fee charged${opts.fee ? ` — $${opts.fee.toFixed(2)}` : ""}`;
    case "fee_waived":
      return "Fee waived — crew got nothing for the trip";
    case "fee_proposed":
      return `Fee proposed${opts.fee ? ` — $${opts.fee.toFixed(2)}` : ""}, waiting on you`;
    case "awaiting_customer":
      return opts.outcome === "stood_down"
        ? late ? "No reply — close it off, nothing to charge" : "Waiting on the customer to pick a day"
        : late ? "Window closed — decide on the fee" : "Waiting on the customer to pick a day";
    default:
      return "No recovery needed";
  }
}
