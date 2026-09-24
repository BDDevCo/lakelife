import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * A CREW BROUGHT THIS CUSTOMER — ONE ROUTINE, TWO DOORS.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * There are two ways a crew brings a homeowner onto LakeLife and, until this
 * file, they left the customer in two DIFFERENT states:
 *
 *   THE EMAILED DOOR — the crew stages the customer in `customer_imports`
 *   (vendor/import-actions.ts). On signup the row materialises into a real
 *   property with `preferred_vendor` already set, and `users.referred_by` is
 *   written under an `is("referred_by", null)` guard, so THE FIRST CREW WINS
 *   and the attribution is permanent. Both halves: the crew is their crew,
 *   and the ledger knows who brought them.
 *
 *   THE LINK DOOR — the crew shares `/?ref=<their code>`. RefCatcher drops the
 *   code in a 30-day cookie and `claimReferral` writes `users.referred_by` at
 *   the portal front door. That half worked. NOTHING SET preferred_vendor —
 *   so a crew who did the work by link was attributed for the money and was
 *   not the customer's crew. Half a rule, written into one doorway of two.
 *
 * Both doors now call `bindCrewToCustomer`. A third door that writes
 * `referred_by` by hand instead is the shape this file exists to make obvious.
 *
 * ============================================================================
 * WHAT IT DOES, IN ORDER, AND WHY THAT ORDER
 * ============================================================================
 *  1. FIRST CREW WINS. `users.referred_by` is written only while it is null.
 *     That guard is the rule; it is not decoration. A second crew importing
 *     the same household never takes the first crew's attribution.
 *  2. WHO THE BRINGER ACTUALLY IS decides everything below. If the guarded
 *     update wrote nothing, somebody else already holds the attribution — so
 *     we read it back rather than assume we won. A failed read stops here:
 *     no property is bound on a guess about somebody's money.
 *  3. IS THE BRINGER A CREW? A neighbour referring a neighbour (the
 *     ShareLakeLife card on /book) is the common case and must keep working —
 *     they get the attribution and no property is touched.
 *  4. THEIR CREW. Every property this customer owns that has NO crew is bound
 *     to the bringing crew. Properties that already name a crew are never
 *     touched: `preferred_vendor` is somebody else's answer and not ours to
 *     overwrite.
 *
 * WHY "properties with no crew" AND NOT "the one property":
 * the link door has no property at claim time — the homeowner creates it
 * afterwards, in guided setup — so the binding has to be able to run later.
 * `claimReferral` calls this on every portal load for exactly that reason, and
 * every step above is idempotent so that is a no-op once it has run.
 *
 * TODAY NOTHING CLEARS `preferred_vendor` (grep: it is written by
 * book/contractor-actions.ts, ops/dispatch-actions.ts and the import, and set
 * to null by nobody). So "null" means "never had one", and re-filling it is
 * not a risk. THE DAY A DOOR LETS A HOMEOWNER REMOVE THEIR CREW, this step has
 * to become one-shot, or it will hand the crew straight back.
 *
 * A SUSPENDED CREW IS NOT MADE ANYBODY'S CREW. The attribution still stands —
 * who brought them is a fact, and suspension is about working, not history —
 * but binding a paused crew to a house would route work at them. The emailed
 * door refuses a suspended crew at the action; this matches it at the claim,
 * which is a different day.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: create a property, create a profile,
 * book anything, or send anything. The staging row exists so that nothing is
 * invented for somebody who has not signed up.
 */

export interface BindOutcome {
  /** True when this crew holds the attribution (won it now, or already had it). */
  isBringer: boolean;
  /** True when this call wrote `referred_by` (as opposed to finding it set). */
  attributedNow: boolean;
  /** Properties that gained this crew as `preferred_vendor` on this call. */
  boundProperties: number;
  /** A read or write failed. Nothing here is retried; the caller logs it. */
  failed: boolean;
  /** Why nothing was bound, when nothing was — for the log, never for a screen. */
  note?: string;
}

const NOTHING: BindOutcome = { isBringer: false, attributedNow: false, boundProperties: 0, failed: false };

