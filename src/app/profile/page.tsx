import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { NotificationToggles } from "@/components/NotificationToggles";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile } from "./data";
import { loadNotifStates } from "./notif-actions";

export default async function ProfilePage() {
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
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in to see your profile</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const [{ data: me }, profile, notifStates] = await Promise.all([
    supabase.from("users").select("name, email, phone").eq("id", user.id).maybeSingle(),
    getFullProfile(),
    loadNotifStates(),
  ]);

  // No property yet → invite them into the wizard.
  if (!profile?.hasProfile) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill gold">Next step</span>
            <h2 style={{ fontSize: 24, margin: "12px 0 6px" }}>Let&apos;s build your property profile</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
              Seven quick questions about your place — pier, lifts, boats, lawn — and every
              price becomes exact to your property.
            </p>
            <Link className="ll-btn gold" href="/profile/setup">Start guided setup →</Link>
          </div>
        </div>
      </>
    );
  }

  const facts: Array<[string, string, string]> = [
    ["House", `${profile.sqft.toLocaleString()} sq ft · ${profile.beds} bd / ${profile.baths} ba`, `Gate code ${profile.gate ?? "—"} · drives housekeeping pricing`],
    ["Pier", `${profile.pier_sections} sections`, `${[profile.ladder ? "Ladder" : "", profile.bumpers ? "bumpers" : ""].filter(Boolean).join(" + ") || "no extras"} · $48/section install & removal`],
    ["Boat lifts", `${profile.boat_lifts} lift${profile.boat_lifts === 1 ? "" : "s"}${profile.canopy ? " · canopy" : ""}`, "Set each spring, pulled each fall"],
    ["Toy / PWC lifts", `${profile.toy_lifts}`, `${profile.toys.length} toys stored: ${profile.toys.map((t) => t.name).join(" · ") || "none yet"}`],
    ["Boats", profile.boats.length ? profile.boats.map((b) => `${b.length_ft}' ${b.type}`).join(" · ") : "None on file", `Winterize & store at $50/ft, bow to stern — no repairs`],
    ["Lawn", `${profile.lawn_band[0].toUpperCase()}${profile.lawn_band.slice(1)}`, "Sets your weekly mow price"],
  ];

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 36 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: 26 }}>Property profile</h1>
            <p className="mut" style={{ fontSize: 14 }}>
              {profile.address ?? "Your place"}{profile.lake ? ` · ${profile.lake}` : ""}
            </p>
          </div>
          <Link className="ll-btn ghost" href="/profile/setup">Edit in guided setup</Link>
        </div>

        {/* contact on file */}
        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, marginBottom: 10 }}>Contact on file</h3>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14 }}>
            <div><div className="mut" style={{ fontSize: 12 }}>Name</div><b>{me?.name ?? "—"}</b></div>
            <div><div className="mut" style={{ fontSize: 12 }}>Email</div><b>{me?.email ?? user.email}</b></div>
            <div><div className="mut" style={{ fontSize: 12 }}>Mobile</div><b>{me?.phone ?? "—"}</b></div>
          </div>
        </div>

        {/* fact cards */}
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginBottom: 16 }}>
          {facts.map((x, i) => (
            <div key={i} className="ll-card ll-card-pad">
              <span className="ll-pill teal" style={{ marginBottom: 8 }}>{x[0]}</span>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, color: "var(--ink)" }}>{x[1]}</div>
              <div className="mut" style={{ fontSize: 12.5, marginTop: 4 }}>{x[2]}</div>
            </div>
          ))}
        </div>

        <div style={{ maxWidth: 620 }}>
          <NotificationToggles initial={notifStates} />
        </div>
      </div>
    </>
  );
}
