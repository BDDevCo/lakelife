import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import { getMyVendorId } from "./data";
import { buildRateForm, type RateForm } from "./rates-helpers";

export interface MyRate {
  service_id: string;
  name: string;
  pricing_model: PricingModel;
  form: RateForm; // inputs + current values (NEVER any customer price)
  hasRate: boolean; // the crew has saved a rate for this service
}

/**
 * The services the signed-in crew does (their service_types ∩ active services),
 * each joined with their existing private vendor_rates row (may be null). All
 * reads are service-role after asserting the caller owns a vendors row — so a
 * still-onboarding crew can set rates, and RLS can't hide their own row.
 *
 * CLAUDE.md rule 1: nothing here reads a customer/menu price. We read only the
 * service's pricing STRUCTURE (model + band boundaries) and the crew's own rate.
 */
export async function getMyRates(): Promise<MyRate[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];

  const admin = createServiceClient();
  const { data: vendor } = await admin
    .from("vendors")
    .select("service_types")
    .eq("id", vendorId)
    .maybeSingle();
  const myServices = new Set((vendor?.service_types as string[] | null) ?? []);
  if (myServices.size === 0) return [];

  const { data: svcs } = await admin
    .from("services")
    .select("id, name, pricing_model, band_pricing")
    .eq("active", true)
    .order("name");
  const services = (svcs ?? []).filter((s) => myServices.has(s.name as string));
  if (services.length === 0) return [];

  const { data: rates } = await admin
    .from("vendor_rates")
    .select("service_id, base, unit_rate, band_pricing")
    .eq("vendor_id", vendorId);
  const rateBy = new Map((rates ?? []).map((r) => [r.service_id as string, r]));

  return services.map((s) => {
    const existing = rateBy.get(s.id as string);
    const form = buildRateForm(
      {
        pricing_model: s.pricing_model as PricingModel,
        band_pricing: (s.band_pricing as PricingParams | null) ?? null,
      },
      existing
        ? {
            base: existing.base as number | null,
            unit_rate: existing.unit_rate as number | null,
            band_pricing: (existing.band_pricing as PricingParams | null) ?? null,
          }
        : null,
    );
    return {
      service_id: s.id as string,
      name: s.name as string,
      pricing_model: s.pricing_model as PricingModel,
      form,
      hasRate: !!existing,
    };
  });
}
