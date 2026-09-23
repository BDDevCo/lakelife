"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";

/**
 * Owner-tunable pricing dials (Phase C, widened by 0174). Ops-only; values are
 * clamped to sane bands so a typo can't wreck dispatch (floor 5–60%, surge cap
 * 0–100%, each platform fee 0–50%). The engine reads these per-request — a
 * change applies to the NEXT assignment, never retroactively.
 *
 * THE TWO PLATFORM FEES ARE FROZEN ONTO EACH JOB AT BOOKING
 * (jobs.fee_customer_pct / jobs.fee_crew_pct), so moving one here can never
 * reprice work already sold. What it DOES change immediately is what a crew's
 * rates page forecasts and what the next job is quoted at.
 *
 * The crew-side clamp stops at 50% on purpose: the arithmetic refuses 1.0
 * outright (it would pay a contractor $0 through a row that looks deliberate),
 * and anything approaching it is a number nobody should be able to type into a
 * box by accident on a screen with no confirm step.
 */

export interface SettingsResult {
  ok: boolean;
  error?: string;
}

export async function updatePlatformSettings(
  marginFloorPct: number,
  surgeCapPctIn: number,
  // OPTIONAL SO THE OLD TWO-ARGUMENT CALL STILL MEANS WHAT IT MEANT. Omitted,
  // the fee rows are not written at all — a caller that does not know about
  // them cannot silently stamp a default over a number he has since tuned.
  feeCustomerPctIn?: number,
  feeCrewPctIn?: number,
): Promise<SettingsResult> {
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

  const rows: Array<{ key: string; value: number; updated_at: string }> = [];
  const now = new Date().toISOString();
  rows.push({ key: "margin_floor", value: floor, updated_at: now });
  rows.push({ key: "surge_cap_pct", value: cap, updated_at: now });

  if (feeCustomerPctIn !== undefined) {
    const c = Number(feeCustomerPctIn) / 100;
    if (!Number.isFinite(c) || c < 0 || c > 0.5) {
      return { ok: false, error: "The customer fee must be between 0% and 50%." };
    }
    rows.push({ key: "platform_fee_customer_pct", value: c, updated_at: now });
  }
  if (feeCrewPctIn !== undefined) {
    const k = Number(feeCrewPctIn) / 100;
    if (!Number.isFinite(k) || k < 0 || k > 0.5) {
      return { ok: false, error: "The crew fee must be between 0% and 50%." };
    }
    rows.push({ key: "platform_fee_crew_pct", value: k, updated_at: now });
  }

  const admin = createServiceClient();
  const { error } = await admin.from("platform_settings").upsert(rows);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
