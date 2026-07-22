import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { AccountControls } from "@/components/AccountControls";
import { PaymentMethods } from "@/components/PaymentMethods";
import { OwnerHeader } from "@/components/OwnerHeader";
import { NicknameEditor } from "@/components/NicknameEditor";
import { listPaymentMethods } from "./payment-actions";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getFullProfile } from "./data";

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

  const [{ data: me }, profile, cards] = await Promise.all([
    supabase.from("users").select("name, email, phone").eq("id", user.id).maybeSingle(),
    getFullProfile(),
    listPaymentMethods(),
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
              Pick the services that fit your place — housekeeping, mowing, seasonal
              open &amp; close, and waterfront work if you have it — and every price
              becomes exact to your property.
            </p>
            <Link className="ll-btn gold" href="/profile/setup">Start guided setup →</Link>
          </div>
          <div style={{ maxWidth: 520, margin: "16px auto 0" }}>
            <AccountControls hasProperty={false} />
          </div>
        </div>
      </>
    );
  }

  // The nickname lives on the properties row; getFullProfile doesn't carry it,
  // so read it here (page-local — shared data functions stay untouched).
  let nickname: string | null = null;
  if (profile.propertyId) {
    const { data: prop } = await supabase
      .from("properties")
      .select("nickname")
      .eq("id", profile.propertyId)
      .maybeSingle();
    nickname = (prop as { nickname?: string | null } | null)?.nickname ?? null;
  }

  // Only show the fact cards that match what this customer selected, so a
  // near-the-lake home doesn't get an empty "Pier: 0 sections" card.
  const wants = (name: string) => profile.wanted_services.includes(name);
  const facts: Array<[string, string, string]> = [];
  if (wants("Housekeeping")) {
    facts.push(["House", `${profile.sqft.toLocaleString()} sq ft · ${profile.beds} bd / ${profile.baths} ba`, "Drives your housekeeping pricing"]);
  }
  if (wants("Lawn mowing & trim")) {
    facts.push(["Lawn", `${profile.lawn_band[0].toUpperCase()}${profile.lawn_band.slice(1)}`, "Sets your weekly mow price"]);
  }
  if (wants("Pier install / removal")) {
    facts.push(["Pier", `${profile.pier_sections} sections`, `${[profile.ladder ? "Ladder" : "", profile.bumpers ? "bumpers" : ""].filter(Boolean).join(" + ") || "no extras"} · priced per section`]);
  }
  if (wants("Boat lift set / pull")) {
    facts.push(["Boat lifts", `${profile.boat_lifts} lift${profile.boat_lifts === 1 ? "" : "s"}${profile.canopy ? " · canopy" : ""}`, "Set each spring, pulled each fall"]);
  }
  if (wants("Boat storage & winterize")) {
    facts.push(["Boats", profile.boats.length ? profile.boats.map((b) => {
      const eng = b.engine_type && b.engine_type !== "none"
        ? ` · ${(b.engines ?? 1) > 1 ? `twin ` : ""}${b.engine_hp ? `${b.engine_hp}hp ` : ""}${b.engine_type}`
        : b.engine_type === "none" ? " · no engine" : "";
      return `${b.length_ft}' ${b.type}${eng}`;
    }).join(" · ") : "None on file", "Winterized & stored by the foot — no repairs"]);
  }
  if (wants("Jet ski winterize & store") || wants("PWC lift set / pull")) {
    facts.push(["Jet skis / PWC", `${profile.jet_skis} jet ski${profile.jet_skis === 1 ? "" : "s"} · ${profile.pwc_lifts} lift${profile.pwc_lifts === 1 ? "" : "s"}`, "Stored and set/pulled each season"]);
  }
  if (wants("Water toy prep & storage")) {
    facts.push(["Water toys", `${profile.toys.length} stored`, profile.toys.map((t) => t.name).join(" · ") || "none yet"]);
  }
  if (profile.gate) {
    facts.push(["Access", `Gate code on file`, "Encrypted · shown to a crew only on a job day"]);
  }

  return (
    <>
      <TopBar />
      <OwnerHeader />
      <div className="wrap" style={{ paddingTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: 26 }}>Property profile</h1>
            <p className="mut" style={{ fontSize: 14 }}>
              {profile.address ?? "Your place"}{profile.lake ? ` · ${profile.lake}` : ""}
            </p>
            {profile.propertyId && (
              <div style={{ marginTop: 6 }}>
                <NicknameEditor propertyId={profile.propertyId} nickname={nickname} />
              </div>
            )}
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

        {/* services chosen */}
        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, marginBottom: 10 }}>Services you&apos;re set up for</h3>
          {profile.wanted_services.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {profile.wanted_services.map((s) => (
                <span key={s} className="ll-pill teal">{s}</span>
              ))}
            </div>
          ) : (
            <p className="mut" style={{ fontSize: 13 }}>
              None chosen yet — <Link href="/profile/setup" style={{ color: "var(--teal-dark)", fontWeight: 700 }}>pick your services</Link>.
            </p>
          )}
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

        <div style={{ maxWidth: 620, display: "grid", gap: 16 }}>
          <PaymentMethods initial={cards} />
          <Link href="/settings/notifications" className="ll-card ll-card-pad" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Notification settings →</div>
            <div className="mut" style={{ fontSize: 13 }}>Choose text or email for each kind of update. Receipts are always on.</div>
          </Link>
          <AccountControls
            hasProperty={true}
            propertyLabel={profile.address ?? undefined}
            propertyId={profile.propertyId}
          />
        </div>
      </div>
    </>
  );
}
