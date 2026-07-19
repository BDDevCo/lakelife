"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { assertOps } from "./data";

export interface CrewResult {
  ok: boolean;
  error?: string;
}

/** Clamp to a whole-number daily capacity in the allowed 1–20 range. */
function validCapacity(n: unknown): number | null {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 20) return null;
  return v;
}

/**
 * Re-check the "no COI, no jobs" gate server-side before a crew can go active.
 * A crew is routable only with a COI document, a W-9 document, and a COI expiry
 * that is still in the future. Returns an error string, or null if clear.
 */
async function assertRoutable(admin: ReturnType<typeof createServiceClient>, vendorId: string): Promise<string | null> {
  const { data: v } = await admin
    .from("vendors")
    .select("id, coi_url, w9_url, coi_expiry")
    .eq("id", vendorId)
    .maybeSingle();
  if (!v) return "That crew doesn't exist.";
  if (!v.coi_url) return "No insurance certificate (COI) on file — the crew must upload one before they can be routed.";
  if (!v.w9_url) return "No W-9 on file — the crew must upload one before they can be routed.";
  if (v.coi_expiry == null || String(v.coi_expiry) < todayLakeDate()) {
    return "The COI on file is missing an expiry or already expired — get a current certificate first.";
  }
  return null;
}

/**
 * Approve an onboarding (or re-approve a suspended) crew: verifies documents +
 * an unexpired COI, then flips status to 'active' and sets the daily capacity.
 * This is the gate — the router only touches active crews with a valid COI.
 */
export async function approveCrew(vendorId: string, dailyCapacity: number): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const cap = validCapacity(dailyCapacity);
  if (cap == null) return { ok: false, error: "Daily capacity must be a whole number from 1 to 20." };

  const admin = createServiceClient();
  const gate = await assertRoutable(admin, vendorId);
  if (gate) return { ok: false, error: gate };

  const { error } = await admin
    .from("vendors")
    .update({ status: "active", daily_capacity: cap })
    .eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Take a crew off the board — no new routing until reactivated. */
export async function suspendCrew(vendorId: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ status: "suspended" }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Bring a suspended crew back. Re-runs the full document + COI gate because the
 * COI may have lapsed while they were off the board (spec: no COI, no jobs).
 */
export async function reactivateCrew(vendorId: string): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const admin = createServiceClient();
  const gate = await assertRoutable(admin, vendorId);
  if (gate) return { ok: false, error: gate };

  const { error } = await admin.from("vendors").update({ status: "active" }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Adjust a crew's daily job capacity (1–20). */
export async function setCrewCapacity(vendorId: string, n: number): Promise<CrewResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!vendorId) return { ok: false, error: "No crew selected." };

  const cap = validCapacity(n);
  if (cap == null) return { ok: false, error: "Daily capacity must be a whole number from 1 to 20." };

  const admin = createServiceClient();
  const { error } = await admin.from("vendors").update({ daily_capacity: cap }).eq("id", vendorId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
