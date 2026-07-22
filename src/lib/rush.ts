/**
 * Same-day rush (owner design, 2026-07-22) — PURE, no I/O.
 *
 * The deal: a customer can book TODAY at a rush premium; the job never
 * auto-dispatches — it goes straight to the claim board where a crew
 * already out on that lake picks it up at a fill-in discount off their
 * OWN rate. Urgency premium + fill-in discount both widen the margin,
 * and the claim IS the crew's consent: none of the same-day auto-push
 * hazards (silent overload, unjust no-show strikes) can occur.
 *
 * Windows: rush is bookable/claimable from OPEN_HOUR (nobody gets a
 * 3am "up for grabs" text) until the cutoff dial (default 2pm) — late
 * enough to fill an afternoon gap, early enough to actually do the work.
 */

/** Rush booking opens at 6am lake time — before that, "today" isn't real yet. */
export const RUSH_OPEN_HOUR = 6;

/** Customer's all-in rush price: menu + premium, whole dollars (rounded up —
 *  same convention as the scarcity offer). */
export function rushPrice(menuPrice: number, surchargePct: number): number {
  if (!(menuPrice > 0)) return 0;
  return Math.ceil(menuPrice * (1 + Math.max(0, surchargePct)));
}

/** Crew's fill-in take-home: their own standing rate minus the fill-in
 *  discount, to cents. The discount is a dial, not a negotiation — the board
 *  shows this number and tapping Claim is accepting it. */
export function fillInRate(standardRate: number, discountPct: number): number {
  if (!(standardRate > 0)) return 0;
  const d = Math.min(0.5, Math.max(0, discountPct));
  return Math.round(standardRate * (1 - d) * 100) / 100;
}

/** Is same-day booking/claiming open right now (lake-time hour)? */
export function rushWindowOpen(lakeHour: number, cutoffHour: number): boolean {
  return lakeHour >= RUSH_OPEN_HOUR && lakeHour < cutoffHour;
}

/** Validate the customer's pre-chosen fallback. Default: roll to tomorrow at
 *  the standard price (the gentler default — cancelling loses the demand). */
export function validRushFallback(raw: unknown): "roll" | "cancel" {
  return raw === "cancel" ? "cancel" : "roll";
}
