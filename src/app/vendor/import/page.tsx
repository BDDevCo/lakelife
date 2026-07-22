import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorImport } from "@/components/VendorImport";
import { VendorOnboarding } from "@/components/VendorOnboarding";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getMyVendor } from "@/app/vendor/data";

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
    const admin = createServiceClient();
    const { data: svcs } = await admin.from("services").select("name").eq("active", true).order("name");
    const activeServices = (svcs ?? []).map((s) => s.name as string);
    const { data: lakeRows } = await admin.from("lakes").select("id, name").order("name");
    const lakes = (lakeRows ?? []).map((l) => ({ id: l.id as string, name: l.name as string }));
    return (
      <>
        <TopBar />
        <VendorNav />
        <VendorOnboarding vendor={vendor} activeServices={activeServices} lakes={lakes} />
      </>
    );
  }

  return (
    <>
      <TopBar />
      <VendorNav />
      <VendorImport />
    </>
  );
}
