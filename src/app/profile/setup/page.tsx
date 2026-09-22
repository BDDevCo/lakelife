import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ProfileWizard } from "@/components/ProfileWizard";
import { createClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile } from "../data";
import type { ServiceRule } from "@/lib/pricing";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

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
    // SERVED LAKES ONLY (lib/lake-visibility.ts). These chips are headed
    // "Which lake are you on or near?" and read as the list of places
    // LakeLife works — so an unpromoted lake sitting in them republishes one
    // stranger's typing to every customer who sets up after them, which is the
    // front-door defect one door in. Their OWN lake is unioned back below.
    supabase.from("lakes").select("name").match(SERVED_LAKE_MATCH).order("name"),
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

  // THEIR OWN LAKE IS ALWAYS ONE OF THE CHIPS, served or not.
  //
  // The gate above decides what LakeLife advertises; it must not decide what a
  // person who is already here can see about themselves. A homeowner who named
  // their lake last night would otherwise open this wizard to find no chip
  // selected and their lake missing from the list — they would pick a
  // neighbouring lake or re-type their own, and either way the property they
  // already have moves to a different row. Unioned rather than re-queried: the
  // name is already on the profile we just read.
  const servedLakeNames = (lakeRows ?? []).map((l) => l.name as string);
  const ownLake = profile?.hasProfile === true ? (profile.lake ?? null) : null;
  const lakes =
    ownLake && !servedLakeNames.includes(ownLake)
      ? [...servedLakeNames, ownLake]
      : servedLakeNames;
  const parks = (parkRows ?? []).map((r) => ({ id: r.id as string, name: r.name as string }));
  const services = (serviceRows ?? []) as unknown as ServiceRule[];
  const editingPropertyId = !addingNew && profile?.hasProfile ? profile.propertyId : null;

  const initial =
    profile?.hasProfile === true
      ? {
          lake: profile.lake ?? undefined,
          address: profile.address ?? undefined,
          // The pin. Absent here, ProfileWizard defaults it to null and the
          // save wipes it — on his lake house, on The Haven's grounds, and on
          // Lot 11, all of which carry real coordinates.
          lat: profile.lat ?? undefined,
          lng: profile.lng ?? undefined,
          // THE TWO FIELDS 0159 ADDED, and the two this page forgot to hand
          // over. getFullProfile returns both; without them a re-run opened
          // the pane count blank and, with window washing still ticked, wrote
          // panes: 0 over the saved count on finish — the same wipe the lat/lng
          // guard above exists for.
          panes: profile.panes ?? undefined,
          drive_band: profile.drive_band ?? undefined,
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
