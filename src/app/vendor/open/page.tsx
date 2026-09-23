import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { OpenJobsBoard } from "@/components/OpenJobsBoard";
import { VendorOnboarding } from "@/components/VendorOnboarding";
import { loadOnboardingProps } from "../onboarding-props";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getMyVendor } from "@/app/vendor/data";
import { getOpenJobs } from "@/app/vendor/open-data";

export default async function VendorOpenJobsPage() {
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
              Open jobs is where LakeLife crews claim available work near them.
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
    // ONE LOADER FOR ALL FIVE DOORWAYS. Each page used to roll its own pair of
    // reads; the checklist now needs four facts, and four facts copied five
    // times is four rules written into one doorway of five.
    const props = await loadOnboardingProps(vendorId, user.id);
    return (
      <>
        <TopBar />
        <VendorNav />
        <VendorOnboarding vendor={vendor} {...props} />
      </>
    );
  }
  if (!vendor) {
    // Vendor row vanished between the two lookups — treat like no crew account.
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Crews only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the vendor area</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Open jobs is where LakeLife crews claim available work near them.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  const jobs = await getOpenJobs(vendor);

  return (
    <>
      <TopBar />
      <VendorNav />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Open jobs</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 18, maxWidth: 540 }}>
          Up for grabs &mdash; first crew to claim it gets it. You&apos;re paid your own rate.
        </p>
        <OpenJobsBoard jobs={jobs} />
      </div>
    </>
  );
}
