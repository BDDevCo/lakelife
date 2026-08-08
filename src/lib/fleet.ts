import { type StopIn, nearestNeighborOrder } from "@/lib/router";

/**
 * Fleet Routing (docs/fleet-routing-design.md) — pure functions, no I/O.
 *
 * One contractor, N trucks. The BUSINESS (rates, insurance, payouts,
 * standing) stays on the vendor; the trucks carry capacity, hours, and the
 * morning route. Load-bearing invariant: a vendor with zero units is
 * handled by the LEGACY path (planVendorDay) — none of this activates.
 */

export interface TruckIn {
  id: string;
  name: string;
  phone: string | null;
  capacity: number; // jobs/day, 1..20 (DB check)
  workStart: number; // lake-time hour
  workEnd: number; // lake-time hour, > workStart
  baseLat: number | null; // null = fall back to vendor base
  baseLng: number | null;
}

export interface FleetStop extends StopIn {
  estMinutes: number; // per-service duration dial (services.est_minutes)
}

export interface TruckPlan {
  truck: TruckIn;
  ordered: FleetStop[];
  driveKm: number; // INCLUDES base→first and last→base legs
  driveMinutes: number;
  workMinutes: number; // drive + Σ job durations
  fitsHours: boolean; // false = this day busts the truck's window (flagged, never dropped)
}

export interface FleetPlan {
  trucks: TruckPlan[]; // only trucks that got stops
  overflow: FleetStop[]; // beyond the fleet's total capacity — surfaced, never silent
  totalKm: number;
}

/** Same heuristic as router v1 — one formula for the whole app. */
const MIN_PER_KM = 1.6;
const MIN_PER_HOP = 2;
export const DEFAULT_JOB_MINUTES = 60; // when a service has no est_minutes dial yet

/**
 * A job's admitted duration: package visits (group jobs) cost the SUM of
 * their legs — the SAME number dispatch charged at admission — never the
 * parent service's single dial. Every assigned-minutes reader must use
 * this, or a fleet's day looks lighter than it is and the machine keeps
 * stuffing jobs until the trucks bust hours (review finding, 2026-07-23).
 */
export function jobMinutesOf(
  parentEstMinutes: number | null | undefined,
  legEstMinutes: Array<number | null | undefined> | null,
): number {
  if (legEstMinutes && legEstMinutes.length > 0) {
    return legEstMinutes.reduce<number>((s, m) => {
      const v = Number(m ?? 0);
      return s + (v > 0 ? v : DEFAULT_JOB_MINUTES);
    }, 0);
  }
  const p = Number(parentEstMinutes ?? 0);
  return p > 0 ? p : DEFAULT_JOB_MINUTES;
}

const kmBetween = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Order stops for ONE truck starting from its base (→ vendor base →
 * northernmost, matching v1 when no base exists), and count the base→first
 * and last→base legs the v1 router ignored.
 */
