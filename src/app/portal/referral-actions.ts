"use server";

import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Claim a referral attribution at the portal front door (roadmap §8).
 * One-time and permanent: only set when referred_by is still null (guarded
 * update), the code must belong to a REAL user, and self-referral is blocked.
 * Rewards, when the owner turns them on (§8b), accrue only on collected
 * money — this just makes sure the history exists from day one.
 */
export async function claimReferral(userId: string): Promise<void> {
  try {
    const jar = await cookies();
    const code = jar.get("ll_ref")?.value;
    if (!code || !/^[0-9a-f]{8}$/i.test(code)) return;

    const admin = createServiceClient();
    const { data: me } = await admin.from("users").select("referred_by, referral_code").eq("id", userId).maybeSingle();
    if (!me || me.referred_by != null) return; // already attributed — permanent
    if ((me.referral_code as string)?.toLowerCase() === code.toLowerCase()) return; // self-referral blocked

    const { data: referrer } = await admin.from("users").select("id").ilike("referral_code", code).maybeSingle();
    if (!referrer || referrer.id === userId) return;

    await admin.from("users").update({ referred_by: referrer.id }).eq("id", userId).is("referred_by", null);
    jar.delete("ll_ref");
  } catch {
    /* attribution is best-effort — never block the front door */
  }
}
