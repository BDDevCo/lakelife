import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ProfileWizard } from "@/components/ProfileWizard";
import { createClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile } from "../data";
import type { ServiceRule } from "@/lib/pricing";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: isNew } = await searchParams;
  const addingNew = isNew === "1";
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

  const [lakeRes, parkRes, serviceRes, profile] = await Promise.all([
    supabase.from("lakes").select("name").eq("is_fixture", false).order("name"),
    // Published parks only — an unpublished one is still being set up and its
    // owner has not asked to be listed anywhere.
    supabase.from("parks").select("id, name").eq("active", true).order("name"),
    supabase.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing").eq("active", true).or("kind.eq.standalone,solo_bookable.eq.true"),
    // When adding a new property, start blank; otherwise load the active one.
    addingNew ? Promise.resolve(null) : getFullProfile(),
  ]);
  // An empty dropdown here is indistinguishable from "we don't serve any lakes"
  // — and a park list that failed to load lets an edit save park_id = null over
  // a park the resident already declared.
  const lakeRows = mustRead("the lakes we serve", lakeRes);
  const parkRows = mustRead("the parks we serve", parkRes);
  const serviceRows = mustRead("the service menu", serviceRes);

  const lakes = (lakeRows ?? []).map((l) => l.name);
  const parks = (parkRows ?? []).map((r) => ({ id: r.id as string, name: r.name as string }));
  const services = (serviceRows ?? []) as unknown as ServiceRule[];
  const editingPropertyId = !addingNew && profile?.hasProfile ? profile.propertyId : null;

  const initial =
    profile?.hasProfile === true
      ? {
          lake: profile.lake ?? undefined,
          address: profile.address ?? undefined,
          place_id: profile.place_id ?? undefined,
          park_id: profile.park_id ?? undefined,
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
          <h1 style={{ fontSize: 26 }}>{addingNew ? "Add another property" : "Let's set up your place"}</h1>
          <p className="mut" style={{ fontSize: 14 }}>
            {addingNew
              ? "Same quick setup for your other home — pick its services and we'll price it exactly."
              : "Pick the services that fit your place — we'll only ask about what you choose, and every price is exact from day one."}
          </p>
        </div>
        <ProfileWizard lakes={lakes} parks={parks} services={services} initial={initial} propertyId={editingPropertyId} />
      </div>
    </>
  );
}