export function planTruckRoute(
  truck: TruckIn,
  stops: FleetStop[],
  fallbackBase: { lat: number; lng: number } | null,
): TruckPlan {
  const baseLat = truck.baseLat ?? fallbackBase?.lat ?? null;
  const baseLng = truck.baseLng ?? fallbackBase?.lng ?? null;

  let ordered: FleetStop[];
  if (baseLat != null && baseLng != null) {
    // Nearest-neighbor seeded from the base, not from the northernmost stop.
    const located = stops.filter((s) => s.lat != null && s.lng != null);
    const unlocated = stops.filter((s) => s.lat == null || s.lng == null);
    const remaining = [...located];
    const out: FleetStop[] = [];
    let curLat = baseLat, curLng = baseLng;
    while (remaining.length) {
      let best = 0;
      for (let i = 1; i < remaining.length; i++) {
        if (kmBetween(curLat, curLng, remaining[i].lat as number, remaining[i].lng as number) <
            kmBetween(curLat, curLng, remaining[best].lat as number, remaining[best].lng as number)) best = i;
      }
      const next = remaining.splice(best, 1)[0];
      out.push(next);
      curLat = next.lat as number;
      curLng = next.lng as number;
    }
    ordered = [...out, ...unlocated];
  } else {
    ordered = nearestNeighborOrder(stops) as FleetStop[];
  }

  // Raw segment sum, rounded ONCE at the end (pathKm rounds internally,
  // which would double-round once the base legs are added).
  let raw = 0;
  const located = ordered.filter((s) => s.lat != null && s.lng != null);
  for (let i = 1; i < located.length; i++) {
    raw += kmBetween(located[i - 1].lat as number, located[i - 1].lng as number, located[i].lat as number, located[i].lng as number);
  }
  if (baseLat != null && baseLng != null && located.length > 0) {
    const first = located[0], last = located[located.length - 1];
    raw += kmBetween(baseLat, baseLng, first.lat as number, first.lng as number);
    raw += kmBetween(last.lat as number, last.lng as number, baseLat, baseLng);
  }
  const driveKm = Math.round(raw * 10) / 10;

  const driveMinutes = Math.round(driveKm * MIN_PER_KM + Math.max(0, ordered.length - 1) * MIN_PER_HOP);
  const jobMinutes = ordered.reduce((s, x) => s + (x.estMinutes > 0 ? x.estMinutes : DEFAULT_JOB_MINUTES), 0);
  const workMinutes = driveMinutes + jobMinutes;
  const windowMinutes = Math.max(60, (truck.workEnd - truck.workStart) * 60);
  return { truck, ordered, driveKm, driveMinutes, workMinutes, fitsHours: workMinutes <= windowMinutes };
}

/** A truck's running day while the partition is being built: the minutes it
 *  has taken on, and just enough geometry to price the NEXT stop's drive
 *  without re-routing the whole truck for every candidate. */
interface TruckLoad {
  count: number;
  jobMinutes: number;
  chainKm: number; // Σ legs between consecutive placed stops
  firstLat: number | null; // first LOCATED stop (base → first leg)
  firstLng: number | null;
  lastLat: number | null; // last LOCATED stop (last → base leg)
  lastLng: number | null;
  lakes: Set<string>;
}

/**
 * Partition one vendor's day across their trucks, then route each truck.
 *
 * Lake grouping is a SOFT PREFERENCE, not a hard partition (owner call after
 * the two-season audit, bug 3): Big Long, Pretty and Big Turkey are a short
 * drive apart, so a cross-lake day is normal and a truck busting its hours
 * while a sibling sits empty is not. Trucks therefore balance on MINUTES
 * (work + drive), a cluster stays on its truck only while that truck's day
 * still fits, and it splits the moment keeping it whole would bust hours.
 *
 * The old rule — whole cluster to the truck with the most remaining JOB
 * SLOTS, never rebalanced — produced 62 over-hours routes per 1,000
 * customers per season with idle trucks in the same fleet.
 *
 * Capacity stays a HARD cap (dispatch admits against fleetJobCap), stops
 * beyond the fleet's total capacity still surface as overflow, and a vendor
 * with zero trucks is still the legacy path, untouched. Deterministic: ties
 * break by base-to-cluster distance then truck order (caller passes
 * created-order), so tomorrow's rebuild of the same day gives the same routes.
 */
