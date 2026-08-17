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
 * The same number, in the shape a person wrote it — for showing back, never
 * for sending.
 *
 * `mobile_e164` is the storage form and it is the only form a screen had. So
 * the resident typed "(260) 555-0142", was told "Code sent to (260) 555-0142"
 * in her own words, and then the card that confirmed it read "We'll text
 * +12605550142 about your lot and your rent" — the one place in the product
 * where a stored number reached a person in machine form.
 *
 * Anything that is not a plain US ten- or eleven-digit number comes back
 * exactly as it went in: `toE164` accepts international numbers too, and a
 * wrong guess at their grouping is worse than not guessing.
 */
export function prettyPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
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
