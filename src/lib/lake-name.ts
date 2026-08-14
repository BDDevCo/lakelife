/**
 * Pure lake-name normalization (no server-only import so tests reach it).
 * Used by demand-born lakes (lib/lake-birth.ts).
 */
/**
 * Normalize a user-typed lake name: trim, collapse whitespace, Title Case,
 * ensure the " Lake" suffix. Null = unusable input (too short/long, test
 * prefix, no letters).
 */
export function normalizeLakeName(raw: string): string | null {
  let s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (s.length < 3 || s.length > 60) return null;
  if (!/[a-zA-Z]/.test(s)) return null;
  // Reserved for test fixtures. Stays a NAME check because this function is
  // pure and runs before any row exists — it stops a customer typing their way
  // into the fixture namespace. The fence itself is lakes.is_fixture (0124).
  if (/^zz-/i.test(s)) return null;
  s = s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  if (!/\bLake\b/i.test(s)) s = `${s} Lake`;
  return s;
}
