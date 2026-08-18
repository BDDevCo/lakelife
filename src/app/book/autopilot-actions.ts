"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readFailedMessage, ReadFailed } from "@/lib/must-read";
import { priceService, type ServiceRule } from "@/lib/pricing";
import { loadPricingProfileById } from "@/app/book/dispatch";
import { groundsFor, loadParkRatesChecked } from "@/app/park/rate-data";
import { withParkRate } from "@/lib/park-rates";

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
  const ownRes = await supabase
    .from("properties")
    .select("id")
    .eq("owner_id", user.id)
    .eq("id", propertyId)
    .maybeSingle();
  // A failed read here used to accuse the owner of borrowing someone else's
  // property id. It says nothing about their account now.
  if (ownRes.error) return { ok: false, error: readFailedMessage("your properties", ownRes.error) };
  if (!ownRes.data) return { ok: false, error: "That property isn't yours." };

  const admin = createServiceClient();

  if (!on) {
    const { error } = await admin
      .from("autopilot_enrollments")
      .update({ active: false })
      .eq("property_id", propertyId)
      .eq("service_id", serviceId);
    if (error) return { ok: false, error: error.message };
    // Withdraw any open proposal so a stale text link can't book later.
    const enrRes = await admin
      .from("autopilot_enrollments")
      .select("id")
      .eq("property_id", propertyId)
      .eq("service_id", serviceId)
      .maybeSingle();
    // Deliberately not fatal: the enrollment is ALREADY inactive above, and
    // /a/[token]/confirm refuses any link whose enrollment isn't active — so a
    // failed read here leaves a stale proposal that can no longer book
    // anything. Log it; don't tell the owner Autopilot is still on when it
    // isn't.
    if (enrRes.error) console.error("[read failed] your Autopilot enrollment:", enrRes.error);
    const enr = enrRes.data;
    if (enr) {
      await admin.from("autopilot_events").update({ status: "expired" }).eq("enrollment_id", enr.id).eq("status", "proposed");
    }
    return { ok: true };
  }

  // Lock TODAY's menu price for this property (rule 8: priced from the DB).
  const svcRes = await admin
    .from("services")
    .select("id, name, pricing_model, base, unit_rate, band_pricing, active")
    .eq("id", serviceId)
    .maybeSingle();
  // This row IS the locked price. "That service isn't available" would be a
  // fact we didn't read.
  if (svcRes.error) return { ok: false, error: readFailedMessage("this service's price", svcRes.error) };
  const svc = svcRes.data;
  if (!svc || svc.active === false) return { ok: false, error: "That service isn't available." };
  // loadPricingProfileById throws on a failed read now, so "set up your
  // property profile first" can only be said to somebody who really hasn't.
  let profile;
  try {
    profile = await loadPricingProfileById(admin, propertyId);
  } catch (e) {
    return { ok: false, error: readFailedMessage("your property profile", e) };
  }
  if (!profile) return { ok: false, error: "Set up your property profile first." };

  // A PARK PAYS ITS OWN RATE (0115). The global row for a grounds service
  // carries no price, so without this a park owner tapping "Autopilot this" on
  // a mow the previous screen priced at $100 was told to check a property
  // profile a park's grounds does not have.
  // groundsFor throws on a failed read (a dropped lot count is a mow billed
  // flat), and this is the ONE read in here that never got the treatment every
  // other one above did. Unguarded, the rejection escapes a "use server"
  // action and the toggle fails with no sentence at all.
  let grounds: Awaited<ReturnType<typeof groundsFor>>;
  try {
    grounds = await groundsFor(propertyId);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("whether this property is a park's grounds", e) };
  }
  const rule: ServiceRule = {
    name: svc.name as string,
    pricing_model: svc.pricing_model as ServiceRule["pricing_model"],
    base: Number(svc.base ?? 0),
    unit_rate: Number(svc.unit_rate ?? 0),
    band_pricing: (svc.band_pricing as ServiceRule["band_pricing"]) ?? null,
  };
  // A FAILED RATE READ MUST NOT BECOME "SET YOUR PRICE FIRST". An unread map
  // leaves 0115's zeroed global base, so `locked` comes out $0 and the refusal
  // below points a park owner at a Services page where the price is already
  // set. That sentence is only true when the read worked.
  let parkRatesFailed = false;
  let priced = rule as Parameters<typeof priceService>[0];
  if (grounds) {
    const { rates, failed } = await loadParkRatesChecked(grounds.parkId);
    parkRatesFailed = failed;
    priced = withParkRate({ ...rule, id: serviceId }, rates);
  }
  if (parkRatesFailed) {
    return { ok: false, error: readFailedMessage("what your park pays for this", null) };
  }
  const locked = priceService(priced, profile);
  if (!(locked > 0)) {
    return {
      ok: false,
      error: grounds
        ? `We can't lock a price for ${svc.name} — set what your park pays for it on the park's Services page first.`
        : "We couldn't price this service for your place — check your property profile.",
    };
  }

  const { error } = await admin
    .from("autopilot_enrollments")
    .upsert(
      { property_id: propertyId, service_id: serviceId, locked_price: locked, active: true, enrolled_at: new Date().toISOString() },
      { onConflict: "property_id,service_id" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true, lockedPrice: locked };
}
