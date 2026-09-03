import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import {
  buildRentRoll, summarise, toStay,
  type RawReservation, type RollRow, type RollSummary, type Stay,
} from "./park-helpers";
import { fromPrice, type Lot, type RateCard, type RenterUnit, type Term, type ParkSeason } from "@/lib/parks";

/**
 * Data for the park-owner back end. Reads are SERVICE-ROLE after asserting the
 * caller administers the park — the same shape as the vendor portal, and for
 * the same reason: a park that is still dark (parks.active = false) would
 * otherwise be hidden from the very person setting it up.
 *
 * Because the service role bypasses RLS, EVERY query below is scoped by hand
 * to the caller's own park. That scoping is the security boundary here, so it
 * is spelled out at each call site rather than assumed.
 *
 * What a park owner must NEVER reach through this file: another park's rows,
 * a renter's other properties or service history, anyone's payment methods,
 * LakeLife's margin, or a crew's rate. See docs/park-module-design.md.
 */

export interface MyPark {
  id: string;
  /**
   * When notices were put on hold, or null when they may go out.
   *
   * Read here so EVERY park screen can say so — a hold nobody can see is the
   * failure shape this codebase keeps digging out, and the owner would rightly
   * assume a silent product was broken rather than obedient.
   */
  noticesHeldAt: string | null;
  /** The day he takes over. Set in Park setup; null until he has. */
  cutoverDate: string | null;
  noticesHeldReason: string | null;
  role: "owner" | "manager";
  name: string;
  slug: string | null;
  address: string | null;
  lakeId: string | null;
  lakeName: string | null;
  parkType: "mh" | "rv" | "mixed";
  ageRestricted: boolean;
  approvalRequired: boolean;
  seasonOpenMonth: number | null;
  seasonOpenDay: number | null;
  seasonCloseMonth: number | null;
  seasonCloseDay: number | null;
  includedUtilities: string[];
  houseRules: string | null;
  active: boolean;
}

/**
 * The park the signed-in user administers, or null. Identity comes from the
 * SESSION client (auth.getUser) and is never taken from the browser.
 *
 * A user with more than one park gets the first by name; a park switcher is a
 * later phase, and a silent wrong-park would be worse than a stable one.
 */
export async function getMyPark(): Promise<MyPark | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createServiceClient();
  // A DROPPED READ IS NOT "YOU HAVE NO PARK". Every caller of this treats null
  // as "this person doesn't run a park" and shows them the door.
  const memberships = mustRead("your park", await admin
    .from("park_members")
    .select("park_id, role")
    .eq("user_id", user.id));
  if (!memberships || memberships.length === 0) return null;

  const parkIds = memberships.map((m) => m.park_id as string);
  const parks = mustRead("your park", await admin
    .from("parks")
    // One string literal, deliberately: supabase-js parses the select at the
    // TYPE level, and a concatenated string widens to `string`, which collapses
    // every column to GenericStringError.
    .select("id, name, slug, address, lake_id, park_type, age_restricted, approval_required, season_open_month, season_open_day, season_close_month, season_close_day, included_utilities, house_rules, active, notices_held_at, notices_held_reason, cutover_date")
    .in("id", parkIds)
    .order("name"));
  const park = parks?.[0];
  if (!park) return null;

  const role = memberships.find((m) => m.park_id === park.id)?.role as "owner" | "manager";

  let lakeName: string | null = null;
  if (park.lake_id) {
    const lake = mustRead("your park's lake", await admin
      .from("lakes").select("name").eq("id", park.lake_id).maybeSingle());
    lakeName = (lake?.name as string | null) ?? null;
  }

  return {
    id: park.id as string,
    role: role ?? "manager",
    noticesHeldAt: (park.notices_held_at as string | null) ?? null,
    noticesHeldReason: (park.notices_held_reason as string | null) ?? null,
    name: park.name as string,
    slug: (park.slug as string | null) ?? null,
    address: (park.address as string | null) ?? null,
    lakeId: (park.lake_id as string | null) ?? null,
    lakeName,
    parkType: (park.park_type as MyPark["parkType"]) ?? "mixed",
    ageRestricted: !!park.age_restricted,
    approvalRequired: park.approval_required !== false,
    seasonOpenMonth: (park.season_open_month as number | null) ?? null,
    seasonOpenDay: (park.season_open_day as number | null) ?? null,
    seasonCloseMonth: (park.season_close_month as number | null) ?? null,
    seasonCloseDay: (park.season_close_day as number | null) ?? null,
    includedUtilities: (park.included_utilities as string[] | null) ?? [],
    houseRules: (park.house_rules as string | null) ?? null,
    active: !!park.active,
    // THE DAY HE TAKES OVER, already decided and stored. The roll importer was
    // asking him for it again and defaulting the box to TODAY — and that date
    // dates every tenancy it writes.
    cutoverDate: (park.cutover_date as string | null) ?? null,
  };
}

