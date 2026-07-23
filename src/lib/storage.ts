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
