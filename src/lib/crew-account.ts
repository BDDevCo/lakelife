import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * IS THIS ACCOUNT ALSO A CREW?
 *
 * One question, one place, because the answer gates a screen that publishes
 * prices. A crew who opens a homeowner account is not a hypothetical: it is
 * the cheapest way to read the offers screen, and the offers screen is how a
 * competitor's whole rate card can be recovered (see the derivation note in
 * `app/book/crew-offers.ts` — every pricing model is linear in a field the
 * viewer owns and can edit, and the profile is re-read on every call).
 *
 * FAILS CLOSED, and that is the whole reason this returns two booleans rather
 * than one. A dropped read here would otherwise say "not a crew" and wave
 * through exactly the reader the guard exists to stop — this codebase's oldest
 * shape, a failed read making a guard PASS.
 */
export async function anyIsACrew(
  admin: ReturnType<typeof createServiceClient>,
  userIds: Array<string | null | undefined>,
): Promise<{ isCrew: boolean; failed: boolean }> {
  const ids = userIds.filter((u): u is string => !!u);
  if (ids.length === 0) return { isCrew: false, failed: false };
  const res = await admin.from("vendors").select("id").in("user_id", ids).limit(1);
  if (res.error) {
    console.error("[read failed] whether this account is also a crew:", res.error);
    return { isCrew: false, failed: true };
  }
  return { isCrew: (res.data ?? []).length > 0, failed: false };
}
