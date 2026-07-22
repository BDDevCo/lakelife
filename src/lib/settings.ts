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
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  marginFloor: 0.25,
  surgeCapPct: 0.25,
  cancelFeePct: 0.25,
  cancelRoutineHours: 48,
  cancelWaterDays: 7,
  lakeStrikeLimit: 2,
  lakeDemotionCooldownDays: 30,
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
      .in("key", ["margin_floor", "surge_cap_pct", "cancel_fee_pct", "cancel_routine_hours", "cancel_water_days", "lake_strike_limit", "lake_demotion_cooldown_days"]);
    const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value]));
    return {
      marginFloor: parseSetting(byKey.get("margin_floor"), DEFAULT_SETTINGS.marginFloor, 0.05, 0.6),
      surgeCapPct: parseSetting(byKey.get("surge_cap_pct"), DEFAULT_SETTINGS.surgeCapPct, 0, 1),
      cancelFeePct: parseSetting(byKey.get("cancel_fee_pct"), DEFAULT_SETTINGS.cancelFeePct, 0, 1),
      cancelRoutineHours: parseSetting(byKey.get("cancel_routine_hours"), DEFAULT_SETTINGS.cancelRoutineHours, 0, 24 * 14),
      cancelWaterDays: parseSetting(byKey.get("cancel_water_days"), DEFAULT_SETTINGS.cancelWaterDays, 0, 60),
      lakeStrikeLimit: parseSetting(byKey.get("lake_strike_limit"), DEFAULT_SETTINGS.lakeStrikeLimit, 1, 10),
      lakeDemotionCooldownDays: parseSetting(byKey.get("lake_demotion_cooldown_days"), DEFAULT_SETTINGS.lakeDemotionCooldownDays, 1, 365),
    };
  } catch {
    return DEFAULT_SETTINGS; // table missing / transient error → today's values
  }
});
