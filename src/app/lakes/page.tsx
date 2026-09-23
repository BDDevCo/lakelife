import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { checkNamedInsured } from "@/lib/named-insured";
import { SERVED_LAKE_MATCH } from "@/lib/lake-visibility";

/** Public index of the lakes we serve — the SEO hub the per-lake pages hang off. */

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Lakes we serve — pier, boat, lawn & home services | LakeLife",
  description:
    "LakeLife handles lake-home services on Big Long, Pretty and Big Turkey Lakes in Indiana — piers, boat lifts, winterization, lawn care and housekeeping, one all-in price, photo-verified.",
};

export default async function LakesIndexPage() {
  const admin = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  // A FAILED READ IS NOT AN EMPTY DIRECTORY. Both branches below are written
  // for a platform that genuinely has none — "Recruiting crews" under a lake
  // with no insured crew, and an empty grid where the lakes should be. On a
  // public, hourly-cached page a dropped read would render "Lakes we serve"
  // over nothing at all, and a search engine would keep it. Same posture the
  // single-lake page takes.
  const [lakesRes, crewsRes] = await Promise.all([
    // SERVED LAKES ONLY — the one predicate, lib/lake-visibility.ts.
    //
    // 0124 moved this guard off the slug and onto the column, which stopped a
    // scratch row reaching the directory. It did not stop a REAL row nobody at
    // LakeLife had agreed to: a lake born from "my lake isn't listed" was
    // `is_fixture = false` like any other, so it landed on this page — a card
    // headed "Lakes we serve" — the moment a stranger typed its name.
    admin.from("lakes").select("id, name, slug").match(SERVED_LAKE_MATCH).order("name"),
    // Same fence as the single-lake page and the router: a fixture crew must
    // never be counted in a number the public reads.
    admin.from("vendors").select("service_lakes, coi_expiry, coi_named_insured, company, users!vendors_user_id_fkey!inner(is_fixture)").eq("status", "active").eq("users.is_fixture", false),
  ]);
  const lakes = mustRead("the lakes we serve", lakesRes);
  const crews = mustRead("the crews on the water", crewsRes);
  // The same reading of "insured" the router uses, and the single-lake page
  // beside it: unexpired AND named to the business (0152), nulls grandfathered.
  const insured = (crews ?? []).filter((v) =>
    v.coi_expiry != null && String(v.coi_expiry) >= today &&
    (v.coi_named_insured == null || checkNamedInsured(v.coi_named_insured as string, (v.company as string | null) ?? null).ok));
  const crewCount = (lakeId: string) => insured.filter((v) => ((v.service_lakes as string[]) ?? []).includes(lakeId)).length;

  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 680 }}>
        <div className="ll-eyebrow">Where we work</div>
        <h1 style={{ fontSize: 30, margin: "6px 0 8px" }}>Lakes we serve</h1>
        {/* "EVERY LAKE GETS LOCAL, INSURED CREWS" IS A HEADCOUNT, IN THE
            PRESENT TENSE, ON THE PAGE THAT THEN COUNTS THEM. Every card below
            it says "Recruiting crews" today, because there is not one
            non-fixture crew on any water we serve — so the paragraph promised
            what the list underneath it immediately withdrew. What we can say
            without a crew on the books is what we hold a crew TO: an
            unexpired certificate of insurance before they can be routed
            anywhere — dispatch.ts is blunt about it, "no COI, no jobs" —
            one all-in price, and photographs before a job counts as done.
            All three survive the week somebody signs up, which is the point
            of writing it this way.

            "PER SERVICE" DID NOT SURVIVE 0174, THOUGH. It said each SERVICE
            has one price, which is the claim every page one click below this
            one just gave up: a crew_priced row has no menu at all — the crew
            who takes the job names the figure — so two crews on the same water
            can answer the same service differently. What is true, and is what
            the sentence was really promising, is that a JOB carries one
            number: the customer is never handed a crew line, a materials line
            and a LakeLife line. Nothing else in the paragraph moved. */}
        <p className="mut" style={{ fontSize: 15, marginBottom: 20 }}>
          One all-in price on every job — never split into crew, materials and our share — an
          independent local crew we hold to a current certificate
          of insurance, and photographs before any job counts as done. Don&apos;t see your lake?
          Join anyway — demand is exactly how we pick the next one. 🌊
        </p>
        <div style={{ display: "grid", gap: 12 }}>
          {(lakes ?? []).map((l) => (
            <Link key={l.id as string} href={`/lakes/${l.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="ll-card ll-card-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ fontSize: 17, margin: 0 }}>{l.name as string}</h3>
                  <p className="mut" style={{ fontSize: 13, margin: "2px 0 0" }}>
                    {crewCount(l.id as string) > 0
                      ? `${crewCount(l.id as string)} insured crew${crewCount(l.id as string) === 1 ? "" : "s"} on the water`
                      : "Recruiting crews — book anyway, you're covered by our no-charge-until-done promise"}
                  </p>
                </div>
                <span aria-hidden style={{ fontSize: 18, color: "var(--sub)" }}>›</span>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