export function planFleetDay(
  stops: FleetStop[],
  trucks: TruckIn[],
  fallbackBase: { lat: number; lng: number } | null,
): FleetPlan {
  const active = trucks.filter((t) => t.capacity > 0);
  if (active.length === 0) return { trucks: [], overflow: stops, totalKm: 0 };

  const byLake = new Map<string, FleetStop[]>();
  for (const s of stops) {
    const k = s.lake_name ?? "(no lake)";
    if (!byLake.has(k)) byLake.set(k, []);
    byLake.get(k)!.push(s);
  }
  const clusters = [...byLake.entries()].sort((a, b) => b[1].length - a[1].length);

  const remaining = new Map<string, number>(active.map((t) => [t.id, t.capacity]));
  const assigned = new Map<string, FleetStop[]>(active.map((t) => [t.id, []]));
  const load = new Map<string, TruckLoad>(
    active.map((t) => [
      t.id,
      { count: 0, jobMinutes: 0, chainKm: 0, firstLat: null, firstLng: null, lastLat: null, lastLng: null, lakes: new Set<string>() },
    ]),
  );
  const overflow: FleetStop[] = [];

  const baseOf = (t: TruckIn): { lat: number; lng: number } | null => {
    const lat = t.baseLat ?? fallbackBase?.lat ?? null;
    const lng = t.baseLng ?? fallbackBase?.lng ?? null;
    return lat != null && lng != null ? { lat, lng } : null;
  };
  const windowOf = (t: TruckIn): number => Math.max(60, (t.workEnd - t.workStart) * 60);
  const minutesOf = (s: FleetStop): number => (s.estMinutes > 0 ? s.estMinutes : DEFAULT_JOB_MINUTES);

  /**
   * What this truck's day would cost in MINUTES if it took `s` next — the
   * same formula planTruckRoute lands on (drive + Σ job minutes), estimated
   * from the append order rather than the final nearest-neighbor order. It
   * is an estimate only for CHOOSING; the honest number is recomputed by
   * planTruckRoute below and still reported in fitsHours.
   */
  const projectMinutes = (t: TruckIn, s: FleetStop): number => {
    const l = load.get(t.id)!;
    const base = baseOf(t);
    const has = s.lat != null && s.lng != null;
    const legKm = has && l.lastLat != null ? kmBetween(l.lastLat, l.lastLng as number, s.lat as number, s.lng as number) : 0;
    const firstLat = l.firstLat ?? (has ? (s.lat as number) : null);
    const firstLng = l.firstLng ?? (has ? (s.lng as number) : null);
    const lastLat = has ? (s.lat as number) : l.lastLat;
    const lastLng = has ? (s.lng as number) : l.lastLng;
    const baseLegs =
      base && firstLat != null && lastLat != null
        ? kmBetween(base.lat, base.lng, firstLat, firstLng as number) + kmBetween(lastLat, lastLng as number, base.lat, base.lng)
        : 0;
    const km = Math.round((baseLegs + l.chainKm + legKm) * 10) / 10;
    const count = l.count + 1;
    const driveMinutes = Math.round(km * MIN_PER_KM + Math.max(0, count - 1) * MIN_PER_HOP);
    return driveMinutes + l.jobMinutes + minutesOf(s);
  };

  const place = (t: TruckIn, s: FleetStop, lakeKey: string): void => {
    const l = load.get(t.id)!;
    const has = s.lat != null && s.lng != null;
    if (has && l.lastLat != null) l.chainKm += kmBetween(l.lastLat, l.lastLng as number, s.lat as number, s.lng as number);
    if (has && l.firstLat == null) {
      l.firstLat = s.lat as number;
      l.firstLng = s.lng as number;
    }
    if (has) {
      l.lastLat = s.lat as number;
      l.lastLng = s.lng as number;
    }
    l.count += 1;
    l.jobMinutes += minutesOf(s);
    l.lakes.add(lakeKey);
    assigned.get(t.id)!.push(s);
    remaining.set(t.id, (remaining.get(t.id) ?? 0) - 1);
  };

  for (const [lakeKey, cluster] of clusters) {
    const located = cluster.filter((s) => s.lat != null && s.lng != null);
    const centroid = located.length
      ? {
          lat: located.reduce((s, x) => s + (x.lat as number), 0) / located.length,
          lng: located.reduce((s, x) => s + (x.lng as number), 0) / located.length,
        }
      : null;
    // Drive-order the cluster ONCE so any split cuts along the route, not
    // across it (front half and back half stay contiguous on their trucks).
    const queue = nearestNeighborOrder(cluster) as FleetStop[];

    for (let i = 0; i < queue.length; i++) {
      const s = queue[i];
      // Candidates: every truck with a slot left. Score each on the minutes
      // its day would cost with this stop; tie → base nearest this lake's
      // centroid (a Pretty-Lake truck should draw the Pretty cluster), tie →
      // created order. Deterministic rebuilds either way.
      const cands = active
        .filter((t) => (remaining.get(t.id) ?? 0) > 0)
        .map((t) => {
          const base = baseOf(t);
          const est = projectMinutes(t, s);
          return {
            t,
            est,
            fits: est <= windowOf(t),
            sameLake: load.get(t.id)!.lakes.has(lakeKey),
            dist: centroid && base ? kmBetween(base.lat, base.lng, centroid.lat, centroid.lng) : Infinity,
          };
        });
      if (cands.length === 0) {
        // The whole fleet is full — the rest of the day surfaces, in order.
        overflow.push(...queue.slice(i));
        break;
      }
      const pickBest = (pool: typeof cands) => {
        let best: (typeof cands)[number] | null = null;
        for (const c of pool) {
          if (best == null || c.est < best.est || (c.est === best.est && c.dist < best.dist)) best = c;
        }
        return best;
      };
      // MILD same-lake preference: a truck already on this lake keeps the
      // cluster whole — but only while its day still fits. The moment it
      // doesn't, the cluster splits to the lightest truck that does fit; if
      // NOTHING fits, the lightest truck takes it and fitsHours says so
      // (flagged, never dropped — the old contract).
      const chosen =
        pickBest(cands.filter((c) => c.fits && c.sameLake)) ?? pickBest(cands.filter((c) => c.fits)) ?? pickBest(cands)!;
      place(chosen.t, s, lakeKey);
    }
  }

  const plans = active
    .filter((t) => (assigned.get(t.id) ?? []).length > 0)
    .map((t) => planTruckRoute(t, assigned.get(t.id)!, fallbackBase));
  const totalKm = Math.round(plans.reduce((s, p) => s + p.driveKm, 0) * 10) / 10;
  return { trucks: plans, overflow, totalKm };
}

