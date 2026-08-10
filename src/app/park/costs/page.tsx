import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkCosts } from "@/components/ParkCosts";
import { ParkFees } from "@/components/ParkFees";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { listCosts } from "@/app/park/cost-actions";
import { listFees } from "@/app/park/fee-actions";

export default async function ParkCostsPage() {
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

  const [{ rows, summary }, feesPage] = await Promise.all([
    listCosts(park.id),
    listFees(park.id),
  ]);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkCosts
        parkId={park.id}
        rows={rows}
        summary={summary}
        recoveredByFee={feesPage.fees.some((f) => f.active && f.covers.length > 0)}
        fees={<ParkFees parkId={park.id} page={feesPage} />}
      />
    </>
  );
}
