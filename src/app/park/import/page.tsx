import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkImportPaste } from "@/components/ParkImportPaste";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { todayLakeDate } from "@/lib/booking";

export default async function ParkImportPage() {
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

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkImportPaste parkId={park.id} todayISO={todayLakeDate()} />
    </>
  );
}
