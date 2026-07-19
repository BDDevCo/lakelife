/**
 * Router v1 (spec §5: "don't over-engineer") — pure functions, no I/O.
 * Cluster a vendor's day by lake → order stops nearest-neighbor in drive
 * direction → cap at daily capacity, overflow reported (ops decides).
 * Straight-line distance stands in for Directions API at beta scale.
 */

export interface StopIn {
  id: string;
  lat: number | null;
  lng: number | null;
  lake_name: string | null;
}

export interface VendorDayPlan {
  ordered: StopIn[]; // sequenced stops, capped at capacity
  overflow: StopIn[]; // beyond capacity — surfaced to ops, not silently dropped
  driveKm: number;
  driveMinutes: number; // rough est: 1.6 min/km + 2 min per hop
}

function km(a: StopIn, b: StopIn): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest-neighbor order, starting from the northernmost located stop.
 *  Stops without coordinates keep their original order at the END. */
export function nearestNeighborOrder(stops: StopIn[]): StopIn[] {
  const located = stops.filter((s) => s.lat != null && s.lng != null);
  const unlocated = stops.filter((s) => s.lat == null || s.lng == null);
  if (located.length <= 1) return [...located, ...unlocated];

  const remaining = [...located];
  let current = remaining.reduce((n, s) => ((s.lat ?? -90) > (n.lat ?? -90) ? s : n), remaining[0]);
  const out: StopIn[] = [];
  while (remaining.length) {
    remaining.splice(remaining.indexOf(current), 1);
    out.push(current);
    if (!remaining.length) break;
    current = remaining.reduce((best, s) => (km(out[out.length - 1], s) < km(out[out.length - 1], best) ? s : best), remaining[0]);
  }
  return [...out, ...unlocated];
}

export function pathKm(stops: StopIn[]): number {
  let total = 0;
  for (let i = 1; i < stops.length; i++) total += km(stops[i - 1], stops[i]);
  return Math.round(total * 10) / 10;
}

/** Plan one vendor's day: cluster by lake (largest first), order each cluster,
 *  concatenate, cap at capacity. */
export function planVendorDay(stops: StopIn[], dailyCapacity: number): VendorDayPlan {
  const cap = dailyCapacity > 0 ? dailyCapacity : stops.length;
  const byLake = new Map<string, StopIn[]>();
  for (const s of stops) {
    const k = s.lake_name ?? "(no lake)";
    if (!byLake.has(k)) byLake.set(k, []);
    byLake.get(k)!.push(s);
  }
  const clusters = [...byLake.values()].sort((a, b) => b.length - a.length);
  const orderedAll = clusters.flatMap((c) => nearestNeighborOrder(c));
  const ordered = orderedAll.slice(0, cap);
  const overflow = orderedAll.slice(cap);
  const driveKm = pathKm(ordered);
  return {
    ordered,
    overflow,
    driveKm,
    driveMinutes: Math.round(driveKm * 1.6 + Math.max(0, ordered.length - 1) * 2),
  };
}

/** Google Maps directions link for a sequenced route (works on any phone). */
export function routeMapUrl(stops: StopIn[]): string | null {
  const pts = stops.filter((s) => s.lat != null && s.lng != null);
  if (!pts.length) return null;
  return "https://www.google.com/maps/dir/" + pts.map((s) => `${s.lat},${s.lng}`).join("/");
}
