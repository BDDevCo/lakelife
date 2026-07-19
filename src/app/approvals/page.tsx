import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { OwnerHeader } from "@/components/OwnerHeader";
import { ApprovalCard } from "@/components/ApprovalCard";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getOwnerFlags } from "./data";

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

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, marginBottom: 16 }}>Messages &amp; approvals</h1>

        {flags.length === 0 ? (
          <div className="ll-card ll-card-pad">
            <p style={{ fontSize: 15, margin: 0 }}>
              No approvals waiting. When a crew spots something that differs from your profile,
              it&apos;ll show up here for your OK.
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

            {decided.length > 0 && (
              <>
                <h2 className="mut" style={{ fontSize: 14, fontWeight: 800, margin: pending.length > 0 ? "26px 0 12px" : "0 0 12px" }}>
                  Earlier
                </h2>
                {decided.map((f) => (
                  <ApprovalCard key={f.id} flag={f} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