/** Does the signed-in user administer THIS park? The guard every server action
 *  calls before it writes. Never trust a parkId from the browser. */
export async function assertMyPark(parkId: string): Promise<{ role: string } | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("park_members")
    .select("role")
    .eq("park_id", parkId)
    .eq("user_id", user.id)
    .maybeSingle();
  // A FAILED READ IS NOT "NOT YOUR PARK" — but this function cannot yet say
  // which it was. Its answer is `null` and every one of its ~120 callers turns
  // that into "You don't manage that park.", which is a false statement about
  // somebody's account made at the exact moment we had no idea. Throwing here
  // would reject inside actions that are awaiting { ok, error } and would
  // surface as a blank button, so for now the failure is at least LOGGED
  // rather than silent. Fixing the sentence means giving this a third answer.
  if (res.error) {
    console.error(
      "[read failed] whether this park is yours:",
      res.error.code ?? "", res.error.message ?? res.error,
    );
  }
  return res.data ? { role: res.data.role as string } : null;
}

// ------------------------------------------------------------- the roll ----

export interface LotWithRates {
  lot: Lot;
  rates: RateCard[];
  notes: string | null;
  tier: string;
  features: string[];
  from: { term: Term; amount: number } | null;
  /** This lot's OWN window. All-null means it inherits the park's. */
  season: ParkSeason;
}

function toLot(row: Record<string, unknown>): Lot {
  return {
    id: row.id as string,
    lotNumber: row.lot_number as string,
    siteType: row.site_type as Lot["siteType"],
    maxLengthFt: (row.max_length_ft as number | null) ?? null,
    amperage: (row.amperage as number | null) ?? null,
    hasWater: !!row.has_water,
    hasSewer: !!row.has_sewer,
    slipIncluded: !!row.slip_included,
    active: !!row.active,
    // Selected but never mapped until now, so every consumer read undefined
    // and defaulted to 'live' — which is why the four planned homes could not
    // be kept out of occupancy.
    lifecycle: (row.lifecycle as string) ?? "live",
    expectedLiveOn: (row.expected_live_on as string | null) ?? null,
    rentalMode: (row.rental_mode as string) ?? "long_term",
    parkOwnedHome: !!row.park_owned_home,
  };
}

/** Every lot in the park with its rate card. Sorted the way a park owner reads
 *  a park: lot 2 before lot 10, not "10" before "2". */
export async function getParkLots(parkId: string): Promise<LotWithRates[]> {
  const admin = createServiceClient();
  const lotRows = mustRead("your lots", await admin
    .from("park_lots")
    .select("id, lot_number, site_type, max_length_ft, amperage, has_water, has_sewer, slip_included, notes, active, tier, features, season_open_month, season_open_day, season_close_month, season_close_day, lifecycle, expected_live_on, rental_mode, park_owned_home")
    .eq("park_id", parkId)); // <- the scope
  const lots = lotRows ?? [];
  if (lots.length === 0) return [];

  const rateRows = mustRead("your rate cards", await admin
    .from("lot_rates")
    .select("park_lot_id, term, amount")
    .in("park_lot_id", lots.map((l) => l.id as string)));

  const ratesBy = new Map<string, RateCard[]>();
  for (const r of rateRows ?? []) {
    const card = { term: r.term as Term, amount: Number(r.amount) };
    const list = ratesBy.get(r.park_lot_id as string);
    if (list) list.push(card);
    else ratesBy.set(r.park_lot_id as string, [card]);
  }

  return lots
    .map((row) => {
      const rates = ratesBy.get(row.id as string) ?? [];
      return {
        lot: toLot(row),
        rates,
        notes: (row.notes as string | null) ?? null,
        tier: (row.tier as string | null) ?? "standard",
        features: (row.features as string[] | null) ?? [],
        from: fromPrice(rates),
        season: {
          openMonth:  (row.season_open_month  as number | null) ?? null,
          openDay:    (row.season_open_day    as number | null) ?? null,
          closeMonth: (row.season_close_month as number | null) ?? null,
          closeDay:   (row.season_close_day   as number | null) ?? null,
        },
      };
    })
    .sort((a, b) => compareLotNumbers(a.lot.lotNumber, b.lot.lotNumber));
}

