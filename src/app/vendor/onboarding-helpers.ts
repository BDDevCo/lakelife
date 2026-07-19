// Pure helpers for vendor onboarding — no server imports, so vitest loads cleanly.

/** Only these upload MIME types are accepted (matches the vendor-docs bucket). */
export const DOC_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB

/** Sanitize a filename extension to a short alnum token (mirrors uploadJobPhoto). */
export function safeExt(name: string, fallback = "pdf"): string {
  return (name.split(".").pop() || fallback).toLowerCase().replace(/[^a-z0-9]/g, "") || fallback;
}

/**
 * Validate a COI expiry string. Must be an exact YYYY-MM-DD calendar date that
 * is strictly in the future relative to `today` (also YYYY-MM-DD, lake time).
 * Returns the normalized date on success, or null if invalid/past.
 */
export function validExpiry(raw: unknown, today: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Reject impossible calendar dates (e.g. 2026-02-31) by round-tripping in UTC
  // (timezone-free, so the comparison never day-shifts).
  const [y, m, day] = s.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
  // Must be a future date — an already-expired COI is no COI.
  if (s <= today) return null;
  return s;
}
