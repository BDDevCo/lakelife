import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { softRead } from "@/lib/must-read";
import { buildRateForm, type RateForm } from "@/app/vendor/rates-helpers";
import type { PricingModel, PricingParams } from "@/lib/pricing";
import { getPlatformSettings } from "@/lib/settings";
import { setupAttribution } from "@/lib/crew-setup";

/**
 * WHAT SOMEBODY TYPED FOR THIS CREW, WAITING FOR THEM TO SAY YES.
 *
 * 0181's `crew_setup_proposals`. It exists so ops can take a crew's details
 * down the phone without any of them becoming true on the way — the crew's own
 * confirmation is what writes `vendors` and `vendor_rates`, and until then the
 * product reads none of it.
 *
 * NOTHING HERE IS EVER SHOWN TO ANOTHER CREW OR TO A CUSTOMER. A proposed rate
 * is this crew's pricing; 0181's row-level security fences both tables to the
 * crew themselves and ops, and this loader is scoped by vendor id on top.
 */

export interface PendingSetupRate {
  serviceId: string;
  name: string;
  /** The boxes, pre-filled with what ops typed. Same shape, same validation
   *  and same labels as the crew's own rates screen — because it is literally
   *  the same `buildRateForm`. */
  form: RateForm;
}

export interface PendingSetup {
  id: string;
  /** "Brendon set this up from your call on 24 September 2026." */
  attribution: string;
  /** Ops' own note from the call, if they left one. The crew reads it. */
  note: string | null;
  /** As they read it out. PRE-FILLS THE VERIFY BOX AND NOTHING ELSE — it is
   *  not a verified number and nothing may send to it. */
  phoneE164: string | null;
  lakeIds: string[];
  workDays: string[];
  dailyCapacity: number | null;
  rates: PendingSetupRate[];
}

/**
 * @param vendorId the crew's own vendors.id, from the session — never an argument
 *                 that reached us from a browser.
 *
 * RETURNS NULL FOR "NOTHING IS WAITING" AND THROWS FOR "WE COULD NOT LOOK".
 *
 * Those two must not collapse into each other. A dropped read answering `null`
 * renders the ordinary six-card wizard at a crew who was told on the phone that
 * their lakes and their rate were already in — so they set them again, by hand,
 * believing we lost them. The page's error boundary is the honest place for a
 * failed read to land.
 */
export async function getPendingSetup(vendorId: string | null): Promise<PendingSetup | null> {
  if (!vendorId) return null;
  const admin = createServiceClient();

  const propRes = await admin
    .from("crew_setup_proposals")
    .select("id, proposed_by_name, proposed_at, note, phone_e164, service_lakes, work_days, daily_capacity")
    .eq("vendor_id", vendorId)
    .is("settled_at", null)
    .maybeSingle();
  if (propRes.error) {
    throw new Error(`could not read whether a setup is waiting for you: ${propRes.error.message}`);
  }
  const p = propRes.data;
  if (!p) return null;

  // THE RATES ARE A SEPARATE, SOFTER READ. Their lakes and days are on the card
  // already; losing the numbers must not lose the card. An empty `rates` on a
  // failed read would be the confident lie — so it throws with the rest rather
  // than quietly rendering a setup with no prices in it, which the crew would
  // read as "he didn't put my rate in" and type it again.
  const rateRes = await admin
    .from("crew_setup_proposed_rates")
    .select("service_id, base, unit_rate, band_pricing")
    .eq("proposal_id", p.id as string);
  if (rateRes.error) {
    throw new Error(`could not read the rates that were set up for you: ${rateRes.error.message}`);
  }
  const proposed = rateRes.data ?? [];

  let rates: PendingSetupRate[] = [];
  if (proposed.length > 0) {
    const settings = await getPlatformSettings();
    const fee = {
      customerPct: settings.platformFeeCustomerPct,
      crewPct: settings.platformFeeCrewPct,
    };
    const svcRes = await admin
      .from("services")
      .select("id, name, pricing_model, band_pricing, crew_priced, active")
      .in("id", proposed.map((r) => r.service_id as string));
    // SOFT, AND NAMED. A service that cannot be read cannot be priced, but the
    // lakes, days and capacity on this card are still worth confirming — so the
    // card renders with no rate rows rather than the page falling over. The
    // unpriced-work list on the go-live card is what then tells them, in the
    // words it already uses, that the work they do has no price on it yet.
    const [svcRows, svcFailed] = softRead("the services you were set up for", svcRes, null);
    if (!svcFailed) {
      const byId = new Map((svcRows ?? []).map((s) => [s.id as string, s]));
      rates = proposed.flatMap((r) => {
        const svc = byId.get(r.service_id as string);
        // A service retired between the call and the sign-up. Silently absent
        // is right here: there is no such work to price any more, and naming it
        // would ask the crew to confirm a number for a job nobody can book.
        if (!svc || svc.active !== true) return [];
        return [{
          serviceId: svc.id as string,
          name: svc.name as string,
          form: buildRateForm(
            {
              pricing_model: svc.pricing_model as PricingModel,
              band_pricing: (svc.band_pricing as PricingParams | null) ?? null,
              crew_priced: svc.crew_priced === true,
            },
            {
              base: r.base != null ? Number(r.base) : null,
              unit_rate: r.unit_rate != null ? Number(r.unit_rate) : null,
              band_pricing: (r.band_pricing as PricingParams | null) ?? null,
            },
            svc.crew_priced === true ? fee : null,
          ),
        }];
      });
    }
  }

  return {
    id: p.id as string,
    attribution: setupAttribution({
      proposerName: (p.proposed_by_name as string | null) ?? null,
      proposedAt: (p.proposed_at as string | null) ?? null,
    }),
    note: ((p.note as string | null) ?? "").trim() || null,
    phoneE164: (p.phone_e164 as string | null) ?? null,
    lakeIds: (p.service_lakes as string[] | null) ?? [],
    workDays: (p.work_days as string[] | null) ?? [],
    dailyCapacity: (p.daily_capacity as number | null) ?? null,
    rates,
  };
}
