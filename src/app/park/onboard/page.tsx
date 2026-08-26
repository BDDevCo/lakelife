import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkOnboard } from "@/components/ParkOnboard";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getOnboardSeeds } from "@/app/park/onboard-actions";

export default async function ParkOnboardPage() {
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

  const res = await getOnboardSeeds(park.id);
  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkOnboard
        parkId={park.id}
        seeds={res.seeds ?? []}
        today={res.today ?? ""}
        capMonths={res.capMonths ?? null}
        rentsFromImport={res.rentsFromImport ?? false}
        feePerSignedLot={res.feePerSignedLot ?? 0}
      />
    </>
  );
}
