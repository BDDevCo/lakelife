import Link from "next/link";
import { TopBar, Waves } from "@/components/Brand";
import { GetStarted } from "@/components/GetStarted";
import { RefCatcher } from "@/components/RefCatcher";
import { ConfigNotice } from "@/components/ConfigNotice";
import { hasSupabaseEnv, hasTwilioEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { softRead } from "@/lib/must-read";

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
    // A FAILED READ IS NOT AN EMPTY LAKES TABLE — but here it is one of the
    // few places where the fallback is genuinely defensible, so the failure is
    // DEGRADED rather than fatal: the three founding lakes below are real
    // markets, the sentence they build is incomplete rather than untrue, and
    // 500ing the front door over a marketing chip would cost a new customer
    // more than a short list does. What was missing was any trace at all —
    // softRead logs it. The flag is deliberately not rendered: there is no
    // honest sentence to add to a hero chip, and the lake a visitor can't find
    // here they can still name themselves at booking (lib/lake-birth.ts).
    const [lakeRows] = softRead(
      "the list of lakes for the front door",
      await supabase.from("lakes").select("name").eq("is_fixture", false).order("name"),
      null,
    );
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

        {/* THE LEGAL PAGES HAVE TO BE FINDABLE FROM THE FRONT DOOR.
            /terms was reachable only from inside an acceptance modal, and
            /privacy did not exist. A2P campaign vetting checks for a public,
            unauthenticated privacy policy and messaging-terms page, and a
            crawler that cannot reach them is the same as not having them. */}
        <footer
          style={{
            borderTop: "1px solid var(--line)", marginTop: 40, paddingTop: 18,
            display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center",
            fontSize: 13,
          }}
          className="mut"
        >
          <span>© {new Date().getFullYear()} LakeLife AI</span>
          <Link href="/privacy">Privacy</Link>
          <Link href="/sms">Text messages</Link>
          <Link href="/terms">Terms</Link>
          <a href="mailto:hello@lakelife.ai">hello@lakelife.ai</a>
        </footer>
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
