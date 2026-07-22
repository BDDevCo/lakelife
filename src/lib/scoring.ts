/**
 * Crew scoring (Phase 9) — PURE, no I/O, fully unit-testable. Turns the data the
 * platform already captures (on-time completion, flag accuracy, volume) into a
 * 0–100 score + a private tier. The score is the PRIMARY sort key in the
 * dispatch engine (better crews get first-refusal / eat first), and drives each
 * crew's private "My standing" card. Never public, never a leaderboard.
 */

export type CrewTier = "priority" | "building" | "new";

export interface ScoreInputs {
  completedCount: number; // completed jobs, all-time
  onTimeCount: number; // completed on/before the scheduled date
  ratedCount: number; // completed jobs we have completion data for (on-time denominator)
  flagsApproved: number; // flags the owner approved (accurate call)
  flagsDeclined: number; // flags the owner declined (bad call)
  noShows?: number; // scheduled jobs the crew ghosted (no photos, no completion)
}

export interface CrewScore {
  score: number; // 0–100
  tier: CrewTier;
  onTimeRate: number; // 0–1
  flagAccuracy: number; // 0–1
  reliabilityRate: number; // 0–1 (honored vs ghosted commitments)
  noShows: number;
  confidence: number; // 0–1 (how much history backs the score)
  completedCount: number;
  nextTierHint: string;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Full-confidence volume: at 10 completed jobs a crew's score is fully "earned". */
export const CONFIDENCE_JOBS = 10;
export const PRIORITY_MIN_SCORE = 85;
export const PRIORITY_MIN_JOBS = 10;
export const NEW_MAX_JOBS = 3;

export function computeScore(inb: ScoreInputs): CrewScore {
  const completedCount = Math.max(0, Math.floor(inb.completedCount || 0));
  const ratedCount = Math.max(0, Math.floor(inb.ratedCount || 0));
  const onTimeCount = Math.max(0, Math.min(Math.floor(inb.onTimeCount || 0), ratedCount));
  const approved = Math.max(0, Math.floor(inb.flagsApproved || 0));
  const declined = Math.max(0, Math.floor(inb.flagsDeclined || 0));
  const noShows = Math.max(0, Math.floor(inb.noShows || 0));

  // Benefit of the doubt when there's no data yet (new crews aren't punished).
  const onTimeRate = ratedCount > 0 ? clamp01(onTimeCount / ratedCount) : 1;
  const flagAccuracy = approved + declined > 0 ? clamp01(approved / (approved + declined)) : 1;
  // Reliability: commitments honored vs ghosted. Recovers as they complete more,
  // so a miss dents the score but a crew earns trust back — no permanent brand.
  const reliabilityRate = completedCount + noShows > 0 ? clamp01(completedCount / (completedCount + noShows)) : 1;

  const rawQuality = 0.45 * onTimeRate + 0.2 * flagAccuracy + 0.35 * reliabilityRate; // 0–1
  const confidence = clamp01(completedCount / CONFIDENCE_JOBS); // 0–1
  // A new crew (confidence 0) starts at half its raw quality, so proven crews
  // rank above unproven ones — but a new crew still scores enough to earn work.
  const score = Math.round(100 * (0.5 + 0.5 * confidence) * rawQuality);

  let tier: CrewTier;
  if (completedCount < NEW_MAX_JOBS) tier = "new";
  // A repeat ghost (2+ no-shows) can't be Priority no matter the raw score.
  else if (completedCount >= PRIORITY_MIN_JOBS && score >= PRIORITY_MIN_SCORE && noShows <= 1) tier = "priority";
  else tier = "building";

  const nextTierHint =
    noShows > 0 && tier !== "priority"
      ? "Missed jobs hurt your standing — show up on scheduled days to recover it."
      : tier === "priority"
        ? "You're Priority — first pick of new work. Keep it up."
        : tier === "new"
          ? `A few more completed jobs and a solid on-time record moves you up.`
          : onTimeRate < 0.9
            ? "Finish jobs on their scheduled day to climb toward Priority."
            : `${Math.max(0, PRIORITY_MIN_JOBS - completedCount)} more strong jobs could reach Priority.`;

  return { score, tier, onTimeRate, flagAccuracy, reliabilityRate, noShows, confidence, completedCount, nextTierHint };
}

/** Human label + short descriptor for a tier (crew-facing, never shows peers). */
export function tierLabel(tier: CrewTier): { label: string; blurb: string } {
  switch (tier) {
    case "priority":
      return { label: "Priority ⭐", blurb: "First pick of new jobs on your lakes." };
    case "building":
      return { label: "Building", blurb: "Growing your standing — keep completing on time." };
    default:
      return { label: "New", blurb: "Welcome — complete your first jobs to build standing." };
  }
}
