import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { ApprovalCard } from "@/components/ApprovalCard";
import { AddonCard } from "@/components/AddonCard";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getOwnerFlags } from "./data";
import { getOwnerAddons } from "@/app/addons/data";

export default async function ApprovalsPage() {
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

  const flags = await getOwnerFlags();
  const pending = flags.filter((f) => f.status === "pending");
  const decided = flags.filter((f) => f.status !== "pending");

  // THE EXTRAS THEY ASKED FOR, ON THE SAME SCREEN (0180). One place in this
  // product asks a homeowner to say yes or no to money; a second approvals
  // screen is how people stop reading either. `getOwnerAddons` throws on a
  // failed read rather than returning [], so "you have nothing waiting" is
  // never printed over a read that did not happen.
  const addons = await getOwnerAddons();
  const addonsPending = addons.filter((a) => a.status === "quoted" || a.status === "requested");
  const addonsDecided = addons.filter((a) => a.status !== "quoted" && a.status !== "requested");
  const nothingAtAll = flags.length === 0 && addons.length === 0;

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, marginBottom: 16 }}>Messages &amp; approvals</h1>

        {/* THE ONE OUTLIER among the product's lone-card empty states, which
            are centred and muted at 14 on /requests, /messages, /vendor,
            Earnings and the ops board. This was left-aligned, 15, and ink —
            written in the same commit as the vendor one, which already had
            the shape. The prototype has no page-level empty state, so the
            app's own majority is the authority here. */}
        {nothingAtAll ? (
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <p className="mut" style={{ fontSize: 14, margin: 0 }}>
              No approvals waiting. When a crew spots something that differs from your profile — or prices
              an extra you&apos;ve asked for — it&apos;ll show up here for your OK.
            </p>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <>
                <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
                  A crew flagged something at your place. Nothing changes — or bills — until you approve.
                </p>
                {pending.map((f) => (
                  <ApprovalCard key={f.id} flag={f} />
                ))}
              </>
            )}

            {addonsPending.length > 0 && (
              <>
                <p className="mut" style={{ fontSize: 14, margin: pending.length > 0 ? "22px 0 14px" : "0 0 14px" }}>
                  Extras you asked for. Nothing is added — or billed — unless you say yes, and your booked
                  visits go ahead either way.
                </p>
                {addonsPending.map((a) => (
                  <AddonCard key={a.id} addon={a} />
                ))}
              </>
            )}

            {(decided.length > 0 || addonsDecided.length > 0) && (
              <>
                <h2 className="mut" style={{ fontSize: 14, fontWeight: 800, margin: pending.length > 0 || addonsPending.length > 0 ? "26px 0 12px" : "0 0 12px" }}>
                  Earlier
                </h2>
                {decided.map((f) => (
                  <ApprovalCard key={f.id} flag={f} />
                ))}
                {addonsDecided.map((a) => (
                  <AddonCard key={a.id} addon={a} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
