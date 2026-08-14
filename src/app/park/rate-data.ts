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
