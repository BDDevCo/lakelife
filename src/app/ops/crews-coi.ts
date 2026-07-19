/**
 * Pure COI (certificate of insurance) status helper — no I/O, no server bits,
 * so it can be unit-tested and imported anywhere. The router's real gate lives
 * server-side (approveCrew / assignAndSchedule); this only drives the ops UI.
 *
 * States:
 *   'missing'  — no COI document or no expiry date on file
 *   'expired'  — expiry is before today (not routable)
 *   'expiring' — expires within the next 30 days (routable, but nudge them)
 *   'ok'       — valid for 30+ days
 */
export type CoiState = "missing" | "expired" | "expiring" | "ok";

/** Whole days from `from` (ISO yyyy-mm-dd) to `to` (ISO). Negative = past. */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

export function coiState(
  coiUrl: string | null | undefined,
  coiExpiry: string | null | undefined,
  todayISO: string,
): CoiState {
  if (!coiUrl || !coiExpiry) return "missing";
  const days = daysBetween(todayISO, String(coiExpiry));
  if (Number.isNaN(days)) return "missing";
  if (days < 0) return "expired";
  if (days < 30) return "expiring";
  return "ok";
}
