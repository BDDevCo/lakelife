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
}

export const DEFAULT_SETTINGS: PlatformSettings = { marginFloor: 0.25, surgeCapPct: 0.25 };

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
    const { data } = await admin.from("platform_settings").select("key, value").in("key", ["margin_floor", "surge_cap_pct"]);
    const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value]));
    return {
      marginFloor: parseSetting(byKey.get("margin_floor"), DEFAULT_SETTINGS.marginFloor, 0.05, 0.6),
      surgeCapPct: parseSetting(byKey.get("surge_cap_pct"), DEFAULT_SETTINGS.surgeCapPct, 0, 1),
    };
  } catch {
    return DEFAULT_SETTINGS; // table missing / transient error → today's values
  }
});
