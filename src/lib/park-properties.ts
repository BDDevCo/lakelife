import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { ownedHomeAddress } from "@/app/park/service-helpers";

/**
 * KEEPING A PARK'S DERIVED PROPERTIES IN STEP WITH THE PARK.
 *
 * Two kinds of `properties` row are built FROM a park and never by hand:
 *
 *   * the grounds — `parks.service_property_id`, address copied straight from
 *     the park, nickname "<park> — grounds"
 *   * a home the park owns — `park_lots.service_property_id` (0122), address
 *     built as "Lot 7, <park>, <park address>", nickname "Lot 7 — yours"
 *
 * Both were snapshotted at mint and never looked at again. `saveParkProfile`
 * updates `parks` and nothing else, so correcting the park's address left every
 * derived property holding the old one — and the PROPERTY address is what a
 * crew is dispatched to. He would fix the address on his own screen, watch it
 * save, and still have trucks sent to the wrong place with nothing anywhere to
 * explain why.
 *
 * This is not hypothetical for The Haven. Its park row reads "1 Haven Rd,
 * Angola IN" — a placeholder, and the wrong town; the park is on Pretty Lake at
 * Wolcottville. That string has already been copied into two properties.
 *
 * WHAT IS RE-DERIVED AND WHAT IS NOT. Address and nickname are pure functions
 * of the park's name and address, so they are rewritten every time. The map pin
 * is only FILLED IN, never overwritten: a property that already carries a pin
 * has a better one than a park-level guess, and a park with no pin must not
 * blank one that exists.
 */
export async function resyncParkProperties(parkId: string): Promise<void> {
  const admin = createServiceClient();

  const parkRes = await admin
    .from("parks")
    .select("name, address, lat, lng, service_property_id")
    .eq("id", parkId)
    .maybeSingle();
  // Nothing here is worth failing his save over — the park itself is already
  // written. Say so on the log; the addresses stay stale until the next save.
  if (parkRes.error) {
    console.error("[read failed] the park behind its service properties:", parkRes.error);
    return;
  }
  const park = parkRes.data;
  if (!park) return;

  const name = (park.name as string) ?? "The park";
  const address = (park.address as string) ?? null;
  const lat = (park.lat as number | null) ?? null;
  const lng = (park.lng as number | null) ?? null;

  const groundsId = (park.service_property_id as string) ?? null;
  if (groundsId) {
    const patch: Record<string, unknown> = {
      nickname: `${name} — grounds`,
    };
    if (address) patch.address = address;
    await admin.from("properties").update(patch).eq("id", groundsId);
    await fillPin(admin, groundsId, lat, lng);
  }

  const lotsRes = await admin
    .from("park_lots")
    .select("lot_number, service_property_id")
    .eq("park_id", parkId)
    .not("service_property_id", "is", null);
  if (lotsRes.error) {
    console.error("[read failed] the homes your park owns:", lotsRes.error);
    return;
  }

  for (const l of lotsRes.data ?? []) {
    const propId = l.service_property_id as string;
    const lotNumber = l.lot_number as string;
    const patch: Record<string, unknown> = {
      nickname: `Lot ${lotNumber} — yours`,
    };
    if (address) patch.address = ownedHomeAddress(lotNumber, name, address);
    await admin.from("properties").update(patch).eq("id", propId);
    await fillPin(admin, propId, lat, lng);
  }
}

/** Only when the property has none of its own — never an overwrite. */
async function fillPin(
  admin: ReturnType<typeof createServiceClient>,
  propertyId: string,
  lat: number | null,
  lng: number | null,
): Promise<void> {
  if (lat == null || lng == null) return;
  await admin
    .from("properties")
    .update({ lat, lng })
    .eq("id", propertyId)
    .is("lat", null);
}
