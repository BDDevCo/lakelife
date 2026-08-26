import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkToday } from "@/components/ParkToday";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getToday } from "@/app/park/today-actions";
import { ParkRequests } from "@/components/ParkRequests";
import { getParkRequests, getClosedRequests } from "@/app/park/request-actions";
import { renewalsDue } from "@/app/park/renew-actions";
import { ParkRenewals } from "@/components/ParkRenewals";

export default async function ParkTodayPage() {
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

  const [view, renewals, queue, closed] = await Promise.all([
    getToday(park.id),
    renewalsDue(park.id),
    getParkRequests(park.id),
    // Its own query now. Filtering the done ones out of the open queue's page
    // meant the closed list was whatever happened to fit alongside it.
    getClosedRequests(park.id, 20),
  ]);
  return (
    <>
      <TopBar />
      <ParkNav park={park} />
      {view ? (
        <>
          <ParkToday parkId={park.id} view={view} />
          {/* The renewal list sits under Today because that is where the task
              card points. A to-do that links to a screen which cannot do the
              thing is worse than no to-do. */}
          <div className="wrap" style={{ paddingTop: 0, paddingBottom: 48 }}>
            <ParkRenewals parkId={park.id} rows={renewals.rows ?? []} />
            {/* Reported from the park. Sits on Today because it is the screen
                he opens with coffee, and these used to arrive on his mobile
                and live in his head. */}
            <ParkRequests parkId={park.id} rows={queue.rows} more={queue.more}
              closed={closed} />
          </div>
        </>
      ) : (
        <div className="wrap" style={{ paddingTop: 24 }}>Nothing to show yet.</div>
      )}
    </>
  );
}
