/**
 * Shared truck shape — its own tiny module (no "use client", no
 * "server-only") so BOTH the server data loader and the client card can
 * import it without dragging each other across the RSC boundary.
 */
export interface MyTruck {
  id: string;
  name: string;
  /** Full E.164, or null. Unlike bank/routing numbers this isn't write-only —
   *  it's the crew's own truck phone, so the edit form can show and correct
   *  it. The LIST view masks it to the last 4 digits (component concern). */
  phone: string | null;
  capacity: number; // jobs/day, 1..20 (DB check)
  workStart: number; // lake-time hour, 0..23
  workEnd: number; // lake-time hour, 1..24, > workStart
  active: boolean;
}
