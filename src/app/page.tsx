import Link from "next/link";
import { TopBar, Waves } from "@/components/Brand";
import { GetStarted } from "@/components/GetStarted";
import { RefCatcher } from "@/components/RefCatcher";
import { ConfigNotice } from "@/components/ConfigNotice";
import { hasSupabaseEnv, hasTwilioEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supaOk = hasSupabaseEnv();
  const twilioOk = hasTwilioEnv();

  // A signed-in customer gets a shortcut into their portal, not a signup pitch.
  let signedIn = false;
  // The lake list is DYNAMIC (new lakes row = new copy, zero code changes);
  // the founding three stay as the env-less fallback so the page never
  // renders empty. zz-% test lakes excluded, same rule as /lakes.
  let shortNames = ["Big Long", "Pretty", "Big Turkey"];
  if (supaOk) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = !!user;
    const { data: lakeRows } = await supabase
      .from("lakes").select("name").not("name", "ilike", "zz-%").order("name");
    if (lakeRows && lakeRows.length > 0) {
      shortNames = lakeRows.map((l) => (l.name as string).replace(/ Lake$/, ""));
    }
  }
  const lakeSentence = shortNames.length > 1
    ? `${shortNames.slice(0, -1).join(", ")} & ${shortNames[shortNames.length - 1]}`
    : shortNames[0] ?? "";
  const lakeChips = shortNames.join(" · ");

  return (
    <>
      <RefCatcher />
      <TopBar />
      <ConfigNotice missing={{ supabase: !supaOk, twilio: !twilioOk }} />

      <main>
        <section className="ll-hero">
          <div className="ll-hero-inner">
            <div className="ll-eyebrow">Welcome to LakeLife</div>
            <h1>Lake life, handled.</h1>
            <p>
              Your house, boat &amp; toys — dialed in every season. One request, one
              price, one crew at your door. Opening &amp; closing, cleaning, mowing,
              piers &amp; lifts, winterize &amp; storage. Lakefront or a few blocks off,
              around {lakeSentence} Lakes.
            </p>
            <div className="ll-hero-chips">
              <span className="ll-chip">📍 <b>Lakefront or near it — {lakeChips}</b></span>
              <span className="ll-chip">Home · housekeeping · lawn &amp; seasonal</span>
              <span className="ll-chip">Boats · jet skis · piers · lifts · storage</span>
              {signedIn ? (
                <Link
                  className="ll-chip"
                  href="/portal"
                  style={{
                    cursor: "pointer",
                    background: "var(--sun)",
                    color: "var(--ink)",
                    borderColor: "var(--sun)",
                    fontWeight: 800,
                    textDecoration: "none",
                  }}
                >
                  Welcome back — open my portal →
                </Link>
              ) : (
                <GetStarted configured={supaOk} />
              )}
            </div>
          </div>
          <Waves />
        </section>

        <section className="wrap" style={{ paddingTop: 40 }}>
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            <FeatureCard
              pill="Pick what fits"
              title="Only the services you want"
              body="On the water or a few blocks off it, you choose the services that fit your place — housekeeping, mowing, seasonal open & close, and waterfront work if you have it."
            />
            <FeatureCard
              pill="Season-aware"
              title="Built around ice-out &amp; freeze"
              body="Waterfront work opens after ice-out and closes before the pull deadline — automatically, per lake, so nothing gets caught in the freeze."
            />
            <FeatureCard
              pill="Proof every time"
              title="Photos with every visit"
              body="Every completed job comes with photos texted to you — your house, your lawn, your pier, done right."
            />
          </div>
        </section>
      </main>
    </>
  );
}

function FeatureCard({
  pill,
  title,
  body,
}: {
  pill: string;
  title: string;
  body: string;
}) {
  return (
    <div className="ll-card ll-card-pad">
      <span className="ll-pill gold" style={{ marginBottom: 10 }}>
        {pill}
      </span>
      <h3 style={{ fontSize: 18, margin: "10px 0 6px" }}>{title}</h3>
      <p className="mut" style={{ fontSize: 14 }}>
        {body}
      </p>
    </div>
  );
}
