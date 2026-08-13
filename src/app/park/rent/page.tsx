import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkRent } from "@/components/ParkRent";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getLedger } from "@/app/park/ledger-actions";
import { ParkHeldMoney } from "@/components/ParkHeldMoney";
import { getHeldMoney, getHouseholds, getOpenChargesForApply } from "@/app/park/money-actions";

export default async function ParkRentPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
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

  const { month } = await searchParams;
  const page = await getLedger(park.id, month);
  const [held, households, openCharges] = await Promise.all([
    getHeldMoney(park.id),
    getHouseholds(park.id),
    getOpenChargesForApply(park.id),
  ]);
  if (!page) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Nothing here.</div></>);
  }

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkRent parkId={park.id} page={page} />
      <div className="wrap" style={{ maxWidth: 900, paddingBottom: 24 }}>
        <ParkHeldMoney
          parkId={park.id}
          today={page.today}
          households={households}
          onAccount={held.onAccount}
          deposits={held.deposits}
          onAccountTotal={held.onAccountTotal}
          depositsHeldTotal={held.depositsHeldTotal}
          openCharges={openCharges}
        />
      </div>
    </>
  );
}
