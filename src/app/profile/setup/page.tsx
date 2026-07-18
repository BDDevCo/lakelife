import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ProfileWizard } from "@/components/ProfileWizard";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile } from "../data";
import type { ServiceRule } from "@/lib/pricing";

export default async function SetupPage() {
  if (!hasSupabaseEnv()) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad">Add your Supabase keys to <code>.env.local</code> first.</div>
        </div>
      </>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in to set up your property</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const [{ data: lakeRows }, { data: serviceRows }, profile] = await Promise.all([
    supabase.from("lakes").select("name").order("name"),
    supabase.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing").eq("active", true),
    getFullProfile(),
  ]);

  const lakes = (lakeRows ?? []).map((l) => l.name);
  const services = (serviceRows ?? []) as unknown as ServiceRule[];

  const initial =
    profile?.hasProfile === true
      ? {
          lake: profile.lake ?? undefined,
          address: profile.address ?? undefined,
          wanted: profile.wanted_services,
          sqft: profile.sqft,
          gate: profile.gate ?? undefined,
          beds: profile.beds,
          baths: profile.baths,
          pier_sections: profile.pier_sections,
          ladder: profile.ladder,
          bumpers: profile.bumpers,
          boat_lifts: profile.boat_lifts,
          canopy: profile.canopy,
          jet_skis: profile.jet_skis,
          pwc_lifts: profile.pwc_lifts,
          lawn_band: profile.lawn_band,
          boats: profile.boats,
          toys: profile.toys.map((t) => t.name),
        }
      : {};

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 40 }}>
        <div style={{ maxWidth: 560, margin: "0 auto 16px" }}>
          <h1 style={{ fontSize: 26 }}>Let&apos;s set up your place</h1>
          <p className="mut" style={{ fontSize: 14 }}>
            Pick the services that fit your place — we&apos;ll only ask about what you
            choose, and every price is exact from day one.
          </p>
        </div>
        <ProfileWizard lakes={lakes} services={services} initial={initial} />
      </div>
    </>
  );
}