// ---------------------------------------------------------------------------
// Capacity math for dispatch (the money path).
// ---------------------------------------------------------------------------

/**
 * A vendor's jobs-per-day cap: with trucks, the fleet's sum; without, the
 * legacy vendors.daily_capacity — the backward-compat invariant in one line.
 */
export function fleetJobCap(units: { capacity: number }[], legacyCapacity: number): number {
  if (units.length === 0) return legacyCapacity;
  return units.reduce((s, u) => s + Math.max(0, u.capacity), 0);
}

/**
 * The fleet's minute budget for a day, or null when the vendor has no
 * trucks (null = time-budget check disabled — legacy behavior).
 */
export function fleetMinuteBudget(units: { workStart: number; workEnd: number }[]): number | null {
  if (units.length === 0) return null;
  return units.reduce((s, u) => s + Math.max(0, (u.workEnd - u.workStart) * 60), 0);
}

/**
 * Would one more job still fit the fleet's hours? The overhead share
 * covers drive time between stops (the dispatcher doesn't know the final
 * route yet — the router refines at night). Null budget = no trucks =
 * always fits, so legacy vendors are untouched.
 */
export function fitsTimeBudget(
  assignedMinutes: number,
  newJobMinutes: number,
  minuteBudget: number | null,
  driveOverheadShare = 0.15,
): boolean {
  if (minuteBudget == null) return true;
  const jobs = Math.max(0, assignedMinutes) + Math.max(0, newJobMinutes);
  return jobs * (1 + driveOverheadShare) <= minuteBudget;
}
