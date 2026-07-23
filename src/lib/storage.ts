/**
 * Winter-storage money math — PURE, no I/O. The seasonal minimum is part
 * of the fall visit's price (charged at fall completion, existing settle
 * machinery). THIS file owns what happens after: when the season ends and
 * what the overstay per-diem costs. S4's spring-splash finalize and the
 * overstay notices consume these; nothing here reads a clock or the DB —
 * dates come in, dollars come out (rule 8: the rates are dials).
 */

/**
 * The season-end date governing a stay: the first occurrence of the
 * (month, day) dial ON OR AFTER intake. An October 2026 intake ends
 * May 31, 2027; a (weird) June 2027 intake would end May 31, 2028.
 */
export function seasonEndFor(intakeISO: string, endMonth: number, endDay: number): string {
  const [y] = intakeISO.split("-").map(Number);
  const mm = String(Math.min(12, Math.max(1, Math.round(endMonth)))).padStart(2, "0");
  const dd = String(Math.min(31, Math.max(1, Math.round(endDay)))).padStart(2, "0");
  const sameYear = `${y}-${mm}-${dd}`;
  return sameYear >= intakeISO ? sameYear : `${y + 1}-${mm}-${dd}`;
}

/** Whole days past the season end (0 when out on time). Date-only math. */
export function overstayDays(outISO: string, seasonEndISO: string): number {
  const out = Date.parse(outISO + "T00:00:00Z");
  const end = Date.parse(seasonEndISO + "T00:00:00Z");
  if (!Number.isFinite(out) || !Number.isFinite(end) || out <= end) return 0;
  return Math.round((out - end) / 86_400_000);
}

/** The overstay charge: days × the daily dial, whole cents. */
export function perdiemCharge(days: number, dailyRate: number): number {
  if (!(days > 0) || !(dailyRate > 0)) return 0;
  return Math.round(days * dailyRate * 100) / 100;
}

/**
 * True recomputed per-leg prices to the booking-time QUOTE (the promise
 * wins even if menu dials moved over the winter). Proportional scaling,
 * every leg clamped ≥ 0, whole dollars, rounding remainder on the
 * largest leg — items always sum exactly to the quote.
 */
export function trueLegsToQuote(
  legs: Array<{ id: string; price: number }>,
  quote: number,
): Array<{ id: string; price: number }> {
  if (!legs.length) return [];
  const q = Math.max(0, Math.round(quote));
  const sum = legs.reduce((t, l) => t + Math.max(0, l.price), 0);
  if (q === 0 || sum === 0) {
    // No honest proportions available — put the whole quote on the largest.
    const out = legs.map((l) => ({ id: l.id, price: 0 }));
    out.reduce((a, b) => (b.price >= a.price ? b : a), out[0]).price = q;
    return out;
  }
  const scaled = legs.map((l) => ({ id: l.id, price: Math.max(0, Math.floor((Math.max(0, l.price) * q) / sum)) }));
  const drift = q - scaled.reduce((t, l) => t + l.price, 0);
  scaled.reduce((a, b) => (b.price >= a.price ? b : a), scaled[0]).price += drift;
  return scaled;
}
