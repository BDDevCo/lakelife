import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { RefCatcher } from "@/components/RefCatcher";
import { createServiceClient } from "@/lib/supabase/server";
import { fromPrice } from "@/lib/lake-pages";
import type { ServiceRule } from "@/lib/pricing";

/**
 * Public per-lake landing page (§8 SEO) — every number on it is LIVE
 * platform data, never marketing fiction: real menu floors, real crew
 * counts, real completions and thumbs, real season dates, and (when an
 * HOA partnership is linked) the real fireworks-fund total. Customer
 * menu pricing only — crew rates and margin never touch the public
 * internet (rule 1). RefCatcher rides along so a shared lake link
 * attributes referrals exactly like the front door.
 */

export const revalidate = 3600; // ISR — fresh hourly, fast always

interface LakeRow {
  id: string;
  name: string;
  slug: string;
  ice_out_actual: string | null;
  pull_deadline: string | null;
  hoa_user_id: string | null;
  hoa_name: string | null;
}

async function loadLake(slug: string): Promise<LakeRow | null> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("lakes")
    .select("id, name, slug, ice_out_actual, pull_deadline, hoa_user_id, hoa_name")
    .eq("slug", slug)
    .maybeSingle();
  return (data as LakeRow | null) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const lake = await loadLake(slug);
  if (!lake) return { title: "LakeLife" };
  return {
    title: `Lake-home services on ${lake.name} — piers, boats, lawn & housekeeping | LakeLife`,
    description: `One price, one text, done — pier install & removal, boat lifts, winterization, lawn care and housekeeping on ${lake.name}, Indiana. Photo-verified work, never charged until it's done.`,
  };
}

const pretty = (iso: string | null) =>
  iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;

export default async function LakePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lake = await loadLake(slug);
  if (!lake) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>We don&apos;t know that lake yet 🌊</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>But we&apos;re always adding water.</p>
            <Link className="ll-btn" href="/lakes">See our lakes</Link>
          </div>
        </div>
      </>
    );
  }

  const admin = createServiceClient();
  const [{ data: services }, { data: crews }, { count: completedCount }, { data: thumbs }, { data: hoaEarnings }] = await Promise.all([
    admin.from("services").select("id, name, pricing_model, base, unit_rate, band_pricing, is_water_work").eq("active", true).order("name"),
    admin.from("vendors").select("id, coi_expiry, service_lakes").eq("status", "active").contains("service_lakes", [lake.id]),
    admin.from("jobs").select("id, properties!inner(lake_id)", { count: "exact", head: true }).eq("properties.lake_id", lake.id).in("status", ["complete", "paid"]),
    admin.from("job_confirmations").select("verdict, properties!inner(lake_id)").eq("properties.lake_id", lake.id).eq("verdict", "good"),
    lake.hoa_user_id
      ? admin.from("referral_earnings").select("amount").eq("beneficiary", lake.hoa_user_id).neq("status", "void")
      : Promise.resolve({ data: null }),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const crewCount = (crews ?? []).filter((v) => v.coi_expiry != null && String(v.coi_expiry) >= today).length;
  const thumbCount = (thumbs ?? []).length;
  const hoaTotal = (hoaEarnings ?? []).reduce((s, e) => s + Number(e.amount ?? 0), 0);
  const iceOut = pretty(lake.ice_out_actual);
  const pullBy = pretty(lake.pull_deadline);

  return (
    <>
      <RefCatcher />
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 760 }}>
        <div className="ll-eyebrow">LakeLife on the water</div>
        <h1 style={{ fontSize: 32, margin: "6px 0 8px" }}>Lake-home services on {lake.name}, handled.</h1>
        <p className="mut" style={{ fontSize: 15.5, marginBottom: 8 }}>
          Piers in and out on time, boats winterized before the freeze, lawns cut while you&apos;re away —
          one all-in price, booked in a minute, photo-verified when it&apos;s done. You&apos;re never charged
          until the work is complete.
        </p>
        <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 18 }}>
          {crewCount > 0
            ? `${crewCount} insured local crew${crewCount === 1 ? "" : "s"} serving ${lake.name} · ${completedCount ?? 0} jobs completed${thumbCount > 0 ? ` · ${thumbCount} 👍 from neighbors` : ""}`
            : `We're building our crew bench on ${lake.name} — book anyway; we hunt the crew down and you pay nothing until it's done.`}
        </p>
        <Link className="ll-btn gold" href="/" style={{ minHeight: 48, display: "inline-flex", alignItems: "center", padding: "0 22px", marginBottom: 24 }}>
          Get set up — it takes 2 minutes 🌊
        </Link>

        {(iceOut || pullBy) && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>{lake.name} season</h3>
            <p className="mut" style={{ fontSize: 14, margin: 0 }}>
              {iceOut ? `Ice-out: ${iceOut}. ` : ""}
              {pullBy ? `Everything out of the water by ${pullBy} — we build in an 8-day buffer before the hard freeze, so book your fall pull early.` : ""}
            </p>
          </div>
        )}

        <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>Services & pricing on {lake.name}</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {(services ?? []).map((s) => {
              const fp = fromPrice(s as unknown as Pick<ServiceRule, "pricing_model" | "base" | "unit_rate" | "band_pricing">);
              if (!fp) return null;
              return (
                <div key={s.id as string} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 700 }}>
                    {s.name as string}
                    {s.is_water_work ? <span className="ll-pill teal" style={{ marginLeft: 8, fontSize: 11 }}>seasonal</span> : null}
                  </span>
                  <span style={{ fontSize: 14.5, whiteSpace: "nowrap" }}>
                    {fp.from ? "from " : ""}<b>${fp.amount.toLocaleString()}</b>{fp.unit ? ` ${fp.unit}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
            Your exact all-in price shows before you book — it depends on your pier, boat and property. No quotes, no callbacks, no surprises.
          </p>
        </div>

        {lake.hoa_user_id && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 16, borderColor: "var(--gold, #d9a441)" }}>
            <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>🎆 The {lake.hoa_name ?? `${lake.name} Association`} fund</h3>
            <p style={{ fontSize: 20, fontWeight: 800, color: "var(--teal-dark)", margin: "0 0 4px" }}>
              ${hoaTotal.toFixed(2)} raised so far
            </p>
            <p className="mut" style={{ fontSize: 13.5, margin: 0 }}>
              Neighbors who join through the association&apos;s link fund the lake — fireworks, cleanups,
              whatever {lake.name} needs. {hoaTotal <= 0 ? "Be the first." : "Keep it going."}
            </p>
          </div>
        )}

        <div className="ll-card ll-card-pad">
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>How it works</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            Tell us about your place once — pier sections, boats, lawn. Every service shows one all-in
            price. Book a day; a vetted, insured local crew gets routed automatically; you get a text
            when it&apos;s done, with photos. Payment only happens after the photos are in. If something&apos;s
            ever off, one tap flags it and the crew makes it right.
          </p>
        </div>
      </main>
    </>
  );
}