export async function bindCrewToCustomer(
  admin: ReturnType<typeof createServiceClient>,
  p: { userId: string; crewUserId: string },
): Promise<BindOutcome> {
  if (!p.userId || !p.crewUserId) return { ...NOTHING, note: "missing ids" };
  // SELF-REFERRAL. claimReferral blocks this on the code as well; this is the
  // backstop for every caller, including the import door where the "customer"
  // could be the crew's own account.
  if (p.userId === p.crewUserId) return { ...NOTHING, note: "self" };

  // 1. FIRST CREW WINS — guarded, so this is a no-op when somebody already has it.
  const wonRes = await admin
    .from("users")
    .update({ referred_by: p.crewUserId })
    .eq("id", p.userId)
    .is("referred_by", null)
    .select("id");
  if (wonRes.error) {
    console.error("[write failed] recording which crew brought this customer:", wonRes.error);
    return { ...NOTHING, failed: true, note: "attribution write failed" };
  }
  const attributedNow = (wonRes.data ?? []).length > 0;

  // 2. WHO HOLDS IT. Only when we did not just win it — otherwise we know.
  let isBringer = attributedNow;
  if (!attributedNow) {
    const meRes = await admin.from("users").select("referred_by").eq("id", p.userId).maybeSingle();
    // FAILS CLOSED. `null` here would read as "nobody brought them", and the
    // branch below would then hand this customer's properties to a crew who
    // may not be their bringer at all.
    if (meRes.error) {
      console.error("[read failed] which crew brought this customer:", meRes.error);
      return { ...NOTHING, failed: true, note: "attribution read failed" };
    }
    isBringer = ((meRes.data?.referred_by as string | null) ?? null) === p.crewUserId;
  }
  if (!isBringer) return { ...NOTHING, attributedNow: false, note: "another crew brought them first" };

  // 3. IS THE BRINGER A CREW AT ALL? A neighbour referral stops here.
  const vRes = await admin.from("vendors").select("id, status").eq("user_id", p.crewUserId).maybeSingle();
  if (vRes.error) {
    console.error("[read failed] whether the referrer is a crew:", vRes.error);
    return { isBringer, attributedNow, boundProperties: 0, failed: true, note: "crew lookup failed" };
  }
  const vendor = vRes.data as { id?: string; status?: string } | null;
  if (!vendor?.id) return { isBringer, attributedNow, boundProperties: 0, failed: false, note: "referrer is not a crew" };
  if (vendor.status === "suspended") {
    return { isBringer, attributedNow, boundProperties: 0, failed: false, note: "crew is paused — attributed, not bound" };
  }

  // 4. THEIR CREW — only where there is no answer already.
  const bindRes = await admin
    .from("properties")
    .update({ preferred_vendor: vendor.id })
    .eq("owner_id", p.userId)
    .is("preferred_vendor", null)
    .select("id");
  if (bindRes.error) {
    console.error("[write failed] making the bringing crew this customer's crew:", bindRes.error);
    return { isBringer, attributedNow, boundProperties: 0, failed: true, note: "property bind failed" };
  }
  return { isBringer, attributedNow, boundProperties: (bindRes.data ?? []).length, failed: false };
}

/**
 * THE SHAREABLE LINK, BUILT IN ONE PLACE.
 *
 * `/?ref=<code>` — the front door with the crew's own referral code on it.
 * Three things follow from reusing the scheme that already exists rather than
 * minting a new one:
 *
 *  · IT IS NOT A NEW TOKEN PATH. `/doc` was "the eighth token path nobody told
 *    robots.txt about"; a `/crew/<token>` route would have been the ninth, and
 *    src/lib/token-paths.ts plus its test exist to catch exactly that. This
 *    adds no route, so there is nothing new for robots.txt to disallow — and
 *    `/` is a page the sitemap declares and the crawler is meant to find.
 *    layout.tsx already collapses every `?ref=` variant onto the canonical `/`.
 *
 *  · NOTHING PERSONAL TRAVELS IN IT. The code identifies the CREW and nothing
 *    else — no customer, no address, no rate — so it is safe to forward,
 *    screenshot or post on a noticeboard, which is the entire point of a link
 *    a crew sends themselves.
 *
 *  · IT IS NOT A CREDENTIAL. Holding it grants nothing. It sets a cookie; the
 *    attribution is then matched server-side against a REAL user's
 *    `referral_code` at the portal front door, never trusted from the URL.
 *
 * `users.referral_code` is written by the column's own DB default
 * (`encode(gen_random_bytes(4), 'hex')`, migration 0027) — eight hex
 * characters, on every user row, with no application writer to forget. Verified
 * on production 23 Sep 2026: 0 of 8 user rows have a null code.
 */
export function referralLinkFor(code: string | null | undefined, siteUrl: string): string | null {
  const c = (code ?? "").trim();
  if (!/^[0-9a-f]{8}$/i.test(c)) return null;
  return `${siteUrl.replace(/\/+$/, "")}/?ref=${c}`;
}
