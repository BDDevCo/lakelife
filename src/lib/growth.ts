/**
 * Growth-engine helpers (payout batch + nudges) — PURE, no I/O.
 * Cadence rules: crews/HOAs get their referral money at MONTH-END (one
 * batch, one statement); customers' credits apply continuously. Nudges are
 * event-triggered, email-only, and per-kind frequency-capped — the game
 * stays alive without ever getting spammy.
 */

/** Is this lake-date the last day of its month? (Month-end batch trigger.) */
export function isLastDayOfMonth(dateISO: string): boolean {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (!y || !m || !d) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d === daysInMonth;
}

/** Has this nudge kind fired for this user inside the cooldown window? */
export function nudgeCooling(lastSentISO: string | null, cooldownDays: number, nowMs: number): boolean {
  if (!lastSentISO) return false;
  const t = Date.parse(lastSentISO);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < cooldownDays * 86_400_000;
}
