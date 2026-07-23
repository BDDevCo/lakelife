import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { claimCrewInvite } from "@/app/ops/crews-invite";
import { claimCustomerImports } from "@/app/vendor/import-actions";
import { claimReferral } from "./referral-actions";
import { acceptTos } from "./tos-actions";
import { TOS_VERSION } from "@/lib/tos";
import Link from "next/link";
import { TopBar } from "@/components/Brand";

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
    .select("role, tos_version")
    .eq("id", user.id)
    .maybeSingle();

  // THE AGREEMENT GATE (owner posture): one user agreement, both sides,
  // explicitly accepted and version-stamped. Everyone passes this door at
  // sign-in; bumping TOS_VERSION re-prompts the whole platform here.
  if (me && me.tos_version !== TOS_VERSION) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill gold">One thing first</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>The ground rules 🌊</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 6 }}>
              LakeLife connects you with independent local crews — the service agreement is
              between you and them, and we run the rails: one price, photo-verified work,
              verified insurance on every crew.
            </p>
            <p className="mut" style={{ fontSize: 13.5, marginBottom: 16 }}>
              Read the <Link href="/terms" style={{ color: "var(--teal-dark)", fontWeight: 700 }}>terms of service</Link>, then continue.
            </p>
            <form action={acceptTos}>
              <button className="ll-btn gold" style={{ minHeight: 46 }}>I agree — let&apos;s go 🌊</button>
            </form>
          </div>
        </div>
      </>
    );
  }

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
