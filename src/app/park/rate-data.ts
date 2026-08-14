import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
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
  const { data } = await createServiceClient()
    .from("park_service_rates")
    .select("service_id, base, unit_rate, note")
    .eq("park_id", parkId);

  // A FAILED READ IS NOT AN EMPTY TABLE — but here they land in the same safe
  // place, because both mean "we do not know this park's price" and both end in
  // $0 and a refusal rather than a wrong charge.
  return new Map(
    (data ?? []).map((r) => [
      r.service_id as string,
      {
        base: Number(r.base ?? 0),
        unit_rate: Number(r.unit_rate ?? 0),
        note: (r.note as string | null) ?? null,
      },
    ]),
  );
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
  const { data: park } = await admin
    .from("parks")
    .select("id")
    .eq("service_property_id", propertyId)
    .maybeSingle();
  if (!park?.id) return null;

  const { count } = await admin
    .from("park_lots")
    .select("id", { count: "exact", head: true })
    .eq("park_id", park.id as string)
    .eq("lifecycle", "live");
  return { parkId: park.id as string, lots: count ?? 0 };
}
