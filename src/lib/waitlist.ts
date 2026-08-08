/**
 * Waitlist terminal state (ladder rungs 6–8) — PURE, no I/O.
 *
 * A job nobody could crew doesn't rot silently:
 *  - `warningDue` fires in a short CATCH-UP WINDOW ending `warnDays` before
 *    the date: the customer gets the self-serve fork (pick another day /
 *    invite your own crew) while there's still time.
 *  - `isExpired` is the honest floor: the date arrived with nobody to send.
 *    The machine cancels, says so plainly, and reminds the customer they
 *    were never charged. The demand stays on the books as a recruit signal.
 *
 * AUDIT BUG 10d: this used to be pure equality on `jobDate === today +
 * warnDays` — no window and no record of sending. ONE missed nightly lost the
 * warning FOREVER, and a manual re-run re-texted everyone on the boundary.
 * Exactly-once is not something a date predicate can promise; it now lives in
 * the SENT-LEDGER (`waitlist_notice_log`, migration 0049), which frees this
 * predicate to cover the nights the cron didn't run.
 */

/** Nights of slack behind the boundary. Two covers a deploy or an outage
 *  without ever reaching back so far that the "you still have time" text
 *  arrives with no time left. */
export const DEFAULT_WARNING_CATCHUP_DAYS = 2;

/** The ledger `kind` for the waitlist warning — one name, shared by the
 *  sender and the unique index that makes the send exactly-once. */
export const WAITLIST_WARNING_KIND = "waitlist_warning";

function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Is the warning owed tonight? True for job dates in
 * `[today + 1 … today + warnDays]`, reaching back at most `catchUpDays`
 * behind the boundary. Never on the job's own day — by then the only honest
 * text left is the expiry one, and warn+expire must never land the same night.
 * The CALLER must gate on the sent-ledger: this says "owed", not "unsent".
 */
export function warningDue(
  jobDateISO: string | null,
  todayISO: string,
  warnDays: number,
  catchUpDays: number = DEFAULT_WARNING_CATCHUP_DAYS,
): boolean {
  if (!jobDateISO || !(warnDays > 0)) return false;
  const boundary = addDaysISO(todayISO, warnDays);
  const earliest = addDaysISO(todayISO, Math.max(1, warnDays - Math.max(0, catchUpDays)));
  return jobDateISO <= boundary && jobDateISO >= earliest;
}

/** The date came and went with no crew — time for the honest terminal. */
export function isExpired(jobDateISO: string | null, todayISO: string): boolean {
  if (!jobDateISO) return false;
  return jobDateISO < todayISO;
}

// ------------------------------------------------- protective work ---------

/**
 * PROTECTIVE work is work whose ABSENCE destroys property: winterization
 * before a hard freeze, a pier or lift left in the water through ice-up.
 * ROUTINE work is everything else — a missed mow is a long lawn.
 *
 * The distinction exists because the honest terminal above is only honest for
 * routine work. Telling someone "we couldn't line up a crew in time, so we've
 * cancelled it and you were never charged" is a fair outcome for a mow. For a
 * winterization it is a burst pipe, a destroyed home, and a text from us that
 * reads as a shrug. Never being charged is not the point.
 */
export type Criticality = "routine" | "protective";
export type ExpiryAction = "cancel" | "escalate";

/** The ledger `kind` for the one-and-only protective escalation notice. */
export const PROTECTIVE_ESCALATION_KIND = "protective_escalation";

/**
 * What the nightly must do with an unfilled job whose date has passed.
 *
 * Null is treated as routine on purpose: `services.criticality` carries a NOT
 * NULL default of 'routine', so null only appears on a row written before that
 * column existed, and escalating the entire back catalogue would bury ops in
 * noise on the first run.
 *
 * Any OTHER unrecognised value escalates. A future criticality tier we have
 * not taught this function about should land in the safe lane — the cost of a
 * wrong escalate is an ops glance, and the cost of a wrong cancel is a house.
 */
export function expiryActionFor(criticality: string | null | undefined): ExpiryAction {
  if (criticality == null || criticality === "routine") return "cancel";
  return "escalate";
}
