/**
 * Booking calendar rules — which days a service can be scheduled.
 *
 *  - past           : the day is before today (or today, outside the rush window)
 *  - rush           : TODAY, inside the same-day rush window — bookable at the
 *                     rush premium; never auto-dispatched (claim board only)
 *  - off-season     : water work outside the lake's in-water window
 *                     (before ice-out or after the pull deadline) — CLAUDE.md rule 7
 *  - full           : the crew is at capacity that day
 *  - available      : bookable
 *
 * Dates are handled as YYYY-MM-DD strings so timezones can't shift a day.
 * Rush is exempt from `fullDates` (capacity is the claiming crew's own call —
 * a claim is consent) but NOT from the season gate (rule 7 outranks urgency).
 */

export type DayStatus = "past" | "rush" | "off-season" | "full" | "available";

export interface DayContext {
  today: string; // YYYY-MM-DD
  isWaterWork: boolean;
  seasonStart: string | null; // lake ice-out (YYYY-MM-DD)
  seasonEnd: string | null; // lake pull deadline (YYYY-MM-DD)
  fullDates: Set<string>; // days already at crew capacity
  /** Same-day rush: current lake-time hour + the cutoff dial. Omit either to
   *  disable rush entirely (today then reads "past" — the pre-rush behavior). */
  rushNowHour?: number;
  rushCutoffHour?: number;
}

export function dayStatus(date: string, ctx: DayContext): DayStatus {
  if (date < ctx.today) return "past";
  const isToday = date === ctx.today;
  if (isToday) {
    const rushOpen =
      ctx.rushNowHour != null &&
      ctx.rushCutoffHour != null &&
      ctx.rushNowHour >= 6 && // RUSH_OPEN_HOUR — "today" isn't real at 3am
      ctx.rushNowHour < ctx.rushCutoffHour;
    if (!rushOpen) return "past";
  }
  if (ctx.isWaterWork) {
    if (ctx.seasonStart && date < ctx.seasonStart) return "off-season";
    if (ctx.seasonEnd && date > ctx.seasonEnd) return "off-season";
  }
  if (isToday) return "rush";
  if (ctx.fullDates.has(date)) return "full";
  return "available";
}

/** Format a Date as YYYY-MM-DD in local time (no timezone drift). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Today's date AT THE LAKES (Indiana), regardless of where the server runs.
 * Production servers run in UTC, where "today" flips at 7-8pm Indiana time —
 * using server-local time would wrongly reject evening bookings for tomorrow.
 */
export function todayLakeDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date());
}

/**
 * A timestamp's calendar date AT THE LAKES, or null if the input doesn't
 * parse. Comparing a raw UTC date slice against todayLakeDate() makes an
 * 8pm booking look like "tomorrow" — any age-gated rule (fill-in offers)
 * would then wait a full extra day. Null (not a throw) on garbage keeps a
 * single malformed row from crashing a whole board or nightly run; age
 * gates treat null as "not aged" (fail closed).
 */
export function lakeDateOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(d);
}

/** Is a frequency a repeating (recurring) one? */
export function isRecurring(frequency: string): boolean {
  return /weekly|2 weeks|arrival/i.test(frequency);
}
