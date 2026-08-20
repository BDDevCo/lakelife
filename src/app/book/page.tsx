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
import { mustRead, mustCount, softRead, ReadFailed } from "@/lib/must-read";
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
  // A failed read would show a verified customer the "verify your mobile"
  // wall, on a number they verified months ago.
  const me = mustRead(
    "your account",
    await supabase
      .from("users")
      .select("email_verified, phone_verified")
      .eq("id", user.id)
      .maybeSingle(),
  );
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
  // THE TICKER IS NOT WORTH THE BOOKING SCREEN. getMyReferralTicker throws on
  // a failed read now, and unguarded that took the whole page to the error
  // boundary over a share-a-friend total. Caught here it stays null, and the
  // card below already hides the figure entirely when there isn't one — so
  // nothing is asserted about their earnings, the screen just doesn't claim a
  // number it couldn't read. mustRead has already logged which read failed.
  let referralTicker: Awaited<ReturnType<typeof getMyReferralTicker>> = null;
  try {
    referralTicker = await getMyReferralTicker();
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
  }
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
  const packageCount = mustCount(
    "the storage packages",
    await supabase
      .from("service_packages")
      .select("id", { count: "exact", head: true })
      .eq("active", true),
  );
  // A $0 TILE IS A TILE THAT CANNOT BE BOOKED.
  //
  // `priceService` returns exactly 0 when a service does not apply to this
  // property at all — no pier, no lifts, no boat — and `createBooking` then
  // refuses it outright ("prices to $0 for your place"). Rendering it anyway
  // gave every customer a row of dead Schedule buttons, and the audit that
  // added `serviceApplies` fixed the arithmetic without ever removing the
  // tile.
  //
  // It only became obvious when a park resident's lot was minted: their menu
  // led with "Pier install / removal — $0" on a mobile home. Filtering here
  // fixes it for lake homeowners too — anyone without a boat has been looking
  // at unbookable boat services since the day this page shipped.
  const applicable = priced.filter((s) => s.price > 0);

  // Show the services this customer chose (fall back to all if none chosen).
  const wanted = profile.wanted_services.length
    ? applicable.filter((s) => profile.wanted_services.includes(s.name))
    : applicable;

  // Lake season window for the active property (water-work blocking).
  // FAILS OPEN if left alone: no lake row means start/end null, and rule 7's
  // ice-out / pull-deadline gate simply isn't applied to the calendar.
  const prop = mustRead(
    "your lake's season dates",
    await supabase
      .from("properties")
      .select("lakes(name, ice_out_actual, pull_deadline)")
      .eq("owner_id", user.id)
      .eq("id", profile.propertyId!)
      .maybeSingle(),
  );
  const lake = (Array.isArray(prop?.lakes) ? prop?.lakes[0] : prop?.lakes) as
    | { name?: string; ice_out_actual?: string; pull_deadline?: string }
    | undefined;

  // Autopilot enrollment state — RLS means owners only ever see their own
  // rows. The table may not exist yet (migration pending): a query error just
  // means "not enrolled", never a crash.
  // Swallowed on purpose (see above), but no longer silently: softRead logs the
  // failure before degrading to "not enrolled".
  const [autopilotRows] = softRead(
    "your Autopilot settings",
    await supabase
      .from("autopilot_enrollments")
      .select("service_id, active, locked_price")
      .eq("property_id", profile.propertyId!),
    null,
  );
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
        {(packageCount ?? 0) > 0 && (
          <Link href="/book/storage" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="ll-card ll-card-pad" style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Winter &amp; storage packages 🧊</h3>
                <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
                  Winterize, store, splash back in spring — one all-in price, your choice of who tows.
                </p>
              </div>
              <span aria-hidden style={{ fontSize: 18, color: "var(--sub)" }}>›</span>
            </div>
          </Link>
        )}
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
            creditAvailable={referralTicker?.available}
            maturing={referralTicker?.maturing}
            availableIsPayout={referralTicker?.isCrew}
            customerPct={Math.round(dials.referralCustomerPct * 100)}
            crewCap={dials.referralCrewCap}
          />
        )}
      </div>
    </>
  );
}
