import { TopBar } from "@/components/Brand";
import { VendorNav } from "@/components/VendorNav";
import { CrewRoster } from "@/components/CrewRoster";
import { listWorkers } from "../workers-actions";
import { getMyVendorId } from "../data";

export const metadata = { title: "Your crew | LakeLife" };

export default async function VendorCrewPage() {
  const vendorId = await getMyVendorId();
  if (!vendorId) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Crews only</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>This is the vendor area</h3>
          </div>
        </div>
      </>
    );
  }

  const workers = await listWorkers();
  return (
    <>
      <TopBar />
      <VendorNav />
      <CrewRoster workers={workers} />
    </>
  );
}
