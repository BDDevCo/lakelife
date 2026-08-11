import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkStatements } from "@/components/ParkStatements";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getStatement } from "@/app/park/receipts-actions";
import { monthPeriod } from "@/app/park/receipts-helpers";
import { todayLakeDate } from "@/lib/booking";

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

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      {page ? (
        <ParkStatements parkId={park.id} page={page} today={today} />
      ) : (
        <div className="wrap" style={{ paddingTop: 24 }}>Nothing to report on yet.</div>
      )}
    </>
  );
}
