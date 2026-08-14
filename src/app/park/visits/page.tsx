import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getSiteVisits, type SiteVisit } from "@/app/park/visits-data";


export default async function ParkVisitsPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const park = await getMyPark();
  if (!park) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Park owners only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the park area</h2>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  const board = await getSiteVisits(park.id);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
        <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Who&apos;s on site</h1>
        <p className="mut" style={{ fontSize: 14, marginTop: 0, lineHeight: 1.5 }}>
          Crews working in the park — the company, the job and the day, so you
          can tell a truck in the drive is meant to be there.
        </p>

        {/* SAY WHAT IS AND ISN'T HERE, ONCE, PLAINLY.
            A park owner who thinks this is every visit would draw wrong
            conclusions from a quiet week.

            0107 ADDED THE LOT, and this sentence had to change with it: it
            used to promise "never ... which lot it's for", which the screen
            now contradicts three rows below. A landlord always needs to know
            who is on his property and where — that is a liability fact, and a
            van parked at Lot 7 is visible from his window anyway. What stays
            out is the money and the name: those he could never learn by
            standing there. */}
        <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 14 }}>What this does and doesn&apos;t show</strong>
          <p className="mut" style={{ fontSize: 13, marginTop: 6, marginBottom: 0, lineHeight: 1.55 }}>
            Work you booked, and work booked by residents who told us they live
            here. You see the crew, the job, the day and <b>where on your
            property</b> — because a contractor on your land is your liability
            whoever called them. It never shows <b>who</b>{" "}booked it or what
            they paid: that is between them and us, the same as it would be
            anywhere else. Residents choose whether to say they&apos;re here, so
            this won&apos;t be every visit.
          </p>
        </div>

        {!board ? (
          <p className="mut" style={{ marginTop: 20 }}>Couldn&apos;t load that just now.</p>
        ) : (
          <>
            <Section title="Today" rows={board.today} empty="No crews booked in the park today." />
            <Section title="Coming up" rows={board.upcoming} empty="Nothing booked yet." />
            <Section title="Last 30 days" rows={board.recent} empty="No visits recorded." />

            {!board.anyLinkedProperties && (
              <p className="mut" style={{ fontSize: 12.5, marginTop: 18, lineHeight: 1.5 }}>
                Nobody has told us they live here yet, and you haven&apos;t booked
                anything for the park itself — so there&apos;s nothing to show.{" "}
                <Link href="/park/services">Book something for the grounds</Link> and it
                appears here.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** "Wed, Aug 12" — the T12:00:00 keeps a UTC-midnight date from reading as
 *  the previous evening in Indiana, same as everywhere else in the app. */
function prettyDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function Section({ title, rows, empty }: { title: string; rows: SiteVisit[]; empty: string }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontWeight: 800, fontSize: 13.5, marginBottom: 8 }}>{title}</div>
      {rows.length === 0 ? (
        <p className="mut" style={{ fontSize: 13, margin: 0 }}>{empty}</p>
      ) : (
        <div className="ll-card">
          {rows.map((v, i) => (
            <div
              key={`${v.date}-${v.crew}-${v.service}-${i}`}
              style={{
                padding: "10px 12px",
                borderTop: i === 0 ? undefined : "1px solid rgba(0,0,0,.06)",
                display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 14, minWidth: 130 }}>{prettyDate(v.date)}</strong>
              <span style={{ fontSize: 14, flex: "1 1 160px" }}>{v.service}</span>
              {/* WHERE ON THE PROPERTY. The liability answer: a landlord
                  always needs to know who is on his land and where. Null is
                  the common ground, not missing data. */}
              <span className="ll-pill slate" style={{ fontSize: 12 }}>
                {v.lotNumber ? `Lot ${v.lotNumber}` : "Grounds"}
              </span>
              <span className="mut" style={{ fontSize: 13 }}>{v.crew}</span>
              {v.window && (
                <span className="mut" style={{ fontSize: 12, flexBasis: "100%" }}>{v.window}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
