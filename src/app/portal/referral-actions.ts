"use server";

import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/**
 * Claim a referral attribution at the portal front door (roadmap §8).
 * One-time and permanent: only set when referred_by is still null (guarded
 * update), the code must belong to a REAL user, and self-referral is blocked.
 * Rewards, when the owner turns them on (§8b), accrue only on collected
 * money — this just makes sure the history exists from day one.
 *
 * WHOSE ATTRIBUTION IS BEING SET COMES FROM THE SESSION.
 *
 * This file carries "use server", so this export is a POST endpoint and
 * `userId` was simply whatever the caller sent. The self-referral guard reads
 * the code against THAT user's `referral_code`, so pointing it at a stranger
 * sailed straight past it: put your own code in your own `ll_ref` cookie, call
 * this with somebody else's id, and you are permanently recorded as the person
 * who referred them — one-time and permanent by design, so there is no second
 * attempt to correct it. The portal passes its own getUser() id, so requiring
 * the argument to match changes nothing legitimate.
 */
export async function claimReferral(userId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || user.id !== userId) return;

    const jar = await cookies();
    const code = jar.get("ll_ref")?.value;
    if (!code || !/^[0-9a-f]{8}$/i.test(code)) return;

    const admin = createServiceClient();
    // BOTH READS BELOW FAIL CLOSED — a null takes an early `return` and no
    // attribution is written — which is the safe direction for something
    // one-time and permanent. What they must not do is fail SILENTLY: the
    // referral is dropped for good and the cookie is left behind, so the only
    // evidence this ever happened is the log line.
    const meRes = await admin.from("users").select("referred_by, referral_code").eq("id", userId).maybeSingle();
    if (meRes.error) {
      console.error("[read failed] referral attribution (your account):", meRes.error.code ?? "", meRes.error.message ?? meRes.error);
      return;
    }
    const me = meRes.data;
    if (!me || me.referred_by != null) return; // already attributed — permanent
    if ((me.referral_code as string)?.toLowerCase() === code.toLowerCase()) return; // self-referral blocked

    // The self-referral guard above has already run, so a failure here loses an
    // attribution but can never mis-assign one.
    const referrerRes = await admin.from("users").select("id").ilike("referral_code", code).maybeSingle();
    if (referrerRes.error) {
      console.error("[read failed] referral attribution (who referred you):", referrerRes.error.code ?? "", referrerRes.error.message ?? referrerRes.error);
      return;
    }
    const referrer = referrerRes.data;
    if (!referrer || referrer.id === userId) return;

    await admin.from("users").update({ referred_by: referrer.id }).eq("id", userId).is("referred_by", null);
    jar.delete("ll_ref");
  } catch (e) {
    /* attribution is best-effort — never block the front door, but say so */
    console.error("[referral attribution failed]", e);
  }
}
