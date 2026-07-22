import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { createServiceClient } from "@/lib/supabase/server";

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
  const [{ data: lakes }, { data: crews }] = await Promise.all([
    admin.from("lakes").select("id, name, slug").not("slug", "ilike", "zz-%").order("name"),
    admin.from("vendors").select("service_lakes, coi_expiry").eq("status", "active"),
  ]);
  const insured = (crews ?? []).filter((v) => v.coi_expiry != null && String(v.coi_expiry) >= today);
  const crewCount = (lakeId: string) => insured.filter((v) => ((v.service_lakes as string[]) ?? []).includes(lakeId)).length;

  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 680 }}>
        <div className="ll-eyebrow">Where we work</div>
        <h1 style={{ fontSize: 30, margin: "6px 0 8px" }}>Lakes we serve</h1>
        <p className="mut" style={{ fontSize: 15, marginBottom: 20 }}>
          Every lake gets local, insured crews, one all-in price per service, and photo-verified
          work. Don&apos;t see your lake? Join anyway — demand is exactly how we pick the next one. 🌊
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
