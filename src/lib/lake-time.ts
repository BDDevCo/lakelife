/**
 * EVERY DATE A PERSON READS, WRITTEN ONE WAY, ON THE LAKES' CLOCK.
 *
 * The house rule is words — "August 2026", "Friday, September 11" — and the
 * house clock is Indiana's. Both were being reinvented per file: eighteen
 * files pinned America/Indiana/Indianapolis by hand, three did not, and the
 * ones that did not are SERVER components rendering on Vercel in UTC, where
 * the render is final and nothing corrects it. So a homeowner whose card was
 * taken at 8:58 PM on the 18th read "Charged to your card on file on July 20"
 * under a job header that said July 18 — on two of the three real payments in
 * production. The ops job file put every timeline stamp four or five hours
 * ahead of the wall clock, so anything after 8 PM lake time read as the next
 * day, on six of eight real jobs.
 *
 * Four shapes cover the product, and each one is the shape the prototype or
 * the app's own majority already uses:
 *
 *   shortDate    "Sep 11" · "Nov 7, 2025"        list columns; year only when
 *                                                it is not this year (the
 *                                                prototype's rule, :443-449)
 *   crewDate     "Fri, Sep 11"                   crew texts (automation's
 *                                                prettyDate, now shared)
 *   longDate     "September 3, 2026"             a receipt, a claim, a resident
 *   longDay      "Friday, September 11, 2026"    a job-file heading (:507)
 *   lakeStamp    "Sep 11, 2026, 9:15 PM"         a timestamp, pinned
 *
 * A DATE-ONLY VALUE ("2026-09-11") IS NOT A TIMESTAMP. `new Date("2026-09-11")`
 * is midnight UTC, which is the evening BEFORE in Indiana; every helper here
 * anchors a bare date at noon so it cannot slip a day in either direction.
 */

export const LAKE_TZ = "America/Indiana/Indianapolis";

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A Date for either shape of input, or null for garbage — never "Invalid Date". */
function parse(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = BARE_DATE.test(value) ? new Date(value + "T12:00:00") : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** This year, on the lakes' clock — so "year only when different" is judged there. */
function lakeYear(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: LAKE_TZ, year: "numeric" }).format(d);
}

/** "Sep 11", or "Nov 7, 2025" when it is not this year. Empty for garbage. */
export function shortDate(value: string | Date | null | undefined, now: Date = new Date()): string {
  const d = parse(value);
  if (!d) return "";
  const sameYear = lakeYear(d) === lakeYear(now);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LAKE_TZ, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** "Fri, Sep 11" — the shape every crew text already uses. */
export function crewDate(value: string | Date | null | undefined): string {
  const d = parse(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: LAKE_TZ, weekday: "short", month: "short", day: "numeric" }).format(d);
}

/** "September 3, 2026" — a receipt, a claim, a resident's screen. */
export function longDate(value: string | Date | null | undefined): string {
  const d = parse(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: LAKE_TZ, month: "long", day: "numeric", year: "numeric" }).format(d);
}

/** "Friday, September 11, 2026" — a job-file heading. */
export function longDay(value: string | Date | null | undefined): string {
  const d = parse(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: LAKE_TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d);
}

/** "Sep 11, 2026, 9:15 PM" — a timestamp a person reads, on the lakes' clock. */
export function lakeStamp(value: string | Date | null | undefined): string {
  const d = parse(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LAKE_TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d);
}
