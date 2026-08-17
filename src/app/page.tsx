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
            {/* Copy set by Brendon, verbatim. The em dash in
                "complete—season after season" is closed up (no spaces) as
                specified; `.ll-eyebrow` and `.ll-pill` uppercase in CSS, so
                the strings below are written the way they render. */}
            <div className="ll-eyebrow">WELCOME TO LAKELIFE</div>
            <h1>Your LakeLife, Automated.</h1>
            <p>
              House, lawn, dock, lift, boat and toys. Choose what you need
              once. LakeLife automates scheduling and payments, keeps pricing
              clear, and provides photo proof when each job is
              complete&mdash;season after season.
            </p>
            <div className="ll-hero-chips">
              <span className="ll-chip">📍 <b>Lakefront or nearby — {lakeChips}</b></span>
              <span className="ll-chip">Home · housekeeping · lawn · seasonal</span>
              <span className="ll-chip">Boats · jet skis · docks · lifts · storage</span>
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
                  Welcome back&mdash;open my portal →
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
            {/* Copy set by Brendon, verbatim. `.ll-pill` uppercases in CSS;
                the labels are written uppercase so the source reads as the
                page does. Note the em dashes in the BODY strings are the
                character, not `&mdash;` — an entity in a string prop is not
                JSX text and would render literally. */}
            <FeatureCard
              pill="SET IT ONCE"
              title="Choose the services your LakeLife needs"
              body="Select the work once, and each job is automatically scheduled in the right season. Change or skip a service anytime."
            />
            <FeatureCard
              pill="SIMPLE FROM START TO FINISH"
              title="Pricing, scheduling and payments in one place"
              body="See the full price upfront, know when the work is scheduled, and handle payment through LakeLife."
            />
            <FeatureCard
              pill="PHOTO PROOF"
              title="See when every job is complete"
              body="Receive photos after each visit, so you know the work was completed—even when you aren’t there."
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
