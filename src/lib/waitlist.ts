/**
 * Waitlist terminal state (ladder rungs 6–8) — PURE, no I/O.
 *
 * A job nobody could crew doesn't rot silently:
 *  - `warningDue` fires EXACTLY once, `warnDays` before the date (same
 *    exact-boundary idiom as the COI re-attest — no nightly nagging): the
 *    customer gets the self-serve fork (pick another day / invite your own
 *    crew) while there's still time.
 *  - `isExpired` is the honest floor: the date arrived with nobody to send.
 *    The machine cancels, says so plainly, and reminds the customer they
 *    were never charged. The demand stays on the books as a recruit signal.
 */

function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** True exactly `warnDays` before the job date (one send, no spam). */
export function warningDue(jobDateISO: string | null, todayISO: string, warnDays: number): boolean {
  if (!jobDateISO || !(warnDays > 0)) return false;
  return jobDateISO === addDaysISO(todayISO, warnDays);
}

/** The date came and went with no crew — time for the honest terminal. */
export function isExpired(jobDateISO: string | null, todayISO: string): boolean {
  if (!jobDateISO) return false;
  return jobDateISO < todayISO;
}
