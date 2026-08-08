import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { ParkApply, type ApplyLotView } from "@/components/ParkApply";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getPublicPark } from "@/app/parks/public-data";

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const UTILITY_LABEL: Record<string, string> = {
  water: "Water", sewer: "Sewer", electric: "Electric", trash: "Trash",
  wifi: "Wi-Fi", lawn: "Lawn care", snow: "Snow removal",
};

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  if (!hasSupabaseEnv()) return { title: "Park — LakeLife" };
  const { slug } = await params;
  const park = await getPublicPark(slug);
  if (!park) return { title: "Park not found — LakeLife" };

  const open = park.lots.filter((l) => l.openNow).length;
  const where = park.lakeName ? ` on ${park.lakeName}` : "";
  return {
    title: `${park.name}${where} — LakeLife`,
    description: park.from
      ? `${park.name}${where}. Sites from $${park.from.amount.toLocaleString()}/${park.from.term.replace("ly", "")}${open ? `, ${open} open now` : ""}.`
      : `${park.name}${where}.`,
  };
}

/**
 * The public park page — the front door that fills vacancies, and the reason
 * parks.active exists as a launch switch. An unpublished park is a 404 here
 * even though its owner can see it in their portal.
 */
export default async function PublicParkPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const { slug } = await params;
  const park = await getPublicPark(slug);
  if (!park) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const lots: ApplyLotView[] = park.lots.map((l) => ({
    id: l.id,
    lotNumber: l.lotNumber,
    siteType: l.siteType,
    maxLengthFt: l.maxLengthFt,
    amperage: l.amperage,
    openNow: l.openNow,
    rates: l.rates,
  }));
  const openCount = lots.filter((l) => l.openNow).length;

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 24, paddingBottom: 56, maxWidth: 760 }}>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 28, margin: "0 0 6px" }}>{park.name}</h1>
          <p className="mut" style={{ fontSize: 15, margin: 0 }}>
            {park.lakeName && <>{park.lakeName}</>}
            {park.lakeName && park.address && " · "}
            {park.address}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {park.from && (
              <span className="ll-pill">
                From ${park.from.amount.toLocaleString()}/{park.from.term.replace("ly", "")}
              </span>
            )}
            <span className={`ll-pill ${openCount ? "" : "slate"}`}>
              {openCount ? `${openCount} open now` : "Full right now"}
            </span>
            {park.ageRestricted && <span className="ll-pill slate">55+ community</span>}
          </div>
        </header>

        {/* A seasonal park that is shut must say so before someone plans a trip. */}
        {!park.openToday && park.season.openMonth && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
            <span className="ll-pill warn">Closed for the season</span>
            <p className="mut" style={{ fontSize: 14, margin: "10px 0 0" }}>
              {park.name}{" "}is open {MONTHS[park.season.openMonth]} {park.season.openDay} through{" "}
              {MONTHS[park.season.closeMonth ?? 1]} {park.season.closeDay}. You can still ask
              about a site for next season.
            </p>
          </div>
        )}

        {park.includedUtilities.length > 0 && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Included in the rent</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {park.includedUtilities.map((u) => (
                <span key={u} className="ll-pill slate">{UTILITY_LABEL[u] ?? u}</span>
              ))}
            </div>
          </section>
        )}

        <section style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Sites</h2>
          <ParkApply
            parkName={park.name}
            approvalRequired={park.approvalRequired}
            lots={lots}
            signedIn={!!user}
          />
        </section>

        {park.houseRules && (
          <section>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>House rules</h2>
            <div className="ll-card ll-card-pad">
              <p style={{ fontSize: 14, whiteSpace: "pre-wrap", margin: 0 }}>{park.houseRules}</p>
            </div>
          </section>
        )}

        <p className="mut" style={{ fontSize: 12, marginTop: 24 }}>
          {park.name}{" "}sets its own rates and decides who stays. LakeLife runs the
          software and the services — we don&apos;t screen applicants or make that call.
        </p>
      </div>
    </>
  );
}
