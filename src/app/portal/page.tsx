import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { claimCrewInvite } from "@/app/ops/crews-invite";
import { claimCustomerImports } from "@/app/vendor/import-actions";
import { claimReferral } from "./referral-actions";

/**
 * The one front door after sign-in: sends each person to THEIR portal.
 * Crews land on today's route; homeowners land on booking. If this email
 * has a pending crew invite, it's claimed right here — sign up with the
 * invited email and you're a crew, no extra steps.
 */
export default async function PortalPage() {
  if (!hasSupabaseEnv()) redirect("/");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: me } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // Referral attribution (one-time, self-referral blocked) — §8 rails.
  await claimReferral(user.id);

  let role = me?.role;
  if (role !== "vendor" && role !== "ops") {
    const claimed = await claimCrewInvite(user.id, user.email);
    if (claimed) role = "vendor";
  }

  // Homeowners: materialize any crew-imported properties (crew stays preferred).
  if (role !== "vendor" && role !== "ops") {
    await claimCustomerImports(user.id, user.email);
  }

  if (role === "ops") redirect("/ops");
  redirect(role === "vendor" ? "/vendor" : "/book");
}
