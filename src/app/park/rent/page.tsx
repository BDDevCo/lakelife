import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkRent } from "@/components/ParkRent";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark } from "@/app/park/data";
import { getLedger } from "@/app/park/ledger-actions";
import { ParkHeldMoney, type HeldAllocation } from "@/components/ParkHeldMoney";
import { getHeldMoney, getHouseholds, getOpenChargesForApply } from "@/app/park/money-actions";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";

/**
 * WHERE EACH LISTED PAYMENT'S MONEY HAS GONE (0167), by payment id.
 *
 * `getHeldMoney` lists what is STILL on account per payment (the view's
 * `remaining`); this reads the allocations under each — which bill month
 * took how much, when, and whether the run or the office did it — so the
 * panel can show "$542.53 to January 2027" beneath "$1,085.06 still on
 * account" rather than a figure with no history. One read, joined to the
 * bill for its month; scoped to the park the caller already proved is his.
 *
 * EACH LINE'S ID, AND ITS REMOVAL (R3). The panel's "Take it off this bill"
 * hands the id to unapplyAllocation; a line already taken off is read too,
 * with when and why, and shown as the record of the correction — the
 * database keeps it, the view's `allocated` leaves it out, and this is the
 * one screen where "the record shows why" can be read.
 *
 * mustRead: a failed read would render the remaining figure with nothing
 * under it, which reads as "nothing applied" — the calmest possible lie
 * about a cheque two-thirds spent. The page throws to its error boundary,
 * the same way getHeldMoney does.
 */
async function allocationsUnder(parkId: string, paymentIds: string[]): Promise<Record<string, HeldAllocation[]>> {
  const out: Record<string, HeldAllocation[]> = {};
  if (paymentIds.length === 0) return out;
  const rows = mustRead("where the money on account has gone", await createServiceClient()
    .from("park_payment_allocations")
    .select("id, payment_id, amount, applied_at, applied_via, removed_at, removed_reason, park_charges!inner(period_month)")
    .eq("park_id", parkId)
    .in("payment_id", paymentIds)
    .order("applied_at", { ascending: true }));
  for (const r of rows ?? []) {
    // PostgREST embeds a many-to-one as an object; guard the array shape too.
    const c = Array.isArray(r.park_charges) ? r.park_charges[0] : r.park_charges;
    const id = r.payment_id as string;
    (out[id] ??= []).push({
      id: String(r.id ?? ""),
      periodMonth: String((c as { period_month?: unknown } | null)?.period_month ?? ""),
      amount: Number(r.amount ?? 0),
      appliedOn: String(r.applied_at ?? ""),
      via: r.applied_via === "office" ? "office" : "run",
      removedOn: (r.removed_at as string | null) ?? null,
      removedWhy: (r.removed_reason as string | null) ?? null,
    });
  }
  return out;
}

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
  // Needs the listed payment ids, so it follows the batch rather than joining it.
  const allocations = await allocationsUnder(park.id, held.onAccount.map((r) => r.paymentId));
  if (!page) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Nothing here.</div></>);
  }

  return (
    <>
      <TopBar />
      <ParkNav park={park} />
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
          allocations={allocations}
        />
      </div>
    </>
  );
}
