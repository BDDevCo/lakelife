"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import { computeRateRow, type RatePayload } from "./rates-helpers";

export interface RateResult {
  ok: boolean;
  error?: string;
  /** A rate is now on file, so the crew is in the pool (real floor check is at
   *  dispatch — we never reveal margin here). */
  qualifies?: boolean;
  /** Friendly, price-free confirmation for the crew. */
  signal?: string;
}

/**
 * Confirm the signed-in user owns a vendors row. Identity is asserted with the
 * SESSION client (auth.getUser); the row is read with the SERVICE client so a
 * still-onboarding record isn't hidden by RLS. NEVER trust a vendorId from the
 * browser. Mirrors assertMyVendor in onboarding-actions.ts.
 */
async function assertMyVendor(): Promise<{ id: string; status: string; serviceTypes: string[] } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("vendors")
    .select("id, status, service_types")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    status: data.status as string,
    serviceTypes: (data.service_types as string[] | null) ?? [],
  };
}

/**
 * Save the signed-in crew's PRIVATE take-home rate for one service, in their own
 * units. The serviceId is whitelisted against the crew's own service_types AND
 * the active services table, so a tampered client can't price work it doesn't do
 * or an inactive service. computeRateRow re-derives all pricing STRUCTURE from
 * the authoritative service row — the crew only supplies dollars.
 *
 * CLAUDE.md rule 1: we never load, compute, or return a customer/menu price or
 * margin. The routing/floor decision happens later in the dispatch engine; the
 * only client-facing signal is a generic "you're in the pool" confirmation. The
 * optional relational hint compares to the crew's OWN previous rate — never the
 * menu.
 */
export async function setMyRate(serviceId: string, payload: RatePayload): Promise<RateResult> {
  const vendor = await assertMyVendor();
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet — call dispatch." };
  if (vendor.status === "suspended") {
    return { ok: false, error: "Your crew account is paused — call LakeLife dispatch." };
  }
  if (typeof serviceId !== "string" || !serviceId) return { ok: false, error: "Unknown service." };

  const admin = createServiceClient();
  const { data: svc } = await admin
    .from("services")
    .select("id, name, pricing_model, band_pricing, active")
    .eq("id", serviceId)
    .maybeSingle();
  if (!svc || !svc.active || !vendor.serviceTypes.includes(svc.name as string)) {
    return { ok: false, error: "That service isn't one you do." };
  }

  const built = computeRateRow(
    {
      pricing_model: svc.pricing_model as PricingModel,
      band_pricing: (svc.band_pricing as PricingParams | null) ?? null,
    },
    payload,
  );
  if (!built.ok || !built.row) return { ok: false, error: built.error ?? "Enter a valid dollar amount." };

  // Relational-only signal: did this crew already have a rate here? (own history,
  // never the menu). Used purely to word the confirmation.
  const { data: prev } = await admin
    .from("vendor_rates")
    .select("id")
    .eq("vendor_id", vendor.id)
    .eq("service_id", serviceId)
    .maybeSingle();

  const { error } = await admin.from("vendor_rates").upsert(
    {
      vendor_id: vendor.id,
      service_id: serviceId,
      base: built.row.base,
      unit_rate: built.row.unit_rate,
      band_pricing: built.row.band_pricing,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "vendor_id,service_id" },
  );
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    qualifies: true,
    signal: prev
      ? "Rate updated — you'll be considered for matching jobs."
      : "Saved — you'll be considered for matching jobs.",
  };
}
