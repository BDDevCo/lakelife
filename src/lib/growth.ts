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

/**
 * Near-milestone tease (owner request: "you're close on reaching $X —
 * couple more referrals, something to continue the game"). Fires only in
 * the band where the tease is honest: spendable balance still below the
 * milestone, but balance + maturing has crossed `closeFrac` of it. Once
 * the balance itself crosses, the covers-a-visit nudge owns the moment —
 * these two can never double-fire on the same night.
 *
 * gap === 0 means maturing money alone will push them over: "it's already
 * yours, it just needs to clear" — a different message, not a bigger ask.
 */
export function nearMilestone(
  balance: number,
  maturing: number,
  threshold: number,
  closeFrac = 0.6,
): { gap: number; projected: number } | null {
  if (!(threshold > 0) || !(closeFrac > 0)) return null;
  const bal = Math.max(0, balance);
  const mat = Math.max(0, maturing);
  if (bal >= threshold) return null; // covers-visit territory
  const projected = Math.round((bal + mat) * 100) / 100;
  if (projected < threshold * closeFrac) return null; // not close enough to tease
  const gap = Math.max(0, Math.round((threshold - projected) * 100) / 100);
  return { gap, projected };
}

/** Has this nudge kind fired for this user inside the cooldown window? */
export function nudgeCooling(lastSentISO: string | null, cooldownDays: number, nowMs: number): boolean {
  if (!lastSentISO) return false;
  const t = Date.parse(lastSentISO);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < cooldownDays * 86_400_000;
}
