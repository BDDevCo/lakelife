/**
 * Turn a loosely-typed US mobile number into strict E.164 form
 * (e.g. "(260) 555-0100" -> "+12605550100"), which Twilio requires.
 * Returns null if it can't be understood as a valid number.
 */
export function toE164(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

/**
 * The pull deadline is always the estimated hard freeze minus an 8-day
 * safety buffer (CLAUDE.md rule 7). Pure helper so it can be unit-tested and
 * reused wherever season logic lives.
 */
export function pullDeadline(hardFreeze: Date): Date {
  const d = new Date(hardFreeze);
  d.setDate(d.getDate() - 8);
  return d;
}
