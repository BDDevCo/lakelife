"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * Owner-tunable pricing dials (Phase C). Ops-only; values are clamped to sane
 * bands so a typo can't wreck dispatch (floor 5–60%, surge cap 0–100%). The
 * engine reads these per-request — a change applies to the NEXT assignment,
 * never retroactively (booked prices are locked at booking).
 */

export interface SettingsResult {
  ok: boolean;
  error?: string;
}

export async function updatePlatformSettings(marginFloorPct: number, surgeCapPctIn: number): Promise<SettingsResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };

  const floor = Number(marginFloorPct) / 100;
  const cap = Number(surgeCapPctIn) / 100;
  if (!Number.isFinite(floor) || floor < 0.05 || floor > 0.6) {
    return { ok: false, error: "Margin floor must be between 5% and 60%." };
  }
  if (!Number.isFinite(cap) || cap < 0 || cap > 1) {
    return { ok: false, error: "Surge cap must be between 0% and 100%." };
  }

  const admin = createServiceClient();
  const now = new Date().toISOString();
  const { error } = await admin.from("platform_settings").upsert([
    { key: "margin_floor", value: floor, updated_at: now },
    { key: "surge_cap_pct", value: cap, updated_at: now },
  ]);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
