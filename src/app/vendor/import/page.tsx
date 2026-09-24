import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorImport } from "@/components/VendorImport";
import { RecommendCustomer } from "@/components/RecommendCustomer";
import { VendorOnboarding } from "@/components/VendorOnboarding";
import { loadOnboardingProps } from "../onboarding-props";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getMyVendor } from "@/app/vendor/data";
import { getMyCrewLink } from "@/app/vendor/import-actions";

export default async function VendorImportPage() {
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
              Importing your customers is for LakeLife crews bringing their book of business over.
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

  // Read server-side so the link is on the page at first paint rather than
  // arriving after a spinner. It fails soft: `reason` carries WHY there is no
  // link — suspended, still onboarding, or a read that did not answer — and the
  // card prints that rather than a link-shaped blank.
  const crewLink = await getMyCrewLink();

  return (
    <>
      <TopBar />
      <VendorNav />
      {/* ONE AT A TIME FIRST, because that is how a crew actually recommends
          somebody — at a dock, in a conversation. The bulk paste below is the
          chore they do once, and both go through the same door. */}
      <RecommendCustomer link={crewLink.link} linkReason={crewLink.reason} />
      <VendorImport />
    </>
  );
}
