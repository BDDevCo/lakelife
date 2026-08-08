import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { buildRentRoll, summarise, toStay, type RawReservation } from "@/app/park/park-helpers";
import type { Lot } from "@/lib/parks";

/**
 * Ops' read-only view of every park on the platform. Ops already sees
 * everything (ll_is_ops), so nothing is widened here — this is a dashboard,
 * not a new privilege.
 *
 * There is no rent, no margin and no payout in this phase, so the numbers
 * below are occupancy and workload, not money. The reason ops cares about a
 * park at all is the SERVICE demand it represents: a 60-lot park is 60
 * potential lawn and winterization customers on one drive.
 */

export interface OpsParkRow {
  id: string;
  name: string;
  slug: string | null;
  lakeName: string | null;
  active: boolean;
  lots: number;
  occupied: number;
  vacant: number;
  pending: number;
  occupancyPct: number | null;
  members: number;
}

export async function getOpsParks(): Promise<OpsParkRow[]> {
  const admin = createServiceClient();

  const { data: parks } = await admin
    .from("parks")
    .select("id, name, slug, lake_id, active")
    .order("name");
  if (!parks || parks.length === 0) return [];

  const parkIds = parks.map((p) => p.id as string);

  const [{ data: lakes }, { data: lotRows }, { data: memberRows }] = await Promise.all([
    admin.from("lakes").select("id, name"),
    admin
      .from("park_lots")
      .select("id, park_id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, active")
      .in("park_id", parkIds),
    admin.from("park_members").select("park_id, user_id").in("park_id", parkIds),
  ]);

  const lakeName = new Map((lakes ?? []).map((l) => [l.id as string, l.name as string]));
  const lots = lotRows ?? [];

  const { data: resRows } = lots.length
    ? await admin
        .from("lot_reservations")
        .select("id, park_lot_id, renter_user_id, renter_unit_id, during, term, quoted_amount, status, decided_at, created_at")
        .in("park_lot_id", lots.map((l) => l.id as string))
    : { data: [] as RawReservation[] };

  const stays = (resRows ?? []).map((r) => toStay(r as unknown as RawReservation));
  const today = todayLakeDate();

  const memberCount = new Map<string, number>();
  for (const m of memberRows ?? []) {
    memberCount.set(m.park_id as string, (memberCount.get(m.park_id as string) ?? 0) + 1);
  }

  return parks.map((p) => {
    const mine: Lot[] = lots
      .filter((l) => l.park_id === p.id)
      .map((l) => ({
        id: l.id as string,
        lotNumber: l.lot_number as string,
        siteType: l.site_type as Lot["siteType"],
        maxLengthFt: (l.max_length_ft as number | null) ?? null,
        amperage: (l.amperage as number | null) ?? null,
        hasWater: !!l.has_water,
        hasSewer: !!l.has_sewer,
        slipIncluded: !!l.slip_included,
        active: !!l.active,
      }));
    const mineIds = new Set(mine.map((l) => l.id));
    const summary = summarise(buildRentRoll(mine, stays.filter((s) => mineIds.has(s.lotId)), today));

    return {
      id: p.id as string,
      name: p.name as string,
      slug: (p.slug as string | null) ?? null,
      lakeName: p.lake_id ? lakeName.get(p.lake_id as string) ?? null : null,
      active: !!p.active,
      lots: summary.lots,
      occupied: summary.occupied,
      vacant: summary.vacant,
      pending: summary.pending,
      occupancyPct: summary.occupancyPct,
      members: memberCount.get(p.id as string) ?? 0,
    };
  });
}
