import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";
import type { PackageView, PackageComponentView } from "@/lib/packages";

/**
 * Load the storage/winterize packages priced against ONE property.
 * Customer prices only (the wizard is a customer surface — rule 1); the
 * crew side of every leg lives in vendor_rates and never leaves the
 * server. Components may be active=false (hidden from ordinary menus by
 * the kind filter) — the PACKAGE's active flag is the launch switch.
 */
export async function getPackageViews(profile: PricingProfile): Promise<PackageView[]> {
  const admin = createServiceClient();
  const [{ data: packages }, { data: recipe }, { data: services }] = await Promise.all([
    admin.from("service_packages").select("id, code, name, description, sort").eq("active", true).order("sort"),
    admin.from("package_components").select("package_id, service_id, phase, required, default_on"),
    admin.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing, kind").in("kind", ["component", "addon"]),
  ]);
  if (!packages?.length) return [];

  const svcById = new Map((services ?? []).map((s) => [s.id as string, s]));

  return packages.map((p) => {
    const components: PackageComponentView[] = (recipe ?? [])
      .filter((r) => r.package_id === p.id)
      .flatMap((r) => {
        const svc = svcById.get(r.service_id as string);
        if (!svc) return [];
        const rule: ServiceRule = {
          name: svc.name as string,
          pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
          base: Number(svc.base ?? 0),
          unit_rate: Number(svc.unit_rate ?? 0),
          band_pricing: (svc.band_pricing as ServiceRule["band_pricing"]) ?? null,
        };
        return [{
          serviceId: svc.id as string,
          name: svc.name as string,
          phase: r.phase as "fall" | "spring",
          required: Boolean(r.required),
          defaultOn: Boolean(r.default_on),
          kind: (svc.kind as "component" | "addon") ?? "component",
          pricingModel: svc.pricing_model as string,
          price: priceService(rule, profile),
          isStorageTier: svc.pricing_model === "seasonal_plus_perdiem",
        }];
      })
      .sort((a, b) => (a.phase === b.phase ? (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1) : a.phase === "fall" ? -1 : 1));
    return {
      id: p.id as string,
      code: p.code as string,
      name: p.name as string,
      description: (p.description as string) ?? null,
      components,
    };
  });
}
