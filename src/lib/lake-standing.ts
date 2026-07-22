/**
 * Lake standing (Phase E) — PURE, no I/O, fully unit-testable.
 *
 * Two self-healing rules that keep the marketplace honest with zero humans:
 *
 * 1) AUTO-DEMOTION: a crew that keeps ghosting ONE lake gets paused on that
 *    lake (removed from service_lakes, cooldown before they can return).
 *    The rule is net strikes: no-shows on the lake MINUS completions on the
 *    lake — a crew that misses twice but also completes five stays; a
 *    cold-start hoarder that claims a far lake and never shows self-evicts.
 *
 * 2) BASE SELF-HEAL: a crew's proximity ranking uses their base pin. Pins go
 *    wrong (typo'd town, moved shop, never set). The rolling median of where
 *    they actually COMPLETE jobs is ground truth — set the pin from it when
 *    it's missing, correct it when it's wildly off, leave it alone otherwise.
 */

import { milesBetween } from "./dispatch"; // relative — vitest has no path alias

/** Net-strike demotion rule. `limit` is the lake_strike_limit dial. */
export function shouldDemote(strikes: number, completions: number, limit: number): boolean {
  if (!(limit > 0)) return false;
  return strikes - completions >= limit;
}

/** Is a demotion still cooling down? `days` is the cooldown dial. */
export function isCoolingDown(demotedAtISO: string | null, days: number, nowMs: number): boolean {
  if (!demotedAtISO) return false;
  const demoted = Date.parse(demotedAtISO);
  if (!Number.isFinite(demoted)) return false;
  return nowMs - demoted < days * 86_400_000;
}

/** Median of a list (average of middle two for even counts). */
export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface BaseHealDecision {
  action: "set" | "correct" | "keep";
  lat: number | null;
  lng: number | null;
}

/**
 * Decide whether to (re)pin a crew's base from their completed-job centroid.
 *  - fewer than `minJobs` completions → keep (not enough signal);
 *  - no base on file → set it to the centroid;
 *  - base further than `thresholdMiles` from the centroid → correct it
 *    (a typo'd pin ranks them wrong on every job);
 *  - otherwise keep the pin the crew chose.
 */
export function healBase(
  points: Array<{ lat: number | null; lng: number | null }>,
  baseLat: number | null,
  baseLng: number | null,
  minJobs = 5,
  thresholdMiles = 25,
): BaseHealDecision {
  const usable = points.filter((p) => p.lat != null && p.lng != null) as Array<{ lat: number; lng: number }>;
  if (usable.length < minJobs) return { action: "keep", lat: baseLat, lng: baseLng };
  const lat = median(usable.map((p) => p.lat));
  const lng = median(usable.map((p) => p.lng));
  if (lat == null || lng == null) return { action: "keep", lat: baseLat, lng: baseLng };
  if (baseLat == null || baseLng == null) return { action: "set", lat, lng };
  if (milesBetween(baseLat, baseLng, lat, lng) > thresholdMiles) return { action: "correct", lat, lng };
  return { action: "keep", lat: baseLat, lng: baseLng };
}
