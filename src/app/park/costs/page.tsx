import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkCosts } from "@/components/ParkCosts";
import { ParkFees } from "@/components/ParkFees";
import { ParkCostSchedules } from "@/components/ParkCostSchedules";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { listCosts, getBillableParkJobs, listCostSchedules } from "@/app/park/cost-actions";
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

  const [{ rows, summary }, feesPage, billable, schedules] = await Promise.all([
    listCosts(park.id),
    listFees(park.id),
    getBillableParkJobs(park.id),
    listCostSchedules(park.id),
  ]);

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkCosts
        billable={billable}
        parkId={park.id}
        rows={rows}
        summary={summary}
        /* A FEE THAT NOBODY PAYS RECOVERS NOTHING. This flipped the costs
           headline to "covered by your fee below" on the mere EXISTENCE of a
           fee — so the moment one is saved, before a single household is on a
           lot, the screen claims costs are being recovered that are not. */
        recoveredByFee={feesPage.coveragePayers > 0
          && feesPage.fees.some((f) => f.active && f.covers.length > 0)}
        schedules={<ParkCostSchedules parkId={park.id} rows={schedules} />}
        fees={<ParkFees parkId={park.id} page={feesPage} />}
      />
    </>
  );
}
