/**
 * Booking calendar rules — which days a service can be scheduled.
 *
 *  - past           : the day is today or earlier
 *  - off-season     : water work outside the lake's in-water window
 *                     (before ice-out or after the pull deadline) — CLAUDE.md rule 7
 *  - full           : the crew is at capacity that day
 *  - available      : bookable
 *
 * Dates are handled as YYYY-MM-DD strings so timezones can't shift a day.
 */

export type DayStatus = "past" | "off-season" | "full" | "available";

export interface DayContext {
  today: string; // YYYY-MM-DD
  isWaterWork: boolean;
  seasonStart: string | null; // lake ice-out (YYYY-MM-DD)
  seasonEnd: string | null; // lake pull deadline (YYYY-MM-DD)
  fullDates: Set<string>; // days already at crew capacity
}

export function dayStatus(date: string, ctx: DayContext): DayStatus {
  if (date <= ctx.today) return "past";
  if (ctx.isWaterWork) {
    if (ctx.seasonStart && date < ctx.seasonStart) return "off-season";
    if (ctx.seasonEnd && date > ctx.seasonEnd) return "off-season";
  }
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

/** Is a frequency a repeating (recurring) one? */
export function isRecurring(frequency: string): boolean {
  return /weekly|2 weeks|arrival/i.test(frequency);
}
