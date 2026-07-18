import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerNav } from "@/components/OwnerNav";
import { BookingGrid } from "@/components/BookingGrid";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile, getPricedServices } from "@/app/profile/data";

export default async function BookPage() {
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
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in to book services</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const profile = await getFullProfile();

  if (!profile?.hasProfile) {
    return (
      <>
        <TopBar />
        <OwnerNav />
        <div className="wrap" style={{ paddingTop: 24, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill gold">First things first</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>Set up your property to see prices</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Once your place is set up, every service here is priced exactly to it.
            </p>
            <Link className="ll-btn gold" href="/profile/setup">Start guided setup →</Link>
          </div>
        </div>
      </>
    );
  }

  const priced = await getPricedServices(profile);
  // Show the services this customer chose (fall back to all if none chosen).
  const wanted = profile.wanted_services.length
    ? priced.filter((s) => profile.wanted_services.includes(s.name))
    : priced;

  // Lake season window for water-work blocking.
  const { data: prop } = await supabase
    .from("properties")
    .select("lakes(name, ice_out_actual, pull_deadline)")
    .eq("owner_id", user.id)
    .limit(1)
    .maybeSingle();
  const lake = (Array.isArray(prop?.lakes) ? prop?.lakes[0] : prop?.lakes) as
    | { name?: string; ice_out_actual?: string; pull_deadline?: string }
    | undefined;

  return (
    <>
      <TopBar />
      <OwnerNav />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26 }}>Book services</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
          {profile.address ?? "Your place"}{lake?.name ? ` · ${lake.name}` : ""} — every price is exact to your property.
        </p>
        <BookingGrid
          services={wanted.map((s) => ({
            id: s.id,
            name: s.name,
            price: s.price,
            frequency_options: s.frequency_options,
            is_water_work: s.is_water_work,
          }))}
          season={{ start: lake?.ice_out_actual ?? null, end: lake?.pull_deadline ?? null, lake: lake?.name ?? null }}
        />
      </div>
    </>
  );
}
