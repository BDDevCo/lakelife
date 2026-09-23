import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { VendorRates } from "@/components/VendorRates";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyVendorId, getMyVendor } from "@/app/vendor/data";
import { getMyRates } from "@/app/vendor/rates-data";
import { crewPricedRateLines } from "@/app/vendor/rates-helpers";

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
              Rates are where LakeLife crews set their own price per service.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  // AN ONBOARDING CREW CAN PRICE — THIS DOOR JUST DIDN'T LET THEM.
  //
  // The invitation email makes rates step 4 (bank is 5, "Tap Go live" is 6),
  // and the Rates tab sits directly above that checklist in VendorNav. It used
  // to answer step 4 by returning the same six onboarding steps, none of them
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

  // THE WORST THING THIS CHANGE COULD DO TO ANYBODY IS A SILENT DEDUCTION.
  //
  // On a crew_priced service (0174) the number in the box below is a QUOTE:
  // LakeLife adds a published percentage for the customer and takes a published
  // percentage out of it, so a crew types $100 and is paid $88. Same column,
  // same screen, opposite meaning — and a contractor who finds that out from
  // their first payout has been cheated by a screen, whatever the contract says.
  //
  // So both numbers are printed here, in words, before they type anything.
  // `crewPricedRateLines` returns [] when nothing is crew-priced — which is
  // every service and every crew today — and this block does not render at all,
  // so an ordinary crew's page is unchanged to the byte. A fee sentence on a
  // service that charges no fee would be the mirror image of the same bug.
  const feeLines = crewPricedRateLines(rates);

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
      {feeLines.length > 0 && (
        <div className="wrap" style={{ paddingTop: 16, maxWidth: 620 }}>
          <div className="ll-card ll-card-pad">
            <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>
              What you&apos;re paid on the work you price yourself
            </h3>
            <p className="mut" style={{ fontSize: 13.5, margin: "0 0 12px" }}>
              On the {feeLines.length === 1 ? "service" : "services"} below you set the price.
              What you type is your quote — here is what it pays you.
            </p>
            {feeLines.map((s) => (
              <div key={s.name} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
                <b style={{ fontSize: 14.5 }}>{s.name}</b>
                <p className="mut" style={{ fontSize: 13, margin: "4px 0 0" }}>{s.note}</p>
                {s.sentences.map((line, i) => (
                  <p key={i} style={{ fontSize: 13.5, fontWeight: 700, margin: "6px 0 0", color: "var(--teal-dark)" }}>
                    {line}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <VendorRates rates={rates} notLiveYet={notLiveYet} />
    </>
  );
}
