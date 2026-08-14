
/**
 * WHAT THIS PARK PAYS — the one place park pricing is looked up.
 *
 * 0115 gave every park its own rate table and zeroed the global price on every
 * `park_only` service. That was deliberate: The Haven pays $100/week for a mow
 * because of a contract signed in LaGrange County, Indiana, and a park in
 * another market inheriting that number silently is worse than showing no
 * number at all.
 *
 * So there is NO FALLBACK here. A service this park has not priced comes back
 * unchanged — base 0, unit_rate 0 — which prices to $0, which every surface
 * already treats as "not applicable" and refuses to book. The park's own
 * service desk is where the owner sets the number, and it says so plainly.
 *
 * Read through the service client: 0115 revoked client writes AND reads, so a
 * renter poking at the API cannot enumerate what the park pays its crews. Every
 * caller here has already established the viewer manages this park.
 */

export interface ParkRate {
  base: number;
  unit_rate: number;
  /** Why this number — "From the seller: $100/week". Shown back to the owner. */
  note?: string | null;
}

export type ParkRates = Map<string, ParkRate>;

/** Overlay a park's numbers onto a service's SHAPE (pricing_model, bands). */
export function withParkRate<T extends { id?: string | null }>(service: T, rates: ParkRates): T {
  const own = service.id ? rates.get(service.id) : undefined;
  // `note` is documentation, not a pricing input — it must not ride along onto
  // the service rule and end up somewhere that reads a stray column.
  return own ? { ...service, base: own.base, unit_rate: own.unit_rate } : service;
}
