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
  // renders empty. Fixtures excluded by lakes.is_fixture — the column, not the
  // name (0124); this list is the one a scratch lake actually reached.
  let shortNames = ["Big Long", "Pretty", "Big Turkey"];
  if (supaOk) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = !!user;
    const { data: lakeRows } = await supabase
      .from("lakes").select("name").eq("is_fixture", false).order("name");
    if (lakeRows && lakeRows.length > 0) {
      shortNames = lakeRows.map((l) => (l.name as string).replace(/ Lake$/, ""));
    }
  }
  // The prose sentence went with the locale line it built — the chip below the
  // paragraph carries the lake names now, and once was enough.
  const lakeChips = shortNames.join(" · ");

  return (
    <>
      <RefCatcher />
      <TopBar />
      <ConfigNotice missing={{ supabase: !supaOk, twilio: !twilioOk }} />

      <main>
        <section className="ll-hero">
          <div className="ll-hero-inner">
            {/* THE PROTOTYPE'S OWN LINE, PUT BACK.
                lakelife.html's <title> is "LakeLife — Your lake house, ready
                when you are." This page had drifted to "Lake life, handled." —
                a nice phrase that describes a mood rather than a promise, and
                then spent its paragraph listing services.

                The gap was that nothing named the SITUATION. Everyone landing
                here owns a place they are not standing in. Until the copy says
                that, every feature below it reads as a menu from a company
                that could be anywhere. */}
            <div className="ll-eyebrow">Welcome to LakeLife</div>
            <h1>Your lake house, ready when you are.</h1>
            {/* THREE SENTENCES, and no locale — the chip immediately below
                already says "Lakefront or near it — Big Long · Big Turkey ·
                Pretty". Saying it twice cost two lines of an eight-line
                paragraph on a 375px screen, which is the whole hero before
                the reader reaches anything they can tap. */}
            <p>
              You&apos;re not there most of the time — but the lawn still grows and
              the dock still has to come out before the freeze. Pick your
              services and your dates; we send the crew, and you get the
              photos. Every price all-in.
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
            {/* THREE CARDS THAT SAY WHAT CHANGES FOR HIM, not what we built.
                All three used to be written from the inside:

                "Only the services you want" — a menu. Every contractor in
                Indiana says this.
                "Built around ice-out & freeze" — our scheduler's cleverest
                trick, described in our own vocabulary. A stranger does not
                know what a pull deadline is, and "ice-out" is jargon even
                locally. The behaviour is real and worth keeping; it belongs
                inside "we fit it around the weather", where it is a relief
                rather than a feature.
                "Photos with every visit" — an artifact, not a benefit. It
                never answered the only question a photo answers: did it
                actually happen, and do I have to drive out to find out. */}
            <FeatureCard
              pill="You're in charge"
              title="Pick the services and the dates"
              body="You decide what gets done and when — a mow every two weeks, a clean before the family arrives, the pier out before the freeze. One request each time; we find the crew, fit it around the weather, and turn up. No calling four contractors and hoping."
            />
            <FeatureCard
              pill="No quotes to chase"
              title="One all-in price, before you book"
              body="The price you see is the whole price — crew, coordination and scheduling included. You approve it before anything is scheduled, and it doesn't grow afterwards."
            />
            <FeatureCard
              pill="Proof, not promises"
              title="See it was done — without driving out"
              body="Every visit ends with photos of the actual work, sent to you. And it isn't a courtesy: a crew can't mark a job finished, or get paid, until the photos are in."
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
