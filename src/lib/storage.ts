/**
 * Winter-storage money math — PURE, no I/O. The seasonal minimum is part
 * of the fall visit's price (charged at fall completion, existing settle
 * machinery). THIS file owns what happens after: when the season ends and
 * what the overstay per-diem costs. S4's spring-splash finalize and the
 * overstay notices consume these; nothing here reads a clock or the DB —
 * dates come in, dollars come out (rule 8: the rates are dials).
 */

import { daysInMonth } from "@/lib/booking";

/**
 * The season-end date governing a stay: the first occurrence of the
 * (month, day) dial ON OR AFTER intake. An October 2026 intake ends
 * May 31, 2027; a (weird) June 2027 intake would end May 31, 2028.
 *
 * The (month, day) pair is clamped TOGETHER, per candidate year (audit
 * finding 9). Clamping them independently — 1-12 and 1-31 — made (4, 31)
 * settable and emitted "2027-04-31": a date Postgres rejects, that JS rolls
 * to May 1, and that `overstayDays` can't parse at all — so the per-diem
 * meter read zero and an overstaying boat billed nothing. It also sorted
 * BEFORE "2027-05-01" lexically, pushing the due-out date a full year out.
 */
export function seasonEndFor(intakeISO: string, endMonth: number, endDay: number): string {
  const [y] = intakeISO.split("-").map(Number);
  const m = Math.min(12, Math.max(1, Math.round(endMonth)));
  const wantedDay = Math.max(1, Math.round(endDay));
  // Per year, because Feb 29 exists in a leap year and not in a common one.
  const on = (year: number) => {
    const d = Math.min(wantedDay, daysInMonth(year, m));
    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const sameYear = on(y);
  return sameYear >= intakeISO ? sameYear : on(y + 1);
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
