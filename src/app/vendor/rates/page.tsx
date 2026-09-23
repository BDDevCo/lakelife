import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorRates } from "@/components/VendorRates";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getMyVendor } from "@/app/vendor/data";
import { getMyRates } from "@/app/vendor/rates-data";

export default async function VendorRatesPage() {
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
              Rates are where LakeLife crews set their private take-home per service.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // AN ONBOARDING CREW CAN PRICE — THIS DOOR JUST DIDN'T LET THEM.
  //
  // The invitation email makes rates step 4 and "Tap Go live" step 5, and the
  // Rates tab sits directly above that checklist in VendorNav. It used to
  // answer step 4 by returning the same six onboarding steps, none of them
  // about money — and the wizard offers no rates control at all, so the step
  // the email promised had no door anywhere. MyServicesEditor points an
  // onboarding crew here too ("set what you charge for each of these on your
  // rates page").
  //
  // The permission was never the problem. rates-data.ts has said since it was
  // written that "a still-onboarding crew can set rates", getMyRates asks only
  // getMyVendorId, and setMyRate refuses a SUSPENDED crew and nothing else.
  // The right thing existed one import away; the door didn't use it.
  const vendor = await getMyVendor();
  const rates = await getMyRates();
  // Not live yet: a rate here is necessary and not sufficient, and the screen
  // below says "no rate, no routing" as though it were the only thing left.
  const notLiveYet = vendor != null && vendor.status !== "active";

  return (
    <>
      <TopBar />
      <VendorNav />
      {notLiveYet && (
        <div className="wrap" style={{ paddingTop: 24, maxWidth: 620 }}>
          <p className="ll-notice">
            You&apos;re not live yet, so nothing is being offered to you at all — what you set
            here is on file and waiting. Offers start the moment you tap <b>Go live</b> on the
            Today tab.
          </p>
        </div>
      )}
      <VendorRates rates={rates} notLiveYet={notLiveYet} />
    </>
  );
}
