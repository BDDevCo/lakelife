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

/**
 * The mechanical, machine-checkable requirements a crew must satisfy to go
 * live WITHOUT a human approver (Phase A). Everything here is either a stored
 * document or a self-declared field — no judgment call. Deep authenticity of
 * the COI/W-9 is covered by the onboarding agreement + annual re-validation +
 * (later) a third-party verification callback, NOT by this gate.
 *
 * Returns the list of still-missing items (empty ⇒ ready to auto-activate).
 * `today` is YYYY-MM-DD lake time. Base location is intentionally optional —
 * it improves distance ranking but must never block activation.
 */
export interface ActivationInput {
  coi_url: string | null;
  coi_expiry: string | null;
  w9_url: string | null;
  service_types: string[] | null;
  service_lakes: string[] | null;
  daily_capacity: number | null;
}

export function activationGaps(v: ActivationInput, today: string): string[] {
  const gaps: string[] = [];
  if (!v.coi_url) gaps.push("Upload your insurance certificate (COI)");
  else if (v.coi_expiry == null || String(v.coi_expiry) <= today) gaps.push("Your COI is missing an expiry or already expired — upload a current one");
  if (!v.w9_url) gaps.push("Upload your W-9");
  if (!v.service_types || v.service_types.length === 0) gaps.push("Pick at least one kind of work you do");
  if (!v.service_lakes || v.service_lakes.length === 0) gaps.push("Choose the lakes you service");
  const cap = Math.floor(Number(v.daily_capacity));
  if (!Number.isFinite(cap) || cap < 1) gaps.push("Set how many jobs a day you can take");
  return gaps;
}

export function readyToActivate(v: ActivationInput, today: string): boolean {
  return activationGaps(v, today).length === 0;
}

/**
 * Sanity-bound a self-reported home base. Rejects non-finite values and the
 * classic 0,0 / out-of-region typo, using a generous continental-US envelope
 * (these lakes are in NE Indiana). Edge-of-region is accepted, not rejected —
 * confidence, not eligibility, is what distance handles later.
 */
export function validLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const a = Number(lat), o = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o)) return null;
  if (a === 0 && o === 0) return null;
  if (a < 24 || a > 50) return null;        // continental US latitude band
  if (o < -125 || o > -66) return null;     // continental US longitude band
  return { lat: a, lng: o };
}

/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC, no drift). */
export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/**
 * Is a crew due for a COI re-validation nudge TODAY? Fires on an exact boundary
 * so it sends once, with no per-crew tracking column (same idiom as the
 * seasonal pull reminder): true when the COI on file expires exactly `leadDays`
 * out, OR today is the yearly anniversary of the last verification. `verified_at`
 * is an ISO timestamp (or null = never); `coi_expiry`/`today` are YYYY-MM-DD.
 * (An actually-expired COI already drops the crew from routing — this is the
 * courtesy nudge ahead of that, plus the owner's yearly re-attest.)
 */
export function coiRevalidationDue(
  v: { coi_expiry: string | null; verified_at: string | null },
  today: string,
  leadDays = 30,
): boolean {
  if (v.coi_expiry && String(v.coi_expiry) === addDays(today, leadDays)) return true;
  if (v.verified_at && String(v.verified_at).slice(0, 10) === addDays(today, -365)) return true;
  return false;
}
