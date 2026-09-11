/**
 * EVERY AGREEMENT A RESIDENT HAS HELD AT THIS PARK, so her bills follow her
 * across a renewal.
 *
 * A renewal is a SUCCESSOR ROW by design (0062): the owner writes the next
 * agreement, a new lot_reservations row is inserted, and the old one is left
 * untouched. Every bill is pinned to the specific agreement whose month it is
 * (park_charges.reservation_id, 0070). So the resident's screen, which loaded
 * bills for the newest row only, lost every bill raised under the previous
 * agreement the moment the office wrote the next one — up to 45 days early —
 * including her CURRENT month if it was still open. She read "Nothing to pay
 * right now" while the office chased her for it.
 *
 * Scoped to the same renter FILE, not to every reservation she has anywhere:
 * a renter file is per park, and this screen is one park's screen. A resident
 * with files at two parks would otherwise see the other park's rent here.
 */
export function chainReservationIds(
  stays: ReadonlyArray<{ id: string; renter_id: string }>,
  current: { id: string; renter_id: string },
): string[] {
  const ids = stays.filter((s) => s.renter_id === current.renter_id).map((s) => s.id);
  // The current row is always in, even if the list somehow omitted it.
  return ids.includes(current.id) ? ids : [current.id, ...ids];
}
