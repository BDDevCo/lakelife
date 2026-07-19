import Link from "next/link";
import { redirect } from "next/navigation";
import { TopBar, Waves } from "@/components/Brand";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { SignOutButton } from "@/components/SignOutButton";
import { listProperties } from "@/app/profile/data";

export default async function WelcomePage() {
  let name = "there";
  let emailVerified = false;
  let phoneVerified = false;
  let email = "";

  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // A customer who already has a property doesn't need onboarding —
      // send them straight to the portal.
      const properties = await listProperties();
      if (properties.length > 0) redirect("/book");

      email = user.email ?? "";
      const { data: profile } = await supabase
        .from("users")
        .select("name, email_verified, phone_verified")
        .eq("id", user.id)
        .maybeSingle();
      name = profile?.name || (user.user_metadata?.full_name as string) || "there";
      // The Supabase auth record is the source of truth for email confirmation;
      // the profile flag is just a synced convenience.
      emailVerified = Boolean(user.email_confirmed_at) || (profile?.email_verified ?? false);
      phoneVerified = profile?.phone_verified ?? false;
    }
  }

  const readyToBook = emailVerified && phoneVerified;

  return (
    <>
      <TopBar />
      <section className="ll-hero">
        <div className="ll-hero-inner">
          <div className="ll-eyebrow">You&apos;re in</div>
          <h1>Welcome to LakeLife, {name}.</h1>
          <p>
            Your account is set up. Next, let&apos;s build your property profile so we can
            price every service exact to your place.
          </p>
          <div style={{ marginTop: 20 }}>
            <Link
              className="ll-btn gold"
              href="/profile/setup"
              style={{ textDecoration: "none" }}
            >
              Set up my property →
            </Link>
          </div>
        </div>
        <Waves />
      </section>

      <div className="wrap" style={{ paddingTop: 36, maxWidth: 640 }}>
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 18, marginBottom: 14 }}>Account checklist</h3>
          <CheckRow ok={true} label="Account created" />
          <CheckRow
            ok={emailVerified}
            label={
              emailVerified
                ? `Email verified${email ? ` — ${email}` : ""}`
                : "Email on file — confirm the link we emailed to finish"
            }
          />
          <CheckRow ok={phoneVerified} label="Mobile verified by text" />

          <div
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: "1px solid var(--line)",
            }}
          >
            {readyToBook ? (
              <span className="ll-pill ok">Ready to book — both checks complete</span>
            ) : (
              <span className="ll-pill warn">
                Booking unlocks once email &amp; mobile are both verified
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Link className="ll-btn" href="/profile/setup">
              Set up my property →
            </Link>
            <SignOutButton />
          </div>
        </div>
      </div>
    </>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
      <span
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          borderRadius: 99,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: ok ? "#e4f2ea" : "#f0f3f4",
          color: ok ? "var(--ok)" : "var(--sub)",
          fontWeight: 800,
          fontSize: 13,
        }}
      >
        {ok ? "✓" : "•"}
      </span>
      <span style={{ fontSize: 14.5 }}>{label}</span>
    </div>
  );
}
