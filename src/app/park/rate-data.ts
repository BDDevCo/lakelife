import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, mustCount } from "@/lib/must-read";
import type { ParkRates } from "@/lib/park-rates";

/**
 * READING WHAT A PARK PAYS. Split from the pure overlay in
 * `@/lib/park-rates` so the arithmetic is testable without a database — the
 * arithmetic is the part that can quote the wrong park.
 *
 * Service-role on purpose: 0115 revoked client reads as well as writes, so a
 * renter cannot enumerate what the park pays its crews. Every caller here has
 * already established the viewer manages this park.
 */
export async function loadParkRates(parkId: string): Promise<ParkRates> {
  return (await loadParkRatesChecked(parkId)).rates;
}

/**
 * The same read, with the third answer kept.
 *
 * The swallow below is right for the nightly, which must not die over one
 * park's prices. It is WRONG wherever the empty map turns into a sentence: an
 * unread rate map leaves 0115's zeroed global base in place, `locked` comes out
 * $0, and the owner is told to "set what your park pays for it on the park's
 * Services page first" — pointing them at a price they have already set.
 * Callers that speak to a person use this one and say something true instead.
 */
export async function loadParkRatesChecked(
  parkId: string,
): Promise<{ rates: ParkRates; failed: boolean }> {
  const res = await createServiceClient()
    .from("park_service_rates")
    .select("service_id, base, unit_rate, note")
    .eq("park_id", parkId);

  // A FAILED READ IS NOT AN EMPTY TABLE — but here they land in the same safe
  // place, because both mean "we do not know this park's price" and both end in
  // $0 and a refusal rather than a wrong charge.
  //
  // So the failure is SWALLOWED on purpose (this is called from the nightly and
  // from booking, and neither should die over it) — but it is no longer silent.
  // Without the log, "no price for your park yet" is the only trace, and it
  // points the owner at a Services page where the price is already set.
  if (res.error) {
    console.error(
      "[read failed, degraded] what this park pays:",
      res.error.code ?? "", res.error.message ?? res.error,
    );
  }
  const data = res.data;

  return {
    failed: !!res.error,
    rates: new Map(
      (data ?? []).map((r) => [
        r.service_id as string,
        {
          base: Number(r.base ?? 0),
          unit_rate: Number(r.unit_rate ?? 0),
          note: (r.note as string | null) ?? null,
        },
      ]),
    ),
  };
}

/**
 * IS THIS PROPERTY A PARK'S GROUNDS, AND HOW MANY LOTS?
 *
 * Every park price is `base + unit_rate x live lots`, so a pricing profile
 * without `lots` prices a park service at its base and nothing else. That is
 * how a crew's $4-a-lot mow rate became a flat $16 on the open board, and how
 * autopilot told a park owner to "check your property profile" about a service
 * the previous screen priced at $100.
 */
export async function groundsFor(
  propertyId: string,
): Promise<{ parkId: string; lots: number } | null> {
  const admin = createServiceClient();
  // NOT SWALLOWED, unlike the rate map above, because the two failures do not
  // land in the same place. A missing rate prices to $0 and is refused; a
  // missing LOT COUNT prices to `base` and is charged — the $4-a-lot mow
  // billed as a flat $16, on the board, in the vendor cost, and in the margin.
  // `count ?? 0` on a dropped read is exactly that bug with no symptom.
  const park = mustRead("whether this property is a park's grounds", await admin
    .from("parks")
    .select("id")
    .eq("service_property_id", propertyId)
    .maybeSingle());
  if (!park?.id) return null;

  const count = mustCount("how many lots this park has", await admin
    .from("park_lots")
    .select("id", { count: "exact", head: true })
    .eq("park_id", park.id as string)
    .eq("lifecycle", "live"));
  return { parkId: park.id as string, lots: count };
}
