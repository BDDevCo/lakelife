import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getParkServiceDesk, getParkServiceMenu } from "@/app/park/service-actions";
import { ParkServices } from "@/components/ParkServices";

/**
 * WHERE "Book services for the park" FINALLY LEADS.
 *
 * That link has been in ParkNav since the park module shipped, pointing at
 * /book — which tells a park owner with no property to "Set up your property
 * first" and hands him the lake-house wizard. This is the door it always
 * implied.
 */
export default async function ParkServicesPage() {
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

  const [desk, menu] = await Promise.all([
    getParkServiceDesk(park.id),
    getParkServiceMenu(park.id),
  ]);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <div className="wrap" style={{ paddingTop: 0, paddingBottom: 48 }}>
        {desk ? (
          <ParkServices
            parkId={park.id}
            parkName={desk.parkName}
            propertyId={desk.propertyId}
            liveLots={desk.liveLots}
            blockers={desk.blockers}
            canEnable={desk.canEnable}
            menu={menu}
          />
        ) : (
          <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
            Nothing to show yet.
          </div>
        )}
      </div>
    </>
  );
}
