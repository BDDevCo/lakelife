/**
 * Self-learning dials (owner directive, 2026-07-23: "how does this platform
 * self learn so we get better and better") — PURE math, no I/O. The first
 * closed loop: every completed job stamps started_at/completed_at; the
 * nightly compares actuals to the services.est_minutes dial and nudges it.
 * Rule 8 makes this possible — the dial lives in the DATABASE, so the
 * machine tunes its own knob and tomorrow's routes and time budgets are
 * truer than yesterday's. Damped on purpose: no single weird day can yank
 * a dial; the estimate walks toward reality a bounded step per night.
 */

/** Samples outside this band are stamp noise (a photo uploaded from the
 *  couch at 9pm, a job started twice), not evidence. */
export const MIN_REAL_MINUTES = 10;
export const MAX_REAL_MINUTES = 480;
/** Don't learn from fewer completions than this — small n lies. */
export const MIN_SAMPLES = 5;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The next value for a duration dial given real-world samples.
 * - filters stamp noise to [MIN_REAL_MINUTES, MAX_REAL_MINUTES]
 * - requires MIN_SAMPLES real samples or the dial stands
 * - walks the current estimate toward the sample median by at most 15%
 *   (never less than one $5-style 5-minute step, so small dials can move)
 * - lands on 5-minute steps, floor 10 — the units the router thinks in
 */
export function learnedEstimate(
  currentEst: number,
  sampleMinutes: number[],
): { next: number; moved: boolean; samples: number } {
  const clean = sampleMinutes.filter((m) => Number.isFinite(m) && m >= MIN_REAL_MINUTES && m <= MAX_REAL_MINUTES);
  const current = Number.isFinite(currentEst) && currentEst > 0 ? currentEst : 60;
  if (clean.length < MIN_SAMPLES) return { next: current, moved: false, samples: clean.length };

  const target = median(clean);
  const maxStep = Math.max(5, Math.round((current * 0.15) / 5) * 5);
  let next = current;
  if (target > current) next = Math.min(target, current + maxStep);
  else if (target < current) next = Math.max(target, current - maxStep);
  next = Math.max(10, Math.round(next / 5) * 5);
  return { next, moved: next !== current, samples: clean.length };
}
