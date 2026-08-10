import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkLots, type LotView } from "@/components/ParkLots";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark, getParkLots } from "@/app/park/data";

export default async function ParkLotsPage() {
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

  const lots = await getParkLots(park.id);
  const view: LotView[] = lots.map((l) => ({
    id: l.lot.id,
    lotNumber: l.lot.lotNumber,
    siteType: l.lot.siteType,
    maxLengthFt: l.lot.maxLengthFt,
    amperage: l.lot.amperage,
    hasWater: l.lot.hasWater,
    hasSewer: l.lot.hasSewer,
    slipIncluded: l.lot.slipIncluded,
    notes: l.notes,
    active: l.lot.active,
    tier: l.tier,
    features: l.features,
    rates: l.rates,
    seasonOpen: l.season.openMonth != null
      ? `${String(l.season.openMonth).padStart(2, "0")}-${String(l.season.openDay).padStart(2, "0")}` : "",
    seasonClose: l.season.closeMonth != null
      ? `${String(l.season.closeMonth).padStart(2, "0")}-${String(l.season.closeDay).padStart(2, "0")}` : "",
  }));

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkLots parkId={park.id} lots={view} />
    </>
  );
}
