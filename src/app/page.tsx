import { TopBar, Waves } from "@/components/Brand";
import { GetStarted } from "@/components/GetStarted";
import { ConfigNotice } from "@/components/ConfigNotice";
import { hasSupabaseEnv, hasTwilioEnv } from "@/lib/env";

export default function Home() {
  const supaOk = hasSupabaseEnv();
  const twilioOk = hasTwilioEnv();

  return (
    <>
      <TopBar />
      <ConfigNotice missing={{ supabase: !supaOk, twilio: !twilioOk }} />

      <main>
        <section className="ll-hero">
          <div className="ll-hero-inner">
            <div className="ll-eyebrow">Welcome to LakeLife</div>
            <h1>Your lake house, on the water &amp; ready when you are.</h1>
            <p>
              One request, one price, one crew at your door. We coordinate every
              opening, closing, pier, lift, mow and clean on Big Long, Pretty &amp;
              Big Turkey Lakes — you just pick the dates.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 22 }}>
              <span className="ll-chip">📍 <b>Big Long · Pretty · Big Turkey</b></span>
              <span className="ll-chip">Seasonal opening &amp; closing</span>
              <span className="ll-chip">Piers · lifts · boats · mowing · housekeeping</span>
              <GetStarted configured={supaOk} />
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
              pill="One price"
              title="All-in, no surprises"
              body="You see a single price per service. We handle the crews, the coordination, and the schedule around each lake's season."
            />
            <FeatureCard
              pill="Season-aware"
              title="Built around ice-out &amp; freeze"
              body="Water work opens after ice-out and closes before the pull deadline — automatically, per lake, so nothing gets caught in the freeze."
            />
            <FeatureCard
              pill="Proof every time"
              title="Photos with every visit"
              body="Every completed job comes with photos texted to you — your pier, your lift, your house, done right."
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
