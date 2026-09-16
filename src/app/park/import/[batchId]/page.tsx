import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkImportRead, type ReadView } from "@/components/ParkImportRead";
import { hasSupabaseEnv } from "@/lib/env";
import { loadBatch } from "@/app/park/import-actions";
import { getMyPark } from "@/app/park/data";

export default async function ParkImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const { batchId } = await params;
  const [park, batch] = await Promise.all([getMyPark(), loadBatch(batchId)]);

  // Somebody with no park at all gets the same card every park screen shows.
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

  // loadBatch asserts membership itself and returns null when it fails, so a
  // missing batch and a batch belonging to somebody else read the same here.
  // An UNDONE batch is not this case — undo stamps undone_at and the batch
  // still loads, so the card must not say "undone". The owner keeps the
  // strip: the park is known, and the strip is the way off this screen.
  if (!batch) {
    return (
      <>
        <TopBar />
        <ParkNav park={park} />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 480 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>That import isn&apos;t here</h2>
            <p className="mut">That link is stale, or the import belongs to another park.</p>
            <Link className="ll-btn" href="/park/import">Start a new one</Link>
          </div>
        </div>
      </>
    );
  }

  const view: ReadView = {
    batchId: batch.id,
    parkName: batch.parkName,
    linesTotal: batch.linesTotal,
    linesRead: batch.linesRead,
    rawText: batch.rawText,
    committedAt: batch.committedAt,
    undoneAt: batch.undoneAt,
    rows: batch.plan.rows,
    ready: batch.plan.ready,
    needsYou: batch.plan.needsYou,
    lotsToCreate: batch.plan.lotsToCreate,
    monthlyTotal: batch.plan.monthlyTotal,
    namelessRoll: batch.plan.namelessRoll,
    rates: batch.plan.rates,
    others: batch.others,
    blockQuestions: batch.blockQuestions,
    counts: batch.counts,
    statedTotal: batch.statedTotal,
    refusedColumns: batch.refusedColumns,
    reconciliation: batch.reconciliation,
  };

  return (
    <>
      <TopBar />
      <ParkNav park={park} />
      <ParkImportRead view={view} />
    </>
  );
}
