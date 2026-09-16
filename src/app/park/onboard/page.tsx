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
  // A REFUSED OR FAILED LOADER IS A SENTENCE, not "everyone is housed". This
  // passed `res.seeds ?? []` straight through, so a denied membership check
  // rendered "Every live lot already has somebody on it. Nothing left to file."
  if (!res.ok) {
    return (
      <>
        <TopBar />
        <ParkNav park={park} />
        <div className="wrap" style={{ paddingTop: 24 }}>{res.error}</div>
      </>
    );
  }
  return (
    <>
      <TopBar />
      <ParkNav park={park} />
      <ParkOnboard
        parkId={park.id}
        seeds={res.seeds ?? []}
        // `!res.ok` returned above, so a missing count can only mean zero.
        liveLots={res.liveLots ?? 0}
        totalLots={res.totalLots ?? 0}
        today={res.today ?? ""}
        capMonths={res.capMonths ?? null}
        termMonths={res.termMonths ?? null}
        rentsFromImport={res.rentsFromImport ?? false}
        feePerSignedLot={res.feePerSignedLot ?? 0}
        // THE PROP NOTHING PASSED. getOnboardSeeds returned it and the screen
        // accepted it (defaulting to null), so before go-live the seeded date
        // was today, the input had no floor, and the server then refused
        // every signed row by name.
        cutoverDate={res.cutoverDate ?? null}
      />
    </>
  );
}
