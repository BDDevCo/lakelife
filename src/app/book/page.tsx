import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { BookingGrid } from "@/components/BookingGrid";
import { InviteMyCrew } from "@/components/InviteMyCrew";
import { AutopilotCard } from "@/components/AutopilotCard";
import { ShareLakeLife } from "@/components/ShareLakeLife";
import { getMyReferralTicker } from "@/lib/referral-data";
import { getPlatformSettings } from "@/lib/settings";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyReferralLink, getFullProfile, getPricedServices } from "@/app/profile/data";

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

  // RULE 5 nudge: booking needs a confirmed email + SMS-verified mobile.
  // Surface it here as a friendly step, not as a failure at confirm time.
  const { data: me } = await supabase
    .from("users")
    .select("email_verified, phone_verified")
    .eq("id", user.id)
    .maybeSingle();
  const emailOk = (me?.email_verified ?? false) || Boolean(user.email_confirmed_at);
  const phoneOk = me?.phone_verified ?? false;
  if (!emailOk || !phoneOk) {
    return (
      <>
        <TopBar />
        <OwnerHeader />
        <div className="wrap" style={{ paddingTop: 24, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill gold">One quick step</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>
              {phoneOk ? "Confirm your email to book" : "Verify your mobile to book"}
            </h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              {phoneOk
                ? "Click the link we emailed you, then come right back."
                : "It takes 30 seconds — this is the number crews text when they're on the way."}
            </p>
            {!phoneOk && <Link className="ll-btn gold" href="/verify">Verify my mobile →</Link>}
          </div>
        </div>
      </>
    );
  }

  const profile = await getFullProfile();
  const referralLink = await getMyReferralLink();
  const referralTicker = await getMyReferralTicker();
  const dials = await getPlatformSettings();

  if (!profile?.hasProfile) {
    return (
      <>
        <TopBar />
        <OwnerHeader />
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

  // Lake season window for the active property (water-work blocking).
  const { data: prop } = await supabase
    .from("properties")
    .select("lakes(name, ice_out_actual, pull_deadline)")
    .eq("owner_id", user.id)
    .eq("id", profile.propertyId!)
    .maybeSingle();
  const lake = (Array.isArray(prop?.lakes) ? prop?.lakes[0] : prop?.lakes) as
    | { name?: string; ice_out_actual?: string; pull_deadline?: string }
    | undefined;

  // Autopilot enrollment state — RLS means owners only ever see their own
  // rows. The table may not exist yet (migration pending): a query error just
  // means "not enrolled", never a crash.
  const { data: autopilotRows } = await supabase
    .from("autopilot_enrollments")
    .select("service_id, active, locked_price")
    .eq("property_id", profile.propertyId!);
  const enrollments = (autopilotRows ?? []).map((r) => ({
    service_id: String(r.service_id),
    active: Boolean(r.active),
    locked_price: Number(r.locked_price) || 0,
  }));

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26 }}>Book services</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
          {profile.address ?? "Your place"}{lake?.name ? ` · ${lake.name}` : ""} — every price is exact to your property.
        </p>
        <InviteMyCrew />
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
        <AutopilotCard
          propertyId={profile.propertyId!}
          services={wanted
            .filter((s) => s.price > 0)
            .map((s) => ({ id: s.id, name: s.name, price: s.price }))}
          enrollments={enrollments}
        />
        {referralLink && (
          <ShareLakeLife
            link={referralLink}
            earnedToDate={referralTicker?.earnedTotal}
            customerPct={Math.round(dials.referralCustomerPct * 100)}
            crewCap={dials.referralCrewCap}
          />
        )}
      </div>
    </>
  );
}
