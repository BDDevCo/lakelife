import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorStopCard } from "@/components/VendorStopCard";
import { VendorRouteButton } from "@/components/VendorRouteButton";
import { VendorStanding } from "@/components/VendorStanding";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { mustRead } from "@/lib/must-read";
import { getMyVendorId, getMyVendor, getVendorDay } from "./data";
import { getMyStanding } from "@/lib/scoring-data";
import { tierLabel } from "@/lib/scoring";
import { VendorOnboarding } from "@/components/VendorOnboarding";
import { VendorDocs } from "@/components/VendorDocs";
import { getNeedsYou } from "./needs-you-data";
import { VendorNeedsYou } from "@/components/VendorNeedsYou";
import { todayLakeDate } from "@/lib/booking";
import { TermsGate } from "@/components/TermsGate";
import { TOS_VERSION } from "@/lib/tos";
import { hasAccepted } from "@/lib/acceptances";
import { getSellableDay } from "@/lib/settings";
import { sellableMinutes, fitsInDay, clockLabel } from "@/lib/duration";

export default async function VendorTodayPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const vendorId = await getMyVendorId();
  if (!vendorId) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Crews only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the vendor area</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Your account isn&apos;t set up as a LakeLife crew. If that&apos;s a mistake, reach
              out to Ops and we&apos;ll get you routed.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // Not active yet? Show the onboarding checklist instead of the route.
  const vendor = await getMyVendor();
  if (vendor && vendor.status !== "active") {
    const admin = createServiceClient();
    const svcs = mustRead("the service list", await admin.from("services").select("name").eq("active", true).order("name"));
    const activeServices = (svcs ?? []).map((s) => s.name as string);
    const lakeRows = mustRead("the lake list", await admin.from("lakes").select("id, name").eq("is_fixture", false).order("name"));
    const lakes = (lakeRows ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));
    return (
      <>
        <TopBar />
        <VendorNav />
        <VendorOnboarding vendor={vendor} activeServices={activeServices} lakes={lakes} />
      </>
    );
  }

  // Grandfathered crews (active before the at-the-moment-of-service TOS rails
  // existed) accept once here, gating the route until they do. New crews
  // accept at go-live instead — this only fires for accounts already active.
  // Asks the LEDGER (0139), not the two columns on `users` that used to hold a
  // single acceptance with none of its words. `hasAccepted` throws on a failed
  // read rather than answering "no", so a dropped connection cannot put a crew
  // who already agreed back in front of the agreement.
  if (vendor && vendor.status === "active") {
    if (!(await hasAccepted({ userId: user.id }, "tos", TOS_VERSION))) {
      // The same card the park owner and the resident get. This JSX was the
      // only version that existed, and copying it into two more routes is how
      // three doors end up recording three slightly different things.
      return (
        <>
          <TopBar />
          <VendorNav />
          <TermsGate
            heading="The ground rules 🌊"
            intro={
              "One read-through before your first job. You're an independent " +
              "business here — the work is yours, and so is the money for it."
            }
            next="/vendor"
            cta="I agree — back to my route 🌊"
          />
        </>
      );
    }
  }

  const admin2 = createServiceClient();
  const [day, standing, confRes, needsYou] = await Promise.all([
    getVendorDay(),
    getMyStanding(vendorId),
    admin2.from("job_confirmations").select("verdict").eq("vendor_id", vendorId).not("verdict", "is", null),
    // A FAILED SIDECAR MUST NOT TAKE THE ROUTE DOWN.
    //
    // This is the screen a crew works from at 7am. If the dispute read fails,
    // they still need their stops — so the failure lands in the card as a
    // sentence rather than as a page that will not load. The card says it
    // could not check, which is the one thing an empty card cannot say.
    getNeedsYou(vendorId).catch((e) => {
      console.error("[vendor] couldn't build what-needs-you:", e);
      return { held: [], pausedLakes: [], checkFailed: true };
    }),
  ]);
  const confRows = mustRead("your customer feedback", confRes);
  const thumbsUp = (confRows ?? []).filter((c) => c.verdict === "good").length;
  const thumbsDown = (confRows ?? []).filter((c) => c.verdict === "issue").length;
  const standingLabels = standing ? tierLabel(standing.tier) : null;
  const stops = day?.stops ?? [];
  const prettyDay = day ? new Date(day.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
  const pins = stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
  // Truck pill (polish item 1): only worth showing once ANY stop today
  // carries a truck name — a single-truck (legacy) vendor's list stays
  // exactly as clean as before.
  const showTrucks = stops.some((s) => s.unit_name);

  // HOW FULL THE DAY IS, IN THE CREW'S OWN TERMS.
  //
  // 0083 put 7am-4pm in the database and wrote `sellableMinutes` and
  // `fitsInDay` to reason about it — then rendered neither, so the rule
  // existed and nobody it protects could see it. The sum uses each job's
  // STAMPED minutes, which is why a twelve-section pier now shows as the
  // four-hour stop it is rather than the three-hour one the flat dial claimed.
  const sellDay = await getSellableDay();
  const bookedMinutes = stops.reduce((n, st) => n + Math.max(0, st.est_minutes ?? 0), 0);
  const capacity = sellableMinutes(sellDay);
  const fit = fitsInDay(sellDay, 0, bookedMinutes);
  const hrs = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`);
  const dayFill =
    bookedMinutes > 0 && capacity > 0
      ? fit.fits
        ? `About ${hrs(bookedMinutes)} of work — finishing around ${clockLabel(fit.endsAtMinutes)}.`
        : `About ${hrs(bookedMinutes)} of work — that runs ${hrs(fit.overBy)} past ${clockLabel(sellDay.endHour * 60)}. Tell us if it's too much.`
      : null;

  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26 }}>Today&apos;s route</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 4 }}>
          {prettyDay} — stops in drive order.
          {dayFill && <>{" "}{dayFill}</>}
        </p>
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", marginBottom: 16 }}>
          Photos are required on every job — no photos, no completion, no payout.
        </p>

        {/* Above standing on purpose: held pay and a paused lake are things a
            crew has to ACT on, and standing is something they read. */}
        <VendorNeedsYou data={needsYou} today={todayLakeDate()} />

        {standing && standingLabels && (
          <VendorStanding standing={standing} label={standingLabels.label} blurb={standingLabels.blurb} thumbsUp={thumbsUp} thumbsDown={thumbsDown} />
        )}

        {stops.length === 0 ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <p className="mut" style={{ fontSize: 14 }}>
              No stops on your route today. The scheduler rebuilds routes each night at 8pm —
              check back in the morning. 🌊
            </p>
          </div>
        ) : (
          <>
            {pins.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <VendorRouteButton points={pins} count={stops.length} />
              </div>
            )}
            <div style={{ display: "grid", gap: 12 }}>
              {stops.map((s, i) => (
                <VendorStopCard key={s.id} stop={s} index={i} truckLabel={showTrucks ? s.unit_name : null} />
              ))}
            </div>
          </>
        )}

        {/* PAPERWORK, FOR A CREW WHO IS ALREADY WORKING. These controls used to
            live ONLY inside the onboarding checklist, which renders only while
            the crew is not yet active — so the day they were approved, every
            way to replace an expiring COI vanished, while the nightly kept
            emailing them "Update my COI → /vendor". Quiet when everything is
            in date; loud when it isn't. */}
        {vendor && (
          <VendorDocs
            coiUrl={vendor.coi_url}
            coiExpiry={vendor.coi_expiry}
            w9Url={vendor.w9_url}
            today={todayLakeDate()}
          />
        )}
      </div>
    </>
  );
}
