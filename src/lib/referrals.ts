/**
 * Referral accrual math (§8b, owner-blessed 2026-07-23) — PURE, no I/O.
 *
 * Golden rules, enforced here by construction:
 *  - rewards accrue only on COLLECTED money (the caller hooks in after a
 *    successful charge — these functions just compute amounts);
 *  - the crew-bringer bounty is SELF-FINANCING: a share of margin actually
 *    collected, hard-capped — it can never exceed what the referred crew
 *    earned us (the "$40 landscaper" case pays $30, not $250);
 *  - customer-spend arms sunset after a year (dial);
 *  - credits never exceed the bill they're applied to.
 */

const cents = (n: number) => Math.round(n * 100) / 100;

/** Is a customer-spend accrual still inside the sunset window? */
export function withinSunset(attributedAtISO: string | null, nowMs: number, sunsetDays: number): boolean {
  if (!attributedAtISO) return false;
  const t = Date.parse(attributedAtISO);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < sunsetDays * 86_400_000;
}

/** Homeowner→homeowner / cross-sell: % of the collected price. */
export function customerReferralAccrual(collectedPrice: number, pct: number): number {
  if (!(collectedPrice > 0) || !(pct > 0)) return 0;
  return cents(collectedPrice * Math.min(pct, 0.5));
}

/** Crew-bringer: share of collected margin, until the lifetime cap. */
export function crewShareAccrual(collectedMargin: number, sharePct: number, cap: number, alreadyAccrued: number): number {
  if (!(collectedMargin > 0) || !(sharePct > 0) || !(cap > 0)) return 0;
  const room = Math.max(0, cap - Math.max(0, alreadyAccrued));
  if (room <= 0) return 0;
  return cents(Math.min(collectedMargin * Math.min(sharePct, 1), room));
}

/** Credits applied to a bill: never negative, never more than the bill. */
export function creditToApply(balance: number, price: number): number {
  if (!(balance > 0) || !(price > 0)) return 0;
  return cents(Math.min(balance, price));
}
