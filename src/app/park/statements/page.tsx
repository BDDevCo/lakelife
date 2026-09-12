import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkStatements } from "@/components/ParkStatements";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getStatement } from "@/app/park/receipts-actions";
import { monthPeriod } from "@/app/park/receipts-helpers";
import { todayLakeDate } from "@/lib/booking";
import { paymentsAreLive } from "@/lib/charge-gate";

/**
 * Defaults to LAST COMPLETE MONTH, not this one.
 *
 * A statement for a month still running is always short, and the first number
 * he ever sees should be one he can trust rather than one he has to discount.
 */
function lastCompleteMonth(todayISO: string): string {
  const [y, m] = todayISO.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export default async function ParkStatementsPage() {
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

  const today = todayLakeDate();
  const initial = monthPeriod(lastCompleteMonth(today), today)!;
  const page = await getStatement(park.id, initial.from, initial.to);

  // THE FACT COMES FROM THE SERVER. ParkStatements hides "Refund to card" and
  // says "the processor isn't connected" whenever `paymentsLive` is false, and
  // its default is false — so a page that never passed it would have kept
  // saying that on the day LAKELIFE_PAYMENTS_LIVE is switched on. A client
  // component cannot read the env var; this page can.
  return (
    <>
      <TopBar />
      <ParkNav park={park} />
      {page ? (
        <ParkStatements parkId={park.id} page={page} today={today} paymentsLive={paymentsAreLive()} />
      ) : (
        <div className="wrap" style={{ paddingTop: 24 }}>Nothing to report on yet.</div>
      )}
    </>
  );
}
