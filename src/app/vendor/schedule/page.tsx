import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorCalendar } from "@/components/VendorCalendar";
import { VendorOnboarding } from "@/components/VendorOnboarding";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { mustRead } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import { getMyVendorId, getMyVendor } from "../data";
import { getCrewCalendarYear } from "../job-detail-data";

/**
 * THE CREW'S SEASON, AT A GLANCE. A crew used to be able to see exactly one
 * day — today. This is every job they're assigned, month by month, each one
 * clickable through to its own page.
 *
 * force-dynamic: the rows are personal and change through the day, and the
 * job pages this links into serve one-hour signed photo URLs.
 */
export const dynamic = "force-dynamic";

export default async function VendorSchedulePage() {
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
              Your schedule is where LakeLife crews see the whole season of their own work.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // Not active yet? Show the onboarding checklist (same as the Today tab).
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

  const today = todayLakeDate();
  const year = Number(today.slice(0, 4));
  const rows = await getCrewCalendarYear(year);

  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720, paddingBottom: 32 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your schedule</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 16, maxWidth: 560 }}>
          Every job that&apos;s yours, month by month. Tap any one to open it — photos, gate code
          on the day, and the buttons that close it out.
        </p>
        <VendorCalendar today={today} initialYear={year} initialRows={rows} />
      </div>
    </>
  );
}
