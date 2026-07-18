import Link from "next/link";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/Brand";
import { VerifyPanel } from "@/components/VerifyPanel";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";

export default async function VerifyPage() {
  if (!hasSupabaseEnv()) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad">
            Add your Supabase keys to <code>.env.local</code> first, then restart the app.
          </div>
        </div>
      </>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>
              You&apos;re not signed in yet
            </h3>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              Create your profile (or confirm the link we emailed you), then come back
              to verify your mobile.
            </p>
            <Link className="ll-btn" href="/">
              Back to start
            </Link>
          </div>
        </div>
      </>
    );
  }

  // Already verified? Skip ahead.
  const { data: profile } = await supabase
    .from("users")
    .select("phone_verified, phone")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.phone_verified) {
    redirect("/welcome");
  }

  const initialPhone =
    (user.user_metadata?.phone as string | undefined) || profile?.phone || undefined;

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 440 }}>
        <VerifyPanel initialPhone={initialPhone} />
      </div>
    </>
  );
}
