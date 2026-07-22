"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { loadPricingProfileById } from "@/app/book/dispatch";

/**
 * AUTOPILOT enrollment (§8d) — a PER-SERVICE toggle, never a bundle. Turning a
 * service on freezes the customer's all-in price at TODAY's menu level (the
 * rate-lock perk): every Autopilot booking for the season is created at that
 * locked price, even if the menu moves. Turning it off stops future proposals;
 * it never touches already-booked jobs.
 */

export interface AutopilotResult {
  ok: boolean;
  error?: string;
  lockedPrice?: number;
}

export async function setAutopilot(propertyId: string, serviceId: string, on: boolean): Promise<AutopilotResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  if (!propertyId || !serviceId) return { ok: false, error: "Pick a service first." };

  // Ownership — never trust ids from the browser.
  const { data: own } = await supabase
    .from("properties")
    .select("id")
    .eq("owner_id", user.id)
    .eq("id", propertyId)
    .maybeSingle();
  if (!own) return { ok: false, error: "That property isn't yours." };

  const admin = createServiceClient();

  if (!on) {
    const { error } = await admin
      .from("autopilot_enrollments")
      .update({ active: false })
      .eq("property_id", propertyId)
      .eq("service_id", serviceId);
    if (error) return { ok: false, error: error.message };
    // Withdraw any open proposal so a stale text link can't book later.
    const { data: enr } = await admin
      .from("autopilot_enrollments")
      .select("id")
      .eq("property_id", propertyId)
      .eq("service_id", serviceId)
      .maybeSingle();
    if (enr) {
      await admin.from("autopilot_events").update({ status: "expired" }).eq("enrollment_id", enr.id).eq("status", "proposed");
    }
    return { ok: true };
  }

  // Lock TODAY's menu price for this property (rule 8: priced from the DB).
  const { data: svc } = await admin
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, active")
    .eq("id", serviceId)
    .maybeSingle();
  if (!svc || svc.active === false) return { ok: false, error: "That service isn't available." };
  const profile = await loadPricingProfileById(admin, propertyId);
  if (!profile) return { ok: false, error: "Set up your property profile first." };
  const locked = priceService(
    {
      name: svc.name as string,
      pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
      base: Number(svc.base ?? 0),
      unit_rate: Number(svc.unit_rate ?? 0),
      band_pricing: (svc.band_pricing as ServiceRule["band_pricing"]) ?? null,
    },
    profile,
  );
  if (!(locked > 0)) return { ok: false, error: "We couldn't price this service for your place — check your property profile." };

  const { error } = await admin
    .from("autopilot_enrollments")
    .upsert(
      { property_id: propertyId, service_id: serviceId, locked_price: locked, active: true, enrolled_at: new Date().toISOString() },
      { onConflict: "property_id,service_id" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true, lockedPrice: locked };
}
