import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkPeople } from "@/components/ParkPeople";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getParkPeople } from "@/app/park/handoff-actions";

/**
 * WHO CAN OPEN THIS PARK — the screen that answers "I need to hand this off".
 *
 * Lives under Park setup rather than on its own tab: six tabs stay six, and
 * who may administer a park is setup, not a thing he does on a morning.
 */
export default async function ParkPeoplePage() {
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

  // `null` only for a non-member, already shown the door above. A FAILED read
  // throws from inside getParkPeople rather than rendering an empty list —
  // "nobody else can open this park" is a sentence he may plan a week off
  // around, so it has to be earned by a read that worked.
  const view = await getParkPeople(park.id);
  if (!view) {
    return (
      <>
        <TopBar />
        <ParkNav park={park} />
        <div className="wrap" style={{ paddingTop: 48 }}>
          <div className="ll-card ll-card-pad">We couldn&apos;t read who can open this park just now.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <ParkNav park={park} />
      <ParkPeople view={view} />
    </>
  );
}
