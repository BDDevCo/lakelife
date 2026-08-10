import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import {
  fromPrice, isAvailable, parseDaterange, parkOpenFor,
  type DateRange, type Lot, type RateCard, type Term,
  effectiveSeason,
} from "@/lib/parks";
import { compareLotNumbers } from "@/app/park/data";

/**
 * The PUBLIC park page — the front door that fills vacancies.
 *
 * Availability is computed on the SERVER and published as a boolean. Anon has
 * no read on lot_reservations (migration 0052 revokes it deliberately), which
 * is exactly right: a stranger may learn that lot 12 is open, never who is on
 * lot 11 or until when. That asymmetry is the whole point, so this file is the
 * only place allowed to see both sides, and it returns only the safe half.
 */

export interface PublicLot {
  id: string;
  lotNumber: string;
  siteType: Lot["siteType"];
  maxLengthFt: number | null;
  amperage: number | null;
  hasWater: boolean;
  hasSewer: boolean;
  slipIncluded: boolean;
  rates: RateCard[];
  from: { term: Term; amount: number } | null;
  /** Open right now. Absence of a reason is deliberate — "taken until the 14th"
   *  would leak another renter's dates. */
  openNow: boolean;
}

export interface PublicPark {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  lakeName: string | null;
  parkType: "mh" | "rv" | "mixed";
  ageRestricted: boolean;
  approvalRequired: boolean;
  includedUtilities: string[];
  houseRules: string | null;
  season: { openMonth: number | null; openDay: number | null; closeMonth: number | null; closeDay: number | null };
  openToday: boolean;
  lots: PublicLot[];
  from: { term: Term; amount: number } | null;
}

/** An ACTIVE park by slug, or null. An unpublished park is a 404 to the world
 *  even though its owner can see it — parks.active is the launch switch. */
export async function getPublicPark(slug: string): Promise<PublicPark | null> {
  const admin = createServiceClient();

  const { data: park } = await admin
    .from("parks")
    .select("id, slug, name, address, lake_id, park_type, age_restricted, approval_required, included_utilities, house_rules, season_open_month, season_open_day, season_close_month, season_close_day, active")
    .eq("slug", slug)
    .maybeSingle();
  if (!park || !park.active) return null;

  let lakeName: string | null = null;
  if (park.lake_id) {
    const { data: lake } = await admin.from("lakes").select("name").eq("id", park.lake_id).maybeSingle();
    lakeName = (lake?.name as string | null) ?? null;
  }

  const { data: lotRows } = await admin
    .from("park_lots")
    .select("id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, active, season_open_month, season_open_day, season_close_month, season_close_day")
    .eq("park_id", park.id)
    .eq("active", true);
  const lots = lotRows ?? [];

  const lotIds = lots.map((l) => l.id as string);
  const [{ data: rateRows }, { data: resRows }] = await Promise.all([
    lotIds.length
      ? admin.from("lot_rates").select("park_lot_id, term, amount").in("park_lot_id", lotIds)
      : Promise.resolve({ data: [] as { park_lot_id: string; term: string; amount: number }[] }),
    lotIds.length
      ? admin.from("lot_reservations").select("park_lot_id, during, status").in("park_lot_id", lotIds)
      : Promise.resolve({ data: [] as { park_lot_id: string; during: string; status: string }[] }),
  ]);

  const ratesBy = new Map<string, RateCard[]>();
  for (const r of rateRows ?? []) {
    const card = { term: r.term as Term, amount: Number(r.amount) };
    const list = ratesBy.get(r.park_lot_id as string);
    if (list) list.push(card); else ratesBy.set(r.park_lot_id as string, [card]);
  }

  const heldBy = new Map<string, { during: DateRange; status: string }[]>();
  for (const r of resRows ?? []) {
    const range = parseDaterange(r.during as string);
    if (!range) continue;
    const held = { during: range, status: r.status as string };
    const list = heldBy.get(r.park_lot_id as string);
    if (list) list.push(held); else heldBy.set(r.park_lot_id as string, [held]);
  }

  const today = todayLakeDate();
  // "Open now" means open for TONIGHT — one night from today. A lot free
  // tonight is the honest headline for someone looking for somewhere to go.
  const tonight: DateRange = { start: today, end: addDay(today) };

  const publicLots: PublicLot[] = lots
    .map((l) => {
      const lot: Lot = {
        id: l.id as string,
        lotNumber: l.lot_number as string,
        siteType: l.site_type as Lot["siteType"],
        maxLengthFt: (l.max_length_ft as number | null) ?? null,
        amperage: (l.amperage as number | null) ?? null,
        hasWater: !!l.has_water,
        hasSewer: !!l.has_sewer,
        slipIncluded: !!l.slip_included,
        active: !!l.active,
      };
      const rates = ratesBy.get(lot.id) ?? [];
      return {
        ...lot,
        rates,
        from: fromPrice(rates),
        // A SLIP IS NOT OPEN IN JANUARY, however empty it is. Its own window
        // wins over the park's; the park's over year-round.
        openNow: isAvailable(
          lot, tonight, heldBy.get(lot.id) ?? [],
          effectiveSeason(
            {
              openMonth:  (l.season_open_month  as number | null) ?? null,
              openDay:    (l.season_open_day    as number | null) ?? null,
              closeMonth: (l.season_close_month as number | null) ?? null,
              closeDay:   (l.season_close_day   as number | null) ?? null,
            },
            {
              openMonth:  (park.season_open_month  as number | null) ?? null,
              openDay:    (park.season_open_day    as number | null) ?? null,
              closeMonth: (park.season_close_month as number | null) ?? null,
              closeDay:   (park.season_close_day   as number | null) ?? null,
            },
          ),
        ),
      };
    })
    .sort((a, b) => compareLotNumbers(a.lotNumber, b.lotNumber));

  const season = {
    openMonth: (park.season_open_month as number | null) ?? null,
    openDay: (park.season_open_day as number | null) ?? null,
    closeMonth: (park.season_close_month as number | null) ?? null,
    closeDay: (park.season_close_day as number | null) ?? null,
  };

  return {
    id: park.id as string,
    slug: park.slug as string,
    name: park.name as string,
    address: (park.address as string | null) ?? null,
    lakeName,
    parkType: (park.park_type as PublicPark["parkType"]) ?? "mixed",
    ageRestricted: !!park.age_restricted,
    approvalRequired: park.approval_required !== false,
    includedUtilities: (park.included_utilities as string[] | null) ?? [],
    houseRules: (park.house_rules as string | null) ?? null,
    season,
    openToday: parkOpenFor(season, tonight),
    lots: publicLots,
    from: fromPrice(publicLots.flatMap((l) => l.rates)),
  };
}

/** Every published park, for the directory page. */
export async function listPublicParks(): Promise<{ slug: string; name: string; lakeName: string | null }[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("parks")
    .select("slug, name, lake_id")
    .eq("active", true)
    .order("name");
  const rows = (data ?? []).filter((p) => !!p.slug);
  if (rows.length === 0) return [];

  const lakeIds = [...new Set(rows.map((p) => p.lake_id as string | null).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (lakeIds.length) {
    const { data: lakes } = await admin.from("lakes").select("id, name").in("id", lakeIds);
    for (const l of lakes ?? []) names.set(l.id as string, l.name as string);
  }

  return rows.map((p) => ({
    slug: p.slug as string,
    name: p.name as string,
    lakeName: p.lake_id ? names.get(p.lake_id as string) ?? null : null,
  }));
}

function addDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
