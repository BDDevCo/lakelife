/**
 * Payout math — PURE, no I/O. Early-pay ("get it now") costs the
 * early_payout_fee_pct dial; month-end batches run free. ABA routing
 * numbers get the real checksum so a typo'd bank account never makes
 * it into the encrypted vault.
 */

/** The standard ABA routing checksum (3-7-1 weighting). */
export function abaValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum > 0 && sum % 10 === 0;
}

/** Plausible US account number: 4–17 digits. */
export function accountPlausible(account: string): boolean {
  return /^\d{4,17}$/.test(account);
}

/** Early-pay economics: fee rounds to cents, net is the remainder. */
export function earlyFee(gross: number, feePct: number): { fee: number; net: number } {
  const g = Math.max(0, Math.round(gross * 100) / 100);
  const fee = Math.round(g * Math.max(0, feePct) * 100) / 100;
  return { fee, net: Math.round((g - fee) * 100) / 100 };
}
