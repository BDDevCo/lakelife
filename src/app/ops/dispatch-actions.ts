"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { autoAssignJob } from "@/app/book/dispatch";
import { assertOps } from "./data";

export interface RetryResult {
  ok: boolean;
  assigned: boolean;
  error?: string;
}

/**
 * Re-run the auto-dispatch engine for one stuck job (ops only). Same code path
 * the nightly self-heal uses — the machine picks the crew; this just runs it
 * early. Returns whether a crew was found and applied.
 */
export async function retryAssign(jobId: string): Promise<RetryResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, assigned: false, error: "Ops only." };
  if (!jobId) return { ok: false, assigned: false, error: "No job selected." };

  try {
    const outcome = await autoAssignJob(jobId);
    return { ok: true, assigned: outcome.assigned };
  } catch (e) {
    return { ok: false, assigned: false, error: e instanceof Error ? e.message : "Couldn't run dispatch." };
  }
}

export interface PreferredResult {
  ok: boolean;
  error?: string;
}

/**
 * Set (or clear, with vendorId null) a property's preferred crew (ops only).
 * A preferred crew gets first right of refusal at dispatch, so we only allow an
 * active crew that actually does at least one service (has a private rate on
 * file, or lists service types). Clearing needs no vendor validation.
 */
export async function setPreferredCrew(propertyId: string, vendorId: string | null): Promise<PreferredResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  if (!propertyId) return { ok: false, error: "No property selected." };

  const admin = createServiceClient();

  if (vendorId) {
    const { data: vendor } = await admin
      .from("vendors")
      .select("id, status, service_types")
      .eq("id", vendorId)
      .maybeSingle();
    if (!vendor) return { ok: false, error: "That crew doesn't exist." };
    if (vendor.status !== "active") return { ok: false, error: "Only an active crew can be a preferred crew." };

    // "Does at least one service" — a private rate set, or listed service types.
    const { count: rateCount } = await admin
      .from("vendor_rates")
      .select("id", { count: "exact", head: true })
      .eq("vendor_id", vendorId);
    const listsService = ((vendor.service_types as string[] | null) ?? []).length > 0;
    if (!(rateCount && rateCount > 0) && !listsService) {
      return { ok: false, error: "That crew doesn't do any service yet — set a rate or service type first." };
    }
  }

  const { error } = await admin
    .from("properties")
    .update({ preferred_vendor: vendorId })
    .eq("id", propertyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
