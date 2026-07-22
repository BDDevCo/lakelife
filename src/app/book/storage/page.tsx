import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { StoragePackageWizard } from "@/components/StoragePackageWizard";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile, toPricingProfile } from "@/app/profile/data";
import { getPackageViews } from "./data";

/**
 * Winter & storage packages (S2). Customer surface: every number on it is
 * a customer price computed server-side against THIS property; crew rates
 * and margin never reach the client (rule 1). Packages appear here the
 * moment ops flips service_packages.active — the launch switch.
 */
export default async function StorageBookingPage() {
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in to book</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const profile = await getFullProfile();
  if (!profile?.hasProfile || !profile.propertyId) {
    return (
      <>
        <TopBar />
        <OwnerHeader />
        <div className="wrap" style={{ paddingTop: 24, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill gold">First things first</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>Set up your property to see prices</h2>
            <Link className="ll-btn gold" href="/profile/setup">Start guided setup →</Link>
          </div>
        </div>
      </>
    );
  }

  const hasBoats = profile.boats.length > 0;
  const packages = hasBoats ? await getPackageViews(toPricingProfile(profile)) : [];
  const boatLabel = profile.boats
    .map((b) => {
      const eng = b.engine_type && b.engine_type !== "none"
        ? ` · ${(b.engines ?? 1) > 1 ? "twin " : ""}${b.engine_hp ? `${b.engine_hp}hp ` : ""}${b.engine_type}`
        : "";
      return `${b.length_ft}' ${b.type}${eng}`;
    })
    .join(" + ");

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, paddingBottom: 48, maxWidth: 720 }}>
        <div className="ll-eyebrow">Winter &amp; storage</div>
        <h1 style={{ fontSize: 26, margin: "6px 0 6px" }}>Put the boat to bed properly 🧊</h1>
        <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
          Pick how it gets to the shop and where it sleeps — one all-in price, split honestly:
          the fall visit bills when it&apos;s done, spring bills at splash.
        </p>
        {!hasBoats ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <h3 style={{ fontSize: 18, margin: "0 0 6px" }}>Add your boat first</h3>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
              Storage and winterization are priced by your boat — length and engine. Takes a minute.
            </p>
            <Link className="ll-btn gold" href="/profile/setup">Add my boat →</Link>
          </div>
        ) : packages.length === 0 ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <h3 style={{ fontSize: 18, margin: "0 0 6px" }}>Winter packages open soon 🌊</h3>
            <p className="mut" style={{ fontSize: 14, margin: 0 }}>
              We&apos;re lining up shops and barns now — you&apos;ll get a text the day booking opens.
            </p>
          </div>
        ) : (
          <StoragePackageWizard packages={packages} boatLabel={boatLabel} />
        )}
      </div>
    </>
  );
}
