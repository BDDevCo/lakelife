import "server-only";
import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Owner-tunable pricing dials, read from platform_settings (rule 8: pricing
 * rules live in the database). Graceful defaults mean the app keeps working
 * (at today's effective values) even before migration 0018 runs — the engine
 * must never crash over a missing dial.
 */

export interface PlatformSettings {
  /** Min share of the menu price LakeLife keeps (crew ineligible below it). */
  marginFloor: number;
  /** Max scarcity uplift over menu price the machine may OFFER a customer. */
  surgeCapPct: number;
  /** Late-cancellation fee as a share of the all-in price (0 = free always). */
  cancelFeePct: number;
  /** Routine services: cancelling is free until this many hours before start. */
  cancelRoutineHours: number;
  /** Water work: cancelling is free until this many days before the date. */
  cancelWaterDays: number;
  /** Net strikes (no-shows − completions) on ONE lake that auto-pause a crew there. */
  lakeStrikeLimit: number;
  /** How long a lake pause lasts before the crew can work that lake again. */
  lakeDemotionCooldownDays: number;
  /** Days before an UNFILLED job's date the customer gets the options text. */
  waitlistWarningDays: number;
  /** Same-day rush premium over menu price (0.25 = +25%). */
  sameDaySurchargePct: number;
  /** Fill-in discount off the crew's own rate for same-day claims (0.15). */
  sameDayFillDiscountPct: number;
  /** Lake-time hour when same-day booking/claiming closes (14 = 2pm). */
  sameDayCutoffHour: number;
  /** Homeowner→homeowner referral: % of the referee's collected spend. */
  referralCustomerPct: number;
  /** Importing crew's finder's fee on services they DON'T perform. */
  referralCrossSellPct: number;
  /** Crew-bringer bounty: share of collected margin from the brought crew... */
  referralCrewSharePct: number;
  /** ...until this lifetime cap per (referrer, crew) pair. */
  referralCrewCap: number;
  /** Customer-spend referral arms sunset after this many days. */
  referralSunsetDays: number;
  /** Accruals mature (become spendable) after this clawback window. */
  referralMaturationDays: number;
  /** Credit balance that triggers the "covers a visit" nudge. */
  nudgeCreditThreshold: number;
  /** Per-kind, per-user quiet period between growth nudges. */
  nudgeCooldownDays: number;
  /** Storage overstay: dollars per day past the season end (margin-weighted like all money). */
  storagePerdiemDaily: number;
  /** Storage season ends on this month/day — per-diem accrues after it. */
  storageSeasonEndMonth: number;
  storageSeasonEndDay: number;
  /** Early-payout ("get it now") fee as a share of the batch gross. */
  earlyPayoutFeePct: number;
  /** Fill-in offers: share of the crew's own anchor rate they're offered. */
  gapAnchorPct: number;
  /** Fill-in offers: smallest offer worth posting (dust guard, floor $20). */
  gapMinOffer: number;
  /** Hours a fill-in-eligible job may sit unclaimed before the ops SLA alert. */
  gapSlaHours: number;
  /** Fill-in digest: don't email a crew under this many offer dollars. */
  fillinDigestMin: number;
  /** Fill-in digest: per-crew quiet period between digests. */
  fillinDigestCooldownDays: number;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  marginFloor: 0.25,
  surgeCapPct: 0.25,
  cancelFeePct: 0.25,
  cancelRoutineHours: 48,
  cancelWaterDays: 7,
  lakeStrikeLimit: 2,
  lakeDemotionCooldownDays: 30,
  waitlistWarningDays: 2,
  sameDaySurchargePct: 0.25,
  sameDayFillDiscountPct: 0.15,
  sameDayCutoffHour: 14,
  referralCustomerPct: 0.05,
  referralCrossSellPct: 0.05,
  referralCrewSharePct: 0.25,
  referralCrewCap: 250,
  referralSunsetDays: 365,
  referralMaturationDays: 30,
  nudgeCreditThreshold: 50,
  nudgeCooldownDays: 30,
  storagePerdiemDaily: 10,
  storageSeasonEndMonth: 5,
  storageSeasonEndDay: 31,
  earlyPayoutFeePct: 0.02,
  gapAnchorPct: 0.95,
  gapMinOffer: 20,
  gapSlaHours: 72,
  fillinDigestMin: 200,
  fillinDigestCooldownDays: 30,
};

/** Clamp a raw stored value into a sane band; fall back on anything weird. */
export function parseSetting(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** One DB read per request (React cache): every engine path sees the same dials. */
export const getPlatformSettings = cache(async (): Promise<PlatformSettings> => {
  try {
    const admin = createServiceClient();
    const { data } = await admin
      .from("platform_settings")
      .select("key, value")
      .in("key", ["margin_floor", "surge_cap_pct", "cancel_fee_pct", "cancel_routine_hours", "cancel_water_days", "lake_strike_limit", "lake_demotion_cooldown_days", "waitlist_warning_days", "same_day_surcharge_pct", "same_day_fill_discount_pct", "same_day_cutoff_hour", "referral_customer_pct", "referral_cross_sell_pct", "referral_crew_share_pct", "referral_crew_cap", "referral_sunset_days", "referral_maturation_days", "nudge_credit_threshold", "nudge_cooldown_days", "storage_perdiem_daily", "storage_season_end_month", "storage_season_end_day", "early_payout_fee_pct", "gap_anchor_pct", "gap_min_offer", "gap_sla_hours", "fillin_digest_min", "fillin_digest_cooldown_days"]);
    const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value]));
    return {
      marginFloor: parseSetting(byKey.get("margin_floor"), DEFAULT_SETTINGS.marginFloor, 0.05, 0.6),
      surgeCapPct: parseSetting(byKey.get("surge_cap_pct"), DEFAULT_SETTINGS.surgeCapPct, 0, 1),
      cancelFeePct: parseSetting(byKey.get("cancel_fee_pct"), DEFAULT_SETTINGS.cancelFeePct, 0, 1),
      cancelRoutineHours: parseSetting(byKey.get("cancel_routine_hours"), DEFAULT_SETTINGS.cancelRoutineHours, 0, 24 * 14),
      cancelWaterDays: parseSetting(byKey.get("cancel_water_days"), DEFAULT_SETTINGS.cancelWaterDays, 0, 60),
      lakeStrikeLimit: parseSetting(byKey.get("lake_strike_limit"), DEFAULT_SETTINGS.lakeStrikeLimit, 1, 10),
      lakeDemotionCooldownDays: parseSetting(byKey.get("lake_demotion_cooldown_days"), DEFAULT_SETTINGS.lakeDemotionCooldownDays, 1, 365),
      waitlistWarningDays: parseSetting(byKey.get("waitlist_warning_days"), DEFAULT_SETTINGS.waitlistWarningDays, 1, 14),
      sameDaySurchargePct: parseSetting(byKey.get("same_day_surcharge_pct"), DEFAULT_SETTINGS.sameDaySurchargePct, 0, 1),
      sameDayFillDiscountPct: parseSetting(byKey.get("same_day_fill_discount_pct"), DEFAULT_SETTINGS.sameDayFillDiscountPct, 0, 0.5),
      sameDayCutoffHour: parseSetting(byKey.get("same_day_cutoff_hour"), DEFAULT_SETTINGS.sameDayCutoffHour, 0, 23),
      referralCustomerPct: parseSetting(byKey.get("referral_customer_pct"), DEFAULT_SETTINGS.referralCustomerPct, 0, 0.2),
      referralCrossSellPct: parseSetting(byKey.get("referral_cross_sell_pct"), DEFAULT_SETTINGS.referralCrossSellPct, 0, 0.2),
      referralCrewSharePct: parseSetting(byKey.get("referral_crew_share_pct"), DEFAULT_SETTINGS.referralCrewSharePct, 0, 0.5),
      referralCrewCap: parseSetting(byKey.get("referral_crew_cap"), DEFAULT_SETTINGS.referralCrewCap, 0, 2000),
      referralSunsetDays: parseSetting(byKey.get("referral_sunset_days"), DEFAULT_SETTINGS.referralSunsetDays, 30, 3650),
      referralMaturationDays: parseSetting(byKey.get("referral_maturation_days"), DEFAULT_SETTINGS.referralMaturationDays, 0, 120),
      nudgeCreditThreshold: parseSetting(byKey.get("nudge_credit_threshold"), DEFAULT_SETTINGS.nudgeCreditThreshold, 5, 1000),
      nudgeCooldownDays: parseSetting(byKey.get("nudge_cooldown_days"), DEFAULT_SETTINGS.nudgeCooldownDays, 7, 120),
      storagePerdiemDaily: parseSetting(byKey.get("storage_perdiem_daily"), DEFAULT_SETTINGS.storagePerdiemDaily, 0, 100),
      storageSeasonEndMonth: parseSetting(byKey.get("storage_season_end_month"), DEFAULT_SETTINGS.storageSeasonEndMonth, 1, 12),
      storageSeasonEndDay: parseSetting(byKey.get("storage_season_end_day"), DEFAULT_SETTINGS.storageSeasonEndDay, 1, 31),
      earlyPayoutFeePct: parseSetting(byKey.get("early_payout_fee_pct"), DEFAULT_SETTINGS.earlyPayoutFeePct, 0, 0.1),
      gapAnchorPct: parseSetting(byKey.get("gap_anchor_pct"), DEFAULT_SETTINGS.gapAnchorPct, 0.8, 1),
      gapMinOffer: parseSetting(byKey.get("gap_min_offer"), DEFAULT_SETTINGS.gapMinOffer, 20, 500),
      gapSlaHours: parseSetting(byKey.get("gap_sla_hours"), DEFAULT_SETTINGS.gapSlaHours, 12, 240),
      fillinDigestMin: parseSetting(byKey.get("fillin_digest_min"), DEFAULT_SETTINGS.fillinDigestMin, 0, 5000),
      fillinDigestCooldownDays: parseSetting(byKey.get("fillin_digest_cooldown_days"), DEFAULT_SETTINGS.fillinDigestCooldownDays, 7, 120),
    };
  } catch {
    return DEFAULT_SETTINGS; // table missing / transient error → today's values
  }
});
