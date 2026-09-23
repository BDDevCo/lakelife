import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import { mustRead } from "@/lib/must-read";
import { getMyVendorId } from "./data";
import { buildRateForm, type RateForm } from "./rates-helpers";
import { getPlatformSettings } from "@/lib/settings";
import type { PlatformFee } from "@/lib/platform-fee";

export interface MyRate {
  service_id: string;
  name: string;
  pricing_model: PricingModel;
  /** 'standalone' = a menu service the crew opted into; 'component'/'addon' =
   *  a winter/storage leg — priceable even though it's hidden from the menu
   *  (services.active = false) until the packages ship. */
  kind: "standalone" | "component" | "addon";
  form: RateForm; // inputs + current values (NEVER any customer price)
  hasRate: boolean; // the crew has saved a rate for this service
  /**
   * services.crew_priced (0174) — whether what the crew types here is a QUOTE
   * (LakeLife adds a published % for the customer and takes a published % out
   * of it) or their take-home, which is what it has always meant. The form
   * carries the sentences; this flag is here so a caller can group or count
   * without reaching into the fields.
   */
  crewPriced: boolean;
}

/**
 * The services the signed-in crew can price: their service_types ∩ active
 * STANDALONE services, PLUS every component/addon service regardless of its
 * active flag or the crew's service_types (there's no menu-selection step for
 * those yet — they're winter/storage legs, gated by an explicit rate instead).
 * Each is joined with the crew's existing private vendor_rates row (may be
 * null). All reads are service-role after asserting the caller owns a vendors
 * row — so a still-onboarding crew can set rates, and RLS can't hide their
 * own row.
 *
 * CLAUDE.md rule 1: nothing here reads a customer/menu price. We read only the
 * service's pricing STRUCTURE (model + band boundaries) and the crew's own rate.
 */
export async function getMyRates(): Promise<MyRate[]> {
  const vendorId = await getMyVendorId();
  if (!vendorId) return [];

  const admin = createServiceClient();
  // A failed read here empties `myServices`, and the filter below then hides
  // every standalone service the crew actually does — the rates screen would
  // show only the winter legs and read as "you're not set up for this work".
  const vendor = mustRead(
    "the work you signed up for",
    await admin
      .from("vendors")
      .select("service_types")
      .eq("id", vendorId)
      .maybeSingle(),
  );
  const myServices = new Set((vendor?.service_types as string[] | null) ?? []);

  const svcs = mustRead(
    "the services you can price",
    await admin
      .from("services")
      .select("id, name, pricing_model, band_pricing, kind, active, crew_priced")
      .order("name"),
  );
  const services = (svcs ?? []).filter((s) => {
    const kind = ((s.kind as string | null) ?? "standalone") as MyRate["kind"];
    if (kind === "component" || kind === "addon") return true; // legs: always priceable
    return !!s.active && myServices.has(s.name as string); // standalone: crew's own active work types
  });
  if (services.length === 0) return [];

  // A failed read empties every rate box and sets hasRate false — the crew is
  // shown a blank card for work they priced months ago, and the obvious next
  // move is to type a number in and save over the rate they can no longer see.
  const rates = mustRead(
    "your saved rates",
    await admin
      .from("vendor_rates")
      .select("service_id, base, unit_rate, band_pricing")
      .eq("vendor_id", vendorId),
  );
  const rateBy = new Map((rates ?? []).map((r) => [r.service_id as string, r]));

  // THE DIALS, LIVE — and live is right HERE and nowhere else.
  //
  // A rate card is not a sold job: nothing is frozen onto it, and the sentence
  // this screen prints is a forecast of what the NEXT job at this number would
  // pay. So it must quote today's dials. Work already booked recomputes from
  // the three values frozen onto the job (jobs.crew_quote / fee_customer_pct /
  // fee_crew_pct), never from these — which is the whole reason those columns
  // exist, and why tuning a dial can never reprice something already sold.
  //
  // getPlatformSettings falls back to its own defaults rather than throwing, so
  // a dropped read here cannot blank the fee sentence and quietly turn this
  // back into the screen that says $100 and pays $88.
  const settings = await getPlatformSettings();
  const fee: PlatformFee = {
    customerPct: settings.platformFeeCustomerPct,
    crewPct: settings.platformFeeCrewPct,
  };

  return services.map((s) => {
    const crewPriced = !!s.crew_priced;
    const existing = rateBy.get(s.id as string);
    const form = buildRateForm(
      {
        pricing_model: s.pricing_model as PricingModel,
        band_pricing: (s.band_pricing as PricingParams | null) ?? null,
        crew_priced: crewPriced,
      },
      existing
        ? {
            base: existing.base as number | null,
            unit_rate: existing.unit_rate as number | null,
            band_pricing: (existing.band_pricing as PricingParams | null) ?? null,
          }
        : null,
      // Only consulted when the service says crew_priced — passing it
      // unconditionally is safe and keeps the two halves of the switch in one
      // place (rates-helpers.ts), rather than a second `if` here that could
      // drift out of step with it.
      fee,
    );
    return {
      service_id: s.id as string,
      name: s.name as string,
      pricing_model: s.pricing_model as PricingModel,
      kind: ((s.kind as string | null) ?? "standalone") as MyRate["kind"],
      form,
      hasRate: !!existing,
      crewPriced,
    };
  });
}
