import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/Brand";
import { RefCatcher } from "@/components/RefCatcher";
import { createServiceClient } from "@/lib/supabase/server";
import { OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "@/lib/lake-pages";
import { effectiveSeason, seasonIsProvisional, todayLakeDate } from "@/lib/booking";
import { mustRead, mustCount } from "@/lib/must-read";
import { checkNamedInsured } from "@/lib/named-insured";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

/**
 * Public per-lake landing page (§8 SEO) — every number on it is LIVE
 * platform data, never marketing fiction: real crew counts, real
 * completions and thumbs, real season dates, and (when an HOA
 * partnership is linked) the real fireworks-fund total. RefCatcher rides
 * along so a shared lake link attributes referrals exactly like the
 * front door.
 *
 * AND AS OF THIS COMMIT IT QUOTES NO PRICE AT ALL — see the services card
 * below. The twelve figures this page used to print were the last public
 * survivors of the mockup: `lakelife.html` priced a pier at $700 and
 * repriced ten sections to twelve at $796, which is $220 + $48/section
 * exactly, and 0047 seeded those two terms into `services` with no source
 * note while two neighbours in the same INSERT were annotated
 * "(PLACEHOLDER rate)". The only pier number anybody has ever been
 * charged is The Haven's $1,680 a season over 28 sections — $60 a
 * section — against a menu that came to $3,128 a season for the same
 * dock. No crew has agreed to any of it, because no crew has been
 * onboarded. So the page keeps the admission it already makes in its own
 * headline ("we're building our crew bench on this lake") and drops the
 * figures that contradicted it.
 */

export const revalidate = 3600; // ISR — fresh hourly, fast always

interface LakeRow {
  id: string;
  name: string;
  slug: string;
  ice_out_actual: string | null;
  pull_deadline: string | null;
  /** Defaults TRUE (0044). False only on a lake born from "my lake isn't listed". */
  season_confirmed: boolean | null;
  hoa_user_id: string | null;
  hoa_name: string | null;
}

async function loadLake(slug: string): Promise<LakeRow | null> {
  const admin = createServiceClient();
  // A FAILED READ IS NOT AN UNKNOWN LAKE. The `null` branch below 404s to
  // not-found.tsx — "We don't serve that lake yet", a sentence that tells
  // somebody standing on their own dock we don't work their water, and that a
  // search engine will happily cache. It has to mean the row is genuinely
  // absent (or fenced, per the note inside), so a read that could not run
  // throws instead.
  const data = mustRead(`the ${slug} lake page`, await admin
    .from("lakes")
    .select("id, name, slug, ice_out_actual, pull_deadline, season_confirmed, hoa_user_id, hoa_name")
    .eq("slug", slug)
    // A LAKE WE HAVE NOT AGREED TO SERVE IS A 404 TO THE WORLD, exactly as a
    // fixture has been since 0124 — one predicate now covers both
    // (lib/lake-visibility.ts).
    //
    // 0124 closed this route to scratch rows and nobody noticed the other half
    // was still open: a lake a customer named in the set-up wizard is
    // `is_fixture = false`, so it rendered a FULL landing page here — season
    // dates, a crew count, and a priced menu of work no crew has agreed to do
    // on that water — with its own SEO title and description, to anyone who
    // typed or was linked the slug.
    //
    // WHY 404 AND NOT A SOFT "we don't serve this lake yet" PAGE. This route
    // is ISR-cached for an hour, is declared in the sitemap and is indexed. A
    // 200 with an apologetic sentence is still a URL a crawler keeps, ranks
    // and serves against the lake's name — the page would go on existing in
    // search results long after anybody read it. A 404 is the one answer that
    // gets the URL dropped. The reader still gets the branded card and a way
    // back: not-found.tsx beside this file carries the same words it always
    // did, now with the status code that matches them. The day ops promotes
    // the lake the same URL is a real page again.
    .match(SERVED_LAKE_MATCH)
    .maybeSingle());
  return (data as LakeRow | null) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  // The page below throws to the error boundary; metadata must not, or the
  // throw escapes where no boundary is listening. A bare tab title is the same
  // thing this already renders when the lake is genuinely unknown, and it
  // asserts nothing about the lake either way.
  const lake = await loadLake(slug).catch(() => null);
  if (!lake) return { title: "LakeLife" };
  return {
    title: `Lake-home services on ${lake.name} — piers, boats, lawn & housekeeping | LakeLife`,
    // "ONE PRICE, ONE TEXT, DONE" NAMED A CHANNEL THAT HAS NEVER DELIVERED.
    // Zero of the 81 texts this app has sent since July reached anybody, and
    // the search result for this lake said otherwise in nine words. What is
    // left is the part that is true whoever carries the message: one price,
    // photographs, and no charge before the work is finished.
    description: `One all-in price, photo-verified, never charged until it's done — pier install & removal, boat lifts, winterization, lawn care and housekeeping on ${lake.name}, Indiana.`,
  };
}

const pretty = (iso: string | null) =>
  iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;

export default async function LakePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lake = await loadLake(slug);
  // The same words as before, moved into not-found.tsx so they arrive with a
  // 404 rather than a 200 — see the note inside loadLake.
  if (!lake) notFound();

  const admin = createServiceClient();
  // EVERY NUMBER BELOW IS A CLAIM ABOUT THIS LAKE, and each empty branch was
  // written for a lake that genuinely has none yet: no crews reads as "We're
  // building our crew bench on {lake}", no jobs as "0 jobs completed", no
  // earnings as "$0.00 raised so far · Be the first." to an association that
  // has raised real money. Public page, so the reader has no portal to check
  // any of it against. The page fails to the error boundary rather than
  // publish a number it could not read.
  const [servicesRes, crewsRes, completedRes, thumbsRes, hoaRes] = await Promise.all([
    // A LAKE HOUSE'S MENU, the same fence the booking menu uses for one
    // (profile/data.ts: `.eq("park_only", false)`). A park_only service —
    // common-area cleanup, park grounds mowing, road snow — is not
    // bookable by anyone reading this page; it is invisible here today only
    // because 0115 zeroed its global price, which is an accident, not a
    // fence. The day one of those carries a global number it would advertise
    // itself to lake homeowners who cannot buy it.
    //
    // THE PRICING COLUMNS ARE GONE FROM THIS SELECT ON PURPOSE, and that is
    // the fence rather than the tidy-up: `base`, `unit_rate` and
    // `band_pricing` are the three inputs a "from $X" line is built out of,
    // so a future edit cannot reinstate one without first re-adding the
    // column and meeting this note. `crew_priced` (0174) stays, because the
    // sentence under the list still has to say who names the price.
    admin.from("services").select("id, name, is_water_work, crew_priced").eq("active", true).eq("park_only", false).or("kind.eq.standalone,solo_bookable.eq.true").order("name"),
    // FIXTURE CREWS ARE NOT A CREW BENCH. This is a public, SEO-indexed page
    // that prints "N insured local crews serving <lake>". Two of the three
    // vendors are the owner's own scratch accounts, so every lake advertised
    // two crews to the world while the routing pool for those lakes is
    // deliberately empty — a number no booking could cash. Derived from the
    // owner (0126), same as the router: see dispatch.ts.
    admin.from("vendors").select("id, coi_expiry, coi_named_insured, company, service_lakes, users!vendors_user_id_fkey!inner(is_fixture)").eq("status", "active").eq("users.is_fixture", false).contains("service_lakes", [lake.id]),
    // FIXTURE JOBS ARE NOT COMPLETED WORK — the same hole the crew count
    // above was patched for, left open one line below it. Every completed
    // job in production belongs to the owner's own scratch homeowner and was
    // done by his own scratch crew; the sentence is hidden today only
    // because crewCount is 0, so the day a real crew lists a lake this page
    // would have printed "3 jobs completed" that never happened. A job is a
    // fixture because its PROPERTY'S OWNER is (OWNER_FIXTURE_EMBED) — the
    // same derivation, never a second way of deciding it.
    admin.from("jobs").select(`id, properties!inner(lake_id, ${OWNER_FIXTURE_EMBED})`, { count: "exact", head: true }).eq("properties.lake_id", lake.id).eq(OWNER_FIXTURE_FILTER, false).in("status", ["complete", "paid"]),
    // Its twin: a thumbs-up on a fixture job is a fixture thumb, and it
    // prints in the same sentence.
    admin.from("job_confirmations").select(`verdict, properties!inner(lake_id, ${OWNER_FIXTURE_EMBED})`).eq("properties.lake_id", lake.id).eq(OWNER_FIXTURE_FILTER, false).eq("verdict", "good"),
    lake.hoa_user_id
      ? admin.from("referral_earnings").select("amount").eq("beneficiary", lake.hoa_user_id).neq("status", "void")
      : Promise.resolve({ data: null, error: null }),
  ]);
  const services = mustRead("the menu for this lake", servicesRes);
  const crews = mustRead("the crews serving this lake", crewsRes);
  const completedCount = mustCount("the jobs completed on this lake", completedRes);
  const thumbs = mustRead("the neighbours' thumbs for this lake", thumbsRes);
  const hoaEarnings = mustRead("the association fund total", hoaRes);

  const today = new Date().toISOString().slice(0, 10);
  // "INSURED" HAS TO MEAN WHAT THE ROUTER MEANS BY IT. dispatch.ts refuses a
  // crew whose certificate names a business other than theirs (0152), so a
  // crew counted here on an unexpired date alone could be advertised to the
  // public as insured while no booking could ever reach them. Same helper,
  // same grandfathering of a null: never a second reading of the same rule.
  const insured = (v: { coi_expiry?: unknown; coi_named_insured?: unknown; company?: unknown }) =>
    v.coi_expiry != null && String(v.coi_expiry) >= today &&
    (v.coi_named_insured == null || checkNamedInsured(v.coi_named_insured as string, (v.company as string | null) ?? null).ok);
  const crewCount = (crews ?? []).filter(insured).length;
  const thumbCount = (thumbs ?? []).length;
  const hoaTotal = (hoaEarnings ?? []).reduce((s, e) => s + Number(e.amount ?? 0), 0);
  const iceOut = pretty(lake.ice_out_actual);
  const pullBy = pretty(lake.pull_deadline);
  // A PUBLIC, SEO-INDEXED, HOURLY-CACHED PAGE STATING A GUESS AS A FACT.
  //
  // `pretty` drops the year, so a date rolled from last season prints as this
  // season's deadline and reads exactly like a measured one. Nobody typing
  // this lake's name into a search engine has any way to tell. The same two
  // signals the booking grid uses decide it here.
  const seasonProvisional = seasonIsProvisional(
    effectiveSeason(
      { iceOut: (lake.ice_out_actual as string) ?? null, pullDeadline: (lake.pull_deadline as string) ?? null },
      todayLakeDate(),
    ),
    lake.season_confirmed ?? undefined,
  );

  return (
    <>
      <RefCatcher />
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 760 }}>
        <div className="ll-eyebrow">LakeLife on the water</div>
        <h1 style={{ fontSize: 32, margin: "6px 0 8px" }}>Lake-home services on {lake.name}, handled.</h1>
        <p className="mut" style={{ fontSize: 15.5, marginBottom: 8 }}>
          Piers in and out on time, boats winterized before the freeze, lawns cut while you&apos;re away —
          one all-in price, booked from your phone, photo-verified when it&apos;s done. You&apos;re never
          charged until the work is complete.
        </p>
        <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 18 }}>
          {crewCount > 0
            ? `${crewCount} insured local crew${crewCount === 1 ? "" : "s"} serving ${lake.name} · ${completedCount ?? 0} jobs completed${thumbCount > 0 ? ` · ${thumbCount} 👍 from neighbors` : ""}`
            : `We're building our crew bench on ${lake.name} — book anyway; we hunt the crew down and you pay nothing until it's done.`}
        </p>
        {/* "IT TAKES 2 MINUTES" WAS A MEASUREMENT NOBODY EVER TOOK. The set-up
            wizard asks for an address, a pier, boats, a lawn and a mobile
            number it makes you verify by code; how long that takes depends
            entirely on how much is on the property, and no clock in this
            codebase has ever timed it. It is the one number on this page that
            came from nowhere. The lake's name is a fact, and it is a better
            button anyway. */}
        <Link className="ll-btn gold" href="/" style={{ minHeight: 48, display: "inline-flex", alignItems: "center", padding: "0 22px", marginBottom: 24 }}>
          Get set up on {lake.name} 🌊
        </Link>

        {(iceOut || pullBy) && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>{lake.name} season</h3>
            <p className="mut" style={{ fontSize: 14, margin: 0 }}>
              {iceOut ? `Ice-out: ${iceOut}${seasonProvisional ? " (estimated)" : ""}. ` : ""}
              {pullBy
                ? seasonProvisional
                  ? `We expect everything out of the water by ${pullBy} — an estimate until this year's ice-out is measured, with an 8-day buffer before the hard freeze built in. Book your fall pull early and we'll confirm the day with you.`
                  : `Everything out of the water by ${pullBy} — we build in an 8-day buffer before the hard freeze, so book your fall pull early.`
                : ""}
            </p>
          </div>
        )}

        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          {/* NO FIGURES HERE. The heading used to read "Services & pricing on
              {lake}" over twelve numbers, and the card's own footer promised
              "No quotes, no callbacks, no surprises" — a sentence that did not
              merely fail to hedge, it foreclosed the quoting model the owner
              has since chosen. The headline above it already told the same
              reader we are still building a crew bench on this lake.
              A page cannot admit it has no crew and quote that crew's price in
              one breath; the admission is the true half, so it stays and the
              numbers go. See the file header for where the numbers came from.

              A SERVICE STILL APPEARS. Vanishing silently is its own defect and
              the worse one — a stranger who owns a pier should be able to read
              that we arrange pier work on their water. Naming the work is a
              claim this product can cash; naming its price is not. */}
          <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>Services on {lake.name}</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {(services ?? []).map((s) => (
              <div key={s.id as string} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700 }}>
                  {s.name as string}
                  {s.is_water_work ? <span className="ll-pill teal" style={{ marginLeft: 8, fontSize: 11 }}>seasonal</span> : null}
                </span>
              </div>
            ))}
          </div>
          {/* WHAT REPLACED THE PROMISE. Every clause is something the product
              does today: crews are genuinely being onboarded on this lake (the
              headline above says so off the same read); `priceService` really
              does compute from the pier sections, boats and lawn on the
              profile rather than off a flat list; `crew_priced` (0174) really
              does hand the number to the crew who takes the job; and no charge
              path runs before a job is complete with its photographs in.

              It does NOT say a price shows before you commit, and that
              omission is deliberate — on a crew-priced service the booking
              door writes `customer_price` NULL, dispatches, and takes the
              number from the crew's decision afterwards (book/actions.ts). The
              old sentence claimed the opposite for every service on the
              list. */}
          <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.6 }}>
            We&apos;re onboarding crews on {lake.name} now. Tell us about your place — pier
            sections, boats, lawn — and we price the work to what&apos;s actually there,
            not off a flat list.{" "}
            {(services ?? []).some((s) => (s as { crew_priced?: boolean | null }).crew_priced === true)
              ? "Some of these are quoted by the crew who takes the job rather than by us. "
              : ""}
            No obligation, and nothing is charged until the work is done.
          </p>
        </div>

        {lake.hoa_user_id && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16, borderColor: "var(--gold)" }}>
            <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>🎆 The {lake.hoa_name ?? `${lake.name} Association`} fund</h3>
            <p style={{ fontSize: 20, fontWeight: 800, color: "var(--teal-dark)", margin: "0 0 4px" }}>
              ${hoaTotal.toFixed(2)} raised so far
            </p>
            <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
              Neighbors who join through the association&apos;s link fund the lake — fireworks, cleanups,
              whatever {lake.name} needs. {hoaTotal <= 0 ? "Be the first." : "Keep it going."}{" "}
              <Link href="/referral-terms#hoa" style={{ color: "inherit" }}>How the fund works</Link>
            </p>
          </div>
        )}

        {/* FOUR CLAIMS, AND THREE OF THEM WERE NOT TRUE OF THIS PRODUCT.

            "You get a text when it's done, with photos" was two errors in one
            clause. Zero of the 81 texts sent since July were delivered — the
            A2P campaign is approved now, but approval is not delivery and
            nothing has arrived yet — and no completion message has ever
            carried a photograph: it carries a COUNT and a LINK to the job
            page (vendor/actions.ts). So this names no channel at all. A
            sentence about the mechanism — photographs, then done, then the
            job page — is true today, stays true the week texts start
            landing, and never has to be rewritten again. The class is closed
            now: the day-before reminder body ended with the same two errors
            in the other phrasing — "We'll text you when it's done, with
            photos" — and has been corrected at its source (automation.ts),
            which is why /sms quotes that body whole again instead of
            stopping early. Both phrasings are deliberately left standing in
            this comment: the scanner's proof that comment-stripping is
            load-bearing reads THIS page for them, so a tidy-up that deletes
            the quoted strings turns a real test into a vacuous one.

            "A vetted, insured local crew gets routed automatically" was the
            paragraph disagreeing with its own page: eight lines up, the
            headline tells the same reader we are still building the crew
            bench on this lake, because there is no non-fixture crew on any
            water we serve. And "vetted" is a word with no referent here: the
            hard gate in dispatch.ts is one thing only — an unexpired
            certificate of insurance, "no COI, no jobs" — with the name on it
            checked when it is present (0152) and grandfathered when it is
            not. So the copy says that one thing, and says it as a rule we
            hold a crew to rather than as a crew who is standing by.

            "Payment only happens after the photos are in" is structurally
            true — settleJob will not run before a job is complete — but it
            implies a card is charged, and today every charge path declines
            `no_processor` (charge-gate.ts). "Nothing is charged before then"
            says the protective half, which is the half a stranger cares
            about, and it is true both before and after a processor exists. */}
        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>How it works</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            Tell us about your place once — pier sections, boats, lawn. What we can price from that,
            we price to your property; the rest is quoted by the crew who takes the job, and you see
            that number on your job page. Book a day and we go and line up an independent local crew — nobody is sent to
            your property without a current certificate of insurance on file. The crew photographs
            the work, and no job counts as done until the photos are in; they go on your job page
            and we let you know they&apos;re there. Nothing is charged before then. If
            something&apos;s ever off, one tap flags it and the crew makes it right.
          </p>
        </div>
      </main>
    </>
  );
}
