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
 *
 * THE YEAR ROLL (two-season audit, finding 1): a lake row stores ONE season's
 * absolute dates. Read literally, every lake went 100% off-season for water
 * work the moment its stored season aged out — silently, because land work
 * kept flowing. Stale dates are therefore rolled onto the current season year
 * as a PROVISIONAL window (`effectiveSeason`), so a lake never goes dark
 * waiting on a human; `wasRolled` carries the fact that the window is a guess
 * so callers can say so. A season that is UNKNOWN (either end missing) fails
 * CLOSED — no window is not an open window (finding 8b: a blank ice-out made
 * a pier install bookable under January ice).
 */

export type DayStatus = "past" | "rush" | "off-season" | "full" | "available";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days in a 1-12 month, leap-aware. Exported because the storage season-end
 *  dials clamp against it too (audit finding 9 — "April 31" was settable). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Is this string a date the calendar (and Postgres) actually has? */
export function isRealDate(iso: string | null | undefined): boolean {
  if (!iso || !ISO_DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Same month/day, `years` later. Feb 29 lands on Feb 28 in a common year so
 *  the result is always a real date. Nulls and garbage pass through. */
export function addYearsISO(iso: string, years: number): string;
export function addYearsISO(iso: string | null, years: number): string | null;
export function addYearsISO(iso: string | null, years: number): string | null {
  if (!iso || !ISO_DATE_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const ny = y + years;
  const nd = Math.min(d, daysInMonth(ny, m));
  return `${ny}-${String(m).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** Rule 7's one piece of arithmetic: pull deadline = hard freeze − 8 days. */
export const PULL_BUFFER_DAYS = 8;

/** Hard freeze → pull deadline (rule 7). UTC math, so no TZ can shift a day. */
export function pullDeadlineFrom(hardFreezeISO: string): string {
  const [y, m, d] = hardFreezeISO.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - PULL_BUFFER_DAYS * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** A lake row's stored season, exactly as the `lakes` table holds it. */
export interface StoredSeason {
  iceOut: string | null; // lakes.ice_out_actual
  pullDeadline: string | null; // lakes.pull_deadline
}

export interface EffectiveSeason {
  seasonStart: string | null;
  seasonEnd: string | null;
  /** True = these dates are LAST season's month/day on this year — a guess,
   *  not a confirmed ice-out. Surface it; never sell against it silently. */
  wasRolled: boolean;
  yearsRolled: number;
}

/**
 * The window the calendar should actually use today (audit finding 1).
 *
 * Stored dates from a PAST year are rolled onto the current year, month and
 * day intact and both ends by the SAME number of years so the window keeps
 * its span. Dates for this year or a future one are returned untouched — a
 * window a human confirmed is never overwritten by a guess. Pure: no clock,
 * no I/O; `today` is passed in.
 */
/**
 * IS THIS WINDOW A GUESS? — one answer, so every surface agrees.
 *
 * `effectiveSeason` already computes `wasRolled` and its own doc says of it:
 * "Surface it; never sell against it silently." Outside tests it had exactly
 * ONE consumer — the ops assign-refusal, which tells the person REFUSING a job
 * that the dates are provisional. The customer committing money to the same
 * window saw a plain white square and the tooltip "Available".
 *
 * TWO SIGNALS, because either one alone is wrong:
 *
 *   `wasRolled` is true when stored dates are from a past year and have been
 *   rolled onto this one. It is FALSE for a lake born from "my lake isn't
 *   listed", whose dates are this year's — because they were COPIED off a
 *   neighbouring lake. A pure guess that rolls to nothing.
 *
 *   `season_confirmed` is false on exactly those demand-born lakes
 *   (lake-birth.ts) and true once ops types both dates by hand
 *   (ops/actions.ts). But it DEFAULTS TRUE (0044), so the seeded lakes read
 *   confirmed while holding dates that will be a year stale come January.
 *
 * So: rolled, or never confirmed, is provisional.
 */
export function seasonIsProvisional(
  eff: Pick<EffectiveSeason, "wasRolled">,
  seasonConfirmed: boolean | null | undefined,
): boolean {
  return eff.wasRolled || seasonConfirmed === false;
}

export function effectiveSeason(stored: StoredSeason, today: string): EffectiveSeason {
  const unrolled = {
    seasonStart: stored.iceOut,
    seasonEnd: stored.pullDeadline,
    wasRolled: false,
    yearsRolled: 0,
  };
  // Anchor on ice-out; a row with only a pull deadline still deserves a roll.
  const anchor = stored.iceOut ?? stored.pullDeadline;
  if (!anchor || !ISO_DATE_RE.test(anchor) || !ISO_DATE_RE.test(today)) return unrolled;
  const delta = Number(today.slice(0, 4)) - Number(anchor.slice(0, 4));
  if (!Number.isFinite(delta) || delta <= 0) return unrolled;
  return {
    seasonStart: addYearsISO(stored.iceOut, delta),
    seasonEnd: addYearsISO(stored.pullDeadline, delta),
    wasRolled: true,
    yearsRolled: delta,
  };
}

export interface SeasonDatesCheck {
  ok: boolean;
  error?: string;
  /** Derived, never typed (rule 7). Null when the freeze is unknown. */
  pullDeadline: string | null;
  /** Saveable, but the caller should say this out loud. */
  warning?: string;
}

/**
 * Validate an ops season edit before it reaches the lakes table (audit
 * finding 8). Format alone was the whole gate, so (a) the two dates typed
 * into each other's boxes saved fine and closed the lake's entire water
 * calendar with no error, and (b) a blank ice-out saved fine and — with the
 * old gate — opened water work all winter.
 */
export function validateSeasonDates(input: {
  iceOut: string | null;
  hardFreeze: string | null;
}): SeasonDatesCheck {
  const iceOut = input.iceOut || null;
  const hardFreeze = input.hardFreeze || null;
  if (iceOut != null && !isRealDate(iceOut)) {
    return { ok: false, error: "Ice-out must be a real calendar date.", pullDeadline: null };
  }
  if (hardFreeze != null && !isRealDate(hardFreeze)) {
    return { ok: false, error: "Hard freeze must be a real calendar date.", pullDeadline: null };
  }
  const pullDeadline = hardFreeze != null ? pullDeadlineFrom(hardFreeze) : null;
  if (iceOut != null && pullDeadline != null && iceOut > pullDeadline) {
    return {
      ok: false,
      pullDeadline: null,
      error:
        `Ice-out (${iceOut}) falls after this lake's pull deadline (${pullDeadline} — hard freeze ` +
        `${hardFreeze} minus ${PULL_BUFFER_DAYS} days), which leaves no bookable water day all year. ` +
        `Check whether the two dates got swapped.`,
    };
  }
  if (iceOut == null && hardFreeze != null) {
    return {
      ok: true,
      pullDeadline,
      warning:
        "Saved — but with no ice-out on file this lake stays CLOSED for water work (rule 7). " +
        "Add the ice-out date to open the spring calendar.",
    };
  }
  return { ok: true, pullDeadline };
}

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
    // Callers hand us the lake row verbatim, so the roll happens HERE — one
    // place, every surface (customer grid, book action, ops override).
    const { seasonStart, seasonEnd } = effectiveSeason(
      { iceOut: ctx.seasonStart, pullDeadline: ctx.seasonEnd },
      ctx.today,
    );
    // Fail closed: half a window is not a window (finding 8b).
    if (!seasonStart || !seasonEnd) return "off-season";
    if (date < seasonStart || date > seasonEnd) return "off-season";
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
