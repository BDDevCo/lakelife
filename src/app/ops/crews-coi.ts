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

/**
 * HAS ANYBODY ACTUALLY LOOKED AT THE CERTIFICATE? (0152)
 *
 * The expiry on file is a date the CREW typed into a form — nobody at
 * LakeLife opens the document. That is a defensible posture, and it is the
 * owner's, but it means "unexpired" is a claim by the crew until somebody
 * confirms it against the file. This is what ops needs to see.
 *
 *   'none'        — no certificate on file; nothing to confirm
 *   'unconfirmed' — a file is on file and nobody has opened it
 *   'confirmed'   — somebody opened it and agreed the typed date
 *
 * A confirmation is cleared automatically whenever the document is replaced
 * (0152's trigger), so this state goes back to 'unconfirmed' on every new
 * upload — which is correct: it is a different file.
 */
export type DocConfirmState = "none" | "unconfirmed" | "confirmed";

export function docConfirmState(
  docUrl: string | null | undefined,
  confirmedAt: string | null | undefined,
): DocConfirmState {
  if (!docUrl) return "none";
  return confirmedAt ? "confirmed" : "unconfirmed";
}
