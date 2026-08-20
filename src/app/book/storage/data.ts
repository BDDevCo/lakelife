import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
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
  const [packagesRes, recipeRes, servicesRes] = await Promise.all([
    admin.from("service_packages").select("id, code, name, description, sort").eq("active", true).order("sort"),
    admin.from("package_components").select("package_id, service_id, phase, required, default_on, role"),
    admin.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing, kind").in("kind", ["component", "addon"]),
  ]);
  // The recipe and the component prices ARE the package price. A failed read of
  // either would render a package with legs missing — priced, bookable, and
  // wrong — and a failed package read would say we don't offer storage at all.
  const packages = mustRead("the storage packages", packagesRes);
  const recipe = mustRead("what's in each package", recipeRes);
  const services = mustRead("the prices of each part of the package", servicesRes);
  if (!packages?.length) return [];

  const svcById = new Map((services ?? []).map((s) => [s.id as string, s]));

  const empty: string[] = [];
  const views = packages.map((p) => {
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
          // Audit bug 7: the legality rails key on this stable tag, never on
          // the service's display name. Migration 0051 populates it.
          role: (r.role as PackageComponentView["role"]) ?? null,
          pricingModel: svc.pricing_model as string,
          price: priceService(rule, profile),
          isStorageTier: svc.pricing_model === "seasonal_plus_perdiem",
        }];
      })
      .sort((a, b) => (a.phase === b.phase ? (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1) : a.phase === "fall" ? -1 : 1));
    if (components.length === 0) empty.push((p.code as string) ?? (p.id as string));
    return {
      id: p.id as string,
      code: p.code as string,
      name: p.name as string,
      description: (p.description as string) ?? null,
      components,
    };
  });

  // A PACKAGE WITH NOTHING IN IT IS NOT AN OFFER.
  //
  // An active service_packages row whose package_components rows are missing —
  // or whose services have since been retired — priced at $0 and rendered as a
  // tile: real name, real description, "From $0", and a Book button. Opening it
  // showed "Nothing scheduled this fall", "Nothing scheduled next spring", and
  // an enabled confirm reading "Book — $0". Tapping it got "Nothing selected
  // for the fall visit", which is true and unactionable — the customer chose
  // nothing because there was nothing to choose.
  //
  // So it does not appear. It is a configuration mistake, not a product, and
  // the customer is not the right person to discover it. Logged by code so ops
  // finds out from the server log rather than from somebody ringing up about a
  // free winterization.
  if (empty.length > 0) {
    console.error(
      `[storage] ${empty.length} active package(s) have no bookable components and were hidden: ${empty.join(", ")}. ` +
      `Check package_components, and that their services still exist with kind component/addon.`,
    );
  }
  return views.filter((v) => v.components.length > 0);
}
