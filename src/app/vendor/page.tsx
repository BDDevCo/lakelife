import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorStopCard } from "@/components/VendorStopCard";
import { VendorRouteButton } from "@/components/VendorRouteButton";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getVendorDay } from "./data";

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

  const day = await getVendorDay();
  const stops = day?.stops ?? [];
  const prettyDay = day ? new Date(day.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
  const pins = stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat as number, lng: s.lng as number }));

  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <h1 style={{ fontSize: 26 }}>Today&apos;s route</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 4 }}>
          {prettyDay} — stops in drive order.
        </p>
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", marginBottom: 16 }}>
          Photos are required on every job — no photos, no completion, no payout.
        </p>

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
                <VendorStopCard key={s.id} stop={s} index={i} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
