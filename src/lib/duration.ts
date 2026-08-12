/**
 * LakeLife duration engine — HOW LONG a job takes, from the same facts that
 * decide what it costs.
 *
 * THE PROBLEM THIS FIXES. Pricing has always scaled with the property: a
 * 12-section pier prices higher than a 4-section one, a 4,200 sq ft house
 * cleans for more than a 1,600 sq ft one. The SCHEDULE never did. Every
 * service carried one flat `services.est_minutes` and it never moved.
 *
 * Live in the database before this file existed:
 *
 *   Pier install / removal   $220 + $48 x sections    est_minutes 180, flat
 *   Lawn mowing & trim       $65 / $85 / $110 by band est_minutes  45, flat
 *   Housekeeping             $80 / $95 / $120 by sqft est_minutes  90, flat
 *
 * So a pier growing from 8 sections to 12 moved the price $604 -> $796 and
 * moved the schedule by nothing at all. Eight large lawns read as
 * 8 x 45 = 360 minutes — a comfortable day — when the real day is closer to
 * twelve hours. The crew absorbs the difference, every time, in the evening.
 *
 * WHY LADDERS AND NOT A FORMULA. There is not one measured duration in the
 * system: `select count(*) from jobs where started_at is not null and
 * completed_at is not null` returns 0. A coefficient like "20 minutes per
 * section" would be invented, and invention compounds — it hands a 30-section
 * pier ten hours of a truck's day on the strength of a number nobody checked.
 * A short ladder cannot extrapolate. Its top rung is a value a person chose
 * and can see. When real durations accumulate, the rungs can be tuned against
 * them; that is a better problem than un-inventing a slope.
 *
 * THE RULE THAT MATTERS MOST: AN UNKNOWN SIZE BOOKS THE LONGEST RUNG.
 * A missing square footage arrives here as 0, which in PRICING lands in the
 * cheapest tier — correct, because an honest floor is the fair thing to
 * charge for a house nobody measured. For a SCHEDULE the same arithmetic is
 * backwards: it books the shortest visit for the property we know least
 * about, and the crew discovers the truth at 3pm with two stops left. Money
 * rounds down; time rounds up.
 *
 * `services.est_minutes` KEEPS ITS MEANING — the whole visit. It is the
 * fallback when a service has no ladder yet, and it is read directly as a
 * whole job by the scarcity-offer gate, the claim board, the claim itself and
 * the nightly self-heal. Redefining it as a "base" would present a 285-minute
 * pier to those gates as a 45-minute job, and a crew whose day genuinely
 * cannot hold it would claim it anyway.
 */

import type { PricingProfile, ServiceRule, CountableField } from "./pricing";

/** Used when a service has neither a ladder nor an `est_minutes`. */
export const FALLBACK_JOB_MINUTES = 60;

/** No single visit is ever budgeted longer than this. */
export const MAX_JOB_MINUTES = 480;

/**
 * A rung of the ladder. `max` is the largest size this rung covers; `null`
 * means "everything above the previous rung", so the ladder always terminates.
 */
export interface DurationRung {
  max: number | null;
  minutes: number;
}

/**
 * How long a service takes, by size. Stored in `services.duration_bands`
 * (jsonb) — a dial in the database, not a constant in this file, for the same
 * reason prices live there (CLAUDE.md rule 8).
 *
 * Two shapes, mirroring the two that `band_pricing` already uses:
 *   { rungs:   [{max: 5, minutes: 120}, ..., {max: null, minutes: 330}] }
 *   { by_band: { small: 30, medium: 50, large: 90 } }
 */
export interface DurationBands {
  rungs?: DurationRung[];
  by_band?: { small?: number; medium?: number; large?: number };
}

/**
 * THE SIZE A SERVICE IS TIMED BY IS THE SIZE IT IS PRICED BY.
 *
 * Read off `band_pricing.count_field` — the service's own existing
 * declaration — so the two can never drift. If someone re-points a pier rule
 * from `pier_sections` to something else, the schedule follows the price
 * automatically, because there is only one declaration to change.
 *
 * Returns null when the model has no meaningful size (flat services), and
 * null when the size is genuinely unknown — the caller treats those
 * differently, so they must stay distinguishable from 0.
 */
export function sizeOf(rule: ServiceRule, profile: PricingProfile): number | null {
  const params = rule.band_pricing ?? {};

  switch (rule.pricing_model) {
    case "per_section": {
      const field = (params.count_field ?? "pier_sections") as CountableField;
      const raw =
        field === "toys_count"
          ? (profile.toys ?? []).length
          : Number((profile as unknown as Record<string, unknown>)[field]);
      if (!Number.isFinite(raw)) return null;
      // The pricing floor is honoured so the two agree on the same count.
      return params.min_count != null ? Math.max(raw, params.min_count) : raw;
    }
    case "per_sqft_band":
      return Number.isFinite(profile.sqft) ? Number(profile.sqft) : null;
    case "per_foot":
    case "seasonal_plus_perdiem":
      return (profile.boats ?? []).reduce((s, b) => s + (Number(b.length_ft) || 0), 0);
    case "band":
      // Named, not numeric — handled by `by_band` rather than by rungs.
      return null;
    case "flat":
      return null;
  }
}

/**
 * Pick a rung. An unknown or unusable size takes the TOP rung, never the
 * bottom one — see the header. `rungs` is read in order and the first whose
 * `max` covers the size wins, exactly like `per_sqft_band` tiers.
 */
