import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkLots, type LotView } from "@/components/ParkLots";
import { AddLots } from "@/components/AddLots";
import { getSharedCostBaseline } from "@/app/park/cost-actions";
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
    lifecycle: l.lot.lifecycle,
    expectedLiveOn: l.lot.expectedLiveOn,
    // Copied EXPLICITLY, because forgetting to copy `lifecycle` here is exactly
    // how every picker ended up showing "Live" for lots the database called
    // something else.
    rentalMode: l.lot.rentalMode,
    parkOwnedHome: l.lot.parkOwnedHome,
    tier: l.tier,
    features: l.features,
    rates: l.rates,
    seasonOpen: l.season.openMonth != null
      ? `${String(l.season.openMonth).padStart(2, "0")}-${String(l.season.openDay).padStart(2, "0")}` : "",
    seasonClose: l.season.closeMonth != null
      ? `${String(l.season.closeMonth).padStart(2, "0")}-${String(l.season.closeDay).padStart(2, "0")}` : "",
  }));

  // THE NUMBERS THE IMPACT LINE NEEDS. Rentable is what a cost is divided BY;
  // payers are the lots that actually have somebody to bill. Conflating them
  // is the mistake both the allocator and my own helper made, so they are
  // counted separately and named separately here too.
  const rentableNow = lots.filter((l) => (l.lot.lifecycle ?? "live") === "live").length;
  const { monthlyShared, payersNow } = await getSharedCostBaseline(park.id);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkLots parkId={park.id} lots={view} />
      <div className="wrap" style={{ paddingTop: 0, paddingBottom: 40 }}>
        <AddLots
          parkId={park.id}
          rentableNow={rentableNow}
          payersNow={payersNow}
          monthlyShared={monthlyShared}
        />
      </div>
    </>
  );
}
