import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkSetup } from "@/components/ParkSetup";
import { ParkStreams } from "@/components/ParkStreams";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { parkStreamStatuses } from "@/app/park/stream-actions";
import { getParkDials } from "@/app/park/actions";
import { ParkDials } from "@/components/ParkDials";
import type { ParkProfileInput } from "@/app/park/park-helpers";

const md = (m: number | null, d: number | null) =>
  m && d ? `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "";

export default async function ParkSetupPage() {
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

  const initial: ParkProfileInput = {
    name: park.name,
    address: park.address ?? "",
    parkType: park.parkType,
    ageRestricted: park.ageRestricted,
    approvalRequired: park.approvalRequired,
    seasonOpen: md(park.seasonOpenMonth, park.seasonOpenDay),
    seasonClose: md(park.seasonCloseMonth, park.seasonCloseDay),
    includedUtilities: park.includedUtilities,
    houseRules: park.houseRules ?? "",
  };

  const [statuses, dials] = await Promise.all([
    parkStreamStatuses(park.id),
    getParkDials(park.id),
  ]);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      {/* WHAT THE PARK EARNS FROM comes first: it decides which of everything
          below is even relevant to this owner. */}
      <div className="wrap" style={{ paddingTop: 18, paddingBottom: 0 }}>
        <ParkStreams parkId={park.id} statuses={statuses} />
      </div>
      {/* HOW IT RUNS sits above the profile: these are the numbers that
          decide what the app will let him write, and they were unreachable
          until now. */}
      {dials && (
        <div className="wrap" style={{ paddingTop: 0, paddingBottom: 0 }}>
          <ParkDials
            parkId={park.id}
            initial={dials.initial}
            longestStayDays={dials.longestStayDays}
          />
        </div>
      )}
      <ParkSetup parkId={park.id} initial={initial} />
    </>
  );
}