function minutesFromRungs(rungs: DurationRung[], size: number | null): number | null {
  const usable = rungs.filter((r) => Number.isFinite(r.minutes) && r.minutes > 0);
  if (usable.length === 0) return null;

  const top = usable.reduce((hi, r) => (r.minutes > hi.minutes ? r : hi), usable[0]);
  if (size == null || !Number.isFinite(size) || size <= 0) return top.minutes;

  for (const r of usable) {
    if (r.max == null || size <= r.max) return r.minutes;
  }
  return top.minutes;
}

/**
 * How many minutes to budget for one visit.
 *
 * Order: the service's ladder, then its flat `est_minutes`, then the
 * fallback. Never zero — a zero-minute job is a job the time budget cannot
 * see, which is how a day silently overfills.
 */
export function serviceMinutes(
  rule: ServiceRule & { est_minutes?: number | null; duration_bands?: DurationBands | null },
  profile: PricingProfile,
): number {
  const bands = rule.duration_bands ?? null;
  let minutes: number | null = null;

  if (bands) {
    if (bands.by_band) {
      // A lawn has no number, it has a name. An unrecognised or missing band
      // takes the LARGEST of the three, for the same reason a missing count
      // takes the top rung.
      const byBand = bands.by_band;
      const named = byBand[profile.lawn_band as "small" | "medium" | "large"];
      const all = [byBand.small, byBand.medium, byBand.large]
        .filter((n): n is number => Number.isFinite(n) && (n as number) > 0);
      minutes = Number.isFinite(named) && (named as number) > 0
        ? (named as number)
        : (all.length ? Math.max(...all) : null);
    } else if (bands.rungs?.length) {
      minutes = minutesFromRungs(bands.rungs, sizeOf(rule, profile));
    }
  }

  if (minutes == null) {
    const flat = Number(rule.est_minutes ?? 0);
    minutes = flat > 0 ? flat : FALLBACK_JOB_MINUTES;
  }

  return Math.min(Math.max(Math.round(minutes), 1), MAX_JOB_MINUTES);
}

/**
 * A multi-leg visit is the SUM of its legs — one truck, one driveway, all the
 * work. Matches how a package is priced and how `jobMinutesOf` already sums
 * `job_items`.
 */
export function visitMinutes(
  legs: Array<{
    rule: ServiceRule & { est_minutes?: number | null; duration_bands?: DurationBands | null };
    profile: PricingProfile;
  }>,
): number {
  if (legs.length === 0) return FALLBACK_JOB_MINUTES;
  const total = legs.reduce((s, l) => s + serviceMinutes(l.rule, l.profile), 0);
  return Math.min(total, MAX_JOB_MINUTES);
}

// ------------------------------------------------------------ the workday ---

/**
 * THE SELLABLE DAY.
 *
 * Brendon's rule: start 7am, cut off at 4pm, "respecting peoples
 * houses/family time in the evening."
 *
 * What that governs is WHAT LAKELIFE PUTS INTO A CREW'S DAY — not what a crew
 * is permitted to do. A crew may work until eight in the evening on their own
 * jobs; we simply never fill past four. That is the protection actually being
 * asked for: crews miss dinner because a platform stuffed the day, not
 * because they chose a long one. It also keeps us from setting the working
 * hours of an independent contractor, which the crew agreement reserves to
 * the crew.
 *
 * The numbers live in `platform_dials`, not here.
 */
export interface SellableDay {
  /** Hour of day, 0-23, lake time. */
  startHour: number;
  endHour: number;
}

/**
 * A crew may open later or close earlier than the platform window. They may
 * NOT push the close later — that is the whole point of the cutoff.
 */
export function sellableWindow(
  platform: SellableDay,
  crew?: { workStart?: number | null; workEnd?: number | null } | null,
): SellableDay {
  const startHour = Math.max(platform.startHour, Number(crew?.workStart ?? platform.startHour));
  const endHour = Math.min(platform.endHour, Number(crew?.workEnd ?? platform.endHour));
  return {
    startHour,
    // A crew whose window collapsed (or was typed backwards) sells nothing
    // rather than selling a negative day that reads as unlimited.
    endHour: Math.max(endHour, startHour),
  };
}

/** How many minutes of work may be SOLD into this day. */
export function sellableMinutes(win: SellableDay): number {
  return Math.max(0, (win.endHour - win.startHour) * 60);
}

/**
 * Would this visit still be finished by the cutoff?
 *
 * `usedMinutes` is what is already committed that day. Returns the clock hour
 * the job would end at, and whether that is inside the window — so a screen
 * can say "that would run past 4" instead of "unavailable".
 */
export function fitsInDay(
  win: SellableDay,
  usedMinutes: number,
  jobMinutes: number,
): { fits: boolean; endsAtMinutes: number; overBy: number } {
  const startMin = win.startHour * 60;
  const closeMin = win.endHour * 60;
  const endsAtMinutes = startMin + Math.max(0, usedMinutes) + Math.max(0, jobMinutes);
  const overBy = Math.max(0, endsAtMinutes - closeMin);
  return { fits: overBy === 0, endsAtMinutes, overBy };
}

/** "7:00am", "4:30pm" — for screens, from minutes past midnight. */
export function clockLabel(minutesPastMidnight: number): string {
  const m = Math.max(0, Math.round(minutesPastMidnight));
  const h24 = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const ampm = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")}${ampm}`;
}
