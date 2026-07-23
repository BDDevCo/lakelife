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

/**
 * Partition one vendor's day across their trucks, then route each truck.
 *
 * Whole clusters (lakes) go to the truck with the most remaining room —
 * that's what keeps trucks from criss-crossing lakes. A cluster too big
 * for any one truck is drive-ordered and split at capacity boundaries.
 * Deterministic: ties break by truck order (caller passes created-order),
 * so tomorrow's rebuild of the same day gives the same routes.
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
  const clusters = [...byLake.values()].sort((a, b) => b.length - a.length);

  const remaining = new Map<string, number>(active.map((t) => [t.id, t.capacity]));
  const assigned = new Map<string, FleetStop[]>(active.map((t) => [t.id, []]));
  const overflow: FleetStop[] = [];

  // Most room wins; a TIE breaks toward the truck whose own base is nearest
  // the cluster (a Pretty-Lake truck should draw the Pretty cluster, not
  // whichever truck was created first). Trucks without a base tie at
  // Infinity and fall through to created order — deterministic rebuilds.
  const bestTruck = (centroid: { lat: number; lng: number } | null): TruckIn | null => {
    let best: TruckIn | null = null;
    let bestRoom = 0;
    let bestDist = Infinity;
    for (const t of active) {
      const room = remaining.get(t.id) ?? 0;
      if (room <= 0) continue;
      const bLat = t.baseLat ?? fallbackBase?.lat ?? null;
      const bLng = t.baseLng ?? fallbackBase?.lng ?? null;
      const dist = centroid && bLat != null && bLng != null ? kmBetween(bLat, bLng, centroid.lat, centroid.lng) : Infinity;
      if (best == null || room > bestRoom || (room === bestRoom && dist < bestDist)) {
        best = t;
        bestRoom = room;
        bestDist = dist;
      }
    }
    return best;
  };

  for (const cluster of clusters) {
    const located = cluster.filter((s) => s.lat != null && s.lng != null);
    const centroid = located.length
      ? {
          lat: located.reduce((s, x) => s + (x.lat as number), 0) / located.length,
          lng: located.reduce((s, x) => s + (x.lng as number), 0) / located.length,
        }
      : null;
    // Drive-order the cluster ONCE so any capacity split cuts along the
    // route, not across it (front half and back half stay contiguous).
    let queue = nearestNeighborOrder(cluster) as FleetStop[];
    while (queue.length) {
      const t = bestTruck(centroid);
      if (!t) {
        overflow.push(...queue);
        break;
      }
      const room = remaining.get(t.id) ?? 0;
      const take = queue.slice(0, room);
      queue = queue.slice(room);
      assigned.get(t.id)!.push(...take);
      remaining.set(t.id, room - take.length);
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
