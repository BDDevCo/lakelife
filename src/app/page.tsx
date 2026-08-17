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
            {/* WHAT WE DO, IN THE FIRST BREATH — and Brendon had to say it
                three times before I fixed the right thing.

                Two earlier versions circled the product. "Lake life, handled."
                describes a mood. "Your lake house, ready when you are" is a
                feeling, and the paragraph under it opened on the reader NOT
                BEING THERE — which excluded the full-timers and, worse, still
                never said what kind of company this is. A stranger could not
                tell a service business from a rental manager from software.

                THE CUSTOMER IS THE SEASONAL OWNER, deliberately. A full-timer
                mows their own lawn, has their own dock guy and is there to let
                anyone in; they buy one job a year. A seasonal owner buys the
                whole chain — spring open, dock and lift in, mowing all summer,
                cleaning before each visit, boat out, winterize, dock out, fall
                close. Eight or ten jobs. The page should be written for them.

                AND THE THING WE ACTUALLY DO FOR THEM WAS NOT ON THE PAGE AT
                ALL. Autopilot: turn a service on once, the all-in price locks
                at today's level, each season we propose it and one tap
                confirms or skips, skipping always free. That is a season
                arranged once — and the homepage was selling single bookings,
                which is the same product with the point removed.

                Deliberately channel-neutral: "we ask you first", never "we
                text you". No SMS this app has sent since 19 July has been
                delivered, and the front page must not promise a dead channel. */}
            <div className="ll-eyebrow">Welcome to LakeLife</div>
            <h1>Set your lake season once.</h1>
            <p>
              Dock and lift in for spring, mowing and cleaning all summer, boat
              winterized and the dock out before the freeze. Choose the jobs
              once — we schedule each one, hold the price, and send photos when
              it&apos;s done. Skip anything, any time, free.
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
              pill="Set it once"
              title="The season keeps itself"
              body="Turn on the jobs your place needs and each one comes round in its own season, fitted around the weather — dock in after the ice goes, mowing through the summer, everything out before the freeze. We ask before every visit, and skipping one is free."
            />
            <FeatureCard
              pill="No quotes to chase"
              title="One all-in price, and we hold it"
              body="The price you see is the whole price — crew, coordination and scheduling included. Turn a job on and that price is locked at today's level, so next spring costs what this spring did."
            />
            {/* "See it was done — WITHOUT DRIVING OUT" carried the same
                absence assumption as the old hero paragraph. The benefit
                survives without asserting where the reader lives: "even if you
                weren't there to watch" is an offer, not a premise. */}
            <FeatureCard
              pill="Proof, not promises"
              title="Photos of the actual work, every visit"
              body="Not a courtesy — a crew can't mark a job finished, or get paid, until the photos are in. So you know the dock really came out, even if you weren't there to watch."
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