/** "2" before "10", and "A1" before "B1" — natural order, because a park owner
 *  reading their own park down a screen should not have to hunt. */
export function compareLotNumbers(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export interface ParkRoll {
  rows: RollRow[];
  summary: RollSummary;
  today: string;
  /** Renter display names, keyed by user id. Name only — a park owner has no
   *  business reading a renter's service history or billing from here. */
  renterNames: Map<string, string>;
  /** The units on this park's lots, keyed by unit id. Reached only because a
   *  reservation on THIS park's lot points at them (the ll_can_see_unit door
   *  in 0052) — make, type and length, which is what a fit decision needs and
   *  where it stops. */
  units: Map<string, ParkUnitView>;
}

export interface ParkUnitView {
  label: string;              // "34ft travel trailer (2019 Jayco)"
  unitType: RenterUnit["unitType"];
  lengthFt: number | null;
}

export async function getParkRoll(parkId: string): Promise<ParkRoll> {
  const admin = createServiceClient();
  const lots = await getParkLots(parkId);
  const today = todayLakeDate();

  if (lots.length === 0) {
    return {
      rows: [], summary: summarise([]), today,
      renterNames: new Map(), units: new Map(),
    };
  }

  const lotIds = lots.map((l) => l.lot.id);
  // A failed read here empties the rent roll, which reads as a park where
  // nobody lives and nobody owes anything.
  const resRows = mustRead("your rent roll", await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, renter_unit_id, during, term, quoted_amount, due_day, amount_source, status, decided_at, created_at, notice_given_on, expected_move_out, origin")
    .in("park_lot_id", lotIds)); // <- the scope: this park's lots only

  const stays: Stay[] = (resRows ?? []).map((r) => toStay(r as unknown as RawReservation));
  const rows = buildRentRoll(lots.map((l) => l.lot), stays, today);

  return {
    rows,
    summary: summarise(rows),
    today,
    renterNames: await loadRenterNames(stays),
    units: await loadUnits(stays),
  };
}

/**
 * Names for the people on the roll, read from the PARK'S OWN FILE rather than
 * from the users table. That is not a detail — it is why the rent roll works
 * at all for a tenant who has never signed up, and why it keeps working after
 * one deletes their account (park_renters.user_id goes null; display_name and
 * the tenancy stay).
 *
 * NAME ONLY — deliberately not email, not phone, not their other properties.
 * A park owner needs to know who is on lot 12; everything past that is the
 * renter's business until they choose to share it, and this file is
 * service-role, so nothing but this narrow select stops us.
 */
async function loadRenterNames(stays: Stay[]): Promise<Map<string, string>> {
  const ids = [...new Set(stays.map((s) => s.renterId))];
  if (ids.length === 0) return new Map();
  const admin = createServiceClient();
  // Without this a dropped read renames every household on the roll "Renter".
  const data = mustRead("the names on your roll", await admin
    .from("park_renters").select("id, display_name").in("id", ids));
  return new Map(
    (data ?? []).map((r) => [r.id as string, (r.display_name as string | null) || "Renter"]),
  );
}

/** The rigs on this park's lots — what the owner needs to judge fit, and
 *  nothing that identifies a person beyond it. */
async function loadUnits(stays: Stay[]): Promise<Map<string, ParkUnitView>> {
  const ids = [...new Set(stays.map((s) => s.renterUnitId).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const admin = createServiceClient();
  const data = mustRead("the rigs on your lots", await admin
    .from("renter_units")
    .select("id, unit_type, make, model, year, length_ft")
    .in("id", ids));
  return new Map(
    (data ?? []).map((u) => {
      const unitType = (u.unit_type as RenterUnit["unitType"]) ?? "rv";
      const lengthFt = (u.length_ft as number | null) ?? null;
      const size = lengthFt ? `${lengthFt}ft ` : "";
      const maker = [u.year, u.make, u.model].filter(Boolean).join(" ");
      return [
        u.id as string,
        {
          label: `${size}${String(unitType).replace(/_/g, " ")}${maker ? ` (${maker})` : ""}`,
          unitType,
          lengthFt,
        },
      ];
    }),
  );
}
