import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkRentRoll, type RollRowView } from "@/components/ParkRentRoll";
import { createClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { getMyPark, getParkLots, getParkRoll, type ParkUnitView } from "@/app/park/data";
import { lotFits, fitProblemText, type Lot } from "@/lib/parks";

/**
 * The park owner's home screen — the rent roll. Everything here is scoped to
 * the one park they administer; see data.ts for how that scoping is enforced
 * (service-role reads, hand-scoped, after a membership assertion).
 */
export default async function ParkPage() {
  if (!hasSupabaseEnv()) {
    return (<><TopBar /><div className="wrap" style={{ paddingTop: 48 }}>Add your Supabase keys first.</div></>);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 460 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill warn">Sign in first</span>
            <h3 style={{ fontSize: 20, margin: "12px 0 6px" }}>Please sign in</h3>
            <Link className="ll-btn" href="/">Back to start</Link>
          </div>
        </div>
      </>
    );
  }

  const park = await getMyPark();
  if (!park) {
    return (
      <>
        <TopBar />
        <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
          <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
            <span className="ll-pill slate">Park owners only</span>
            <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>This is the park area</h2>
            <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
              If you run a mobile-home or RV park and want to manage it here, get in
              touch — we&apos;ll set your park up and hand you the keys.
            </p>
            <Link className="ll-btn" href="/portal">Go to my portal</Link>
          </div>
        </div>
      </>
    );
  }

  const [roll, lots] = await Promise.all([getParkRoll(park.id), getParkLots(park.id)]);
  const lotById = new Map(lots.map((l) => [l.lot.id, l]));

  const rows: RollRowView[] = roll.rows.map((r) => ({
    lotId: r.lot.id,
    lotNumber: r.lot.lotNumber,
    siteType: r.lot.siteType,
    state: r.state,
    active: r.lot.active,
    currentRenter: r.current ? roll.renterNames.get(r.current.renterId) ?? "Renter" : null,
    currentUnit: r.current?.renterUnitId ? roll.units.get(r.current.renterUnitId)?.label ?? null : null,
    currentUntil: r.current?.range?.end ?? null,
    currentReservationId: r.current?.id ?? null,
    currentRent: r.current?.quotedAmount ?? null,
    currentDueDay: r.current?.dueDay ?? null,
    currentSource: r.current?.amountSource ?? null,
    // A countdown is only true for a SHORT stay. A month-to-month tenant's end
    // date is a rolling horizon we write silently (phase 2 design §1h) — it is
    // not a lease end, and "365 nights left" reads like one. Say the honest
    // thing instead.
    nightsLeft: r.current && (r.current.term === "nightly" || r.current.term === "weekly")
      ? r.nightsLeft
      : null,
    rolling: !!r.current && r.current.term !== "nightly" && r.current.term !== "weekly",
    nextRenter: r.next ? roll.renterNames.get(r.next.renterId) ?? "Renter" : null,
    nextFrom: r.next?.range?.start ?? null,
    pending: r.pending.map((p) => ({
      id: p.id,
      renter: roll.renterNames.get(p.renterId) ?? "Renter",
      unit: p.renterUnitId ? roll.units.get(p.renterUnitId)?.label ?? null : null,
      from: p.range?.start ?? "",
      to: p.range?.end ?? "",
      term: p.term,
      amount: p.quotedAmount,
      // Fit is ADVICE on this screen. The owner may put whoever they like on
      // their own lot; we only make sure they see the 40ft rig on the 30ft pad
      // before they say yes, not after the truck arrives.
      fitWarnings: warningsFor(
        lotById.get(r.lot.id)?.lot,
        p.renterUnitId ? roll.units.get(p.renterUnitId) : undefined,
      ),
    })),
  }));

  return (
    <>
      <TopBar />
      <ParkNav parkName={park.name} live={park.active} />
      <ParkRentRoll
        parkId={park.id}
        isOwner={park.role === "owner"}
        live={park.active}
        slug={park.slug}
        rows={rows}
        summary={roll.summary}
      />
    </>
  );
}

/**
 * Fit warnings for an application, in plain English — "This lot takes up to
 * 30 ft." next to a 40ft rig. Advice, never a veto: the owner decides who goes
 * on their own lot, and lotFits reports EVERY problem so they are not fixing
 * these one phone call at a time.
 *
 * We never warn about power here: amperage is not something a renter is asked
 * for yet, and an invented "not enough power" would be a warning about nothing.
 */
function warningsFor(lot: Lot | undefined, unit: ParkUnitView | undefined): string[] {
  if (!lot || !unit) return [];
  const res = lotFits(lot, {
    unitType: unit.unitType,
    lengthFt: unit.lengthFt,
    needsAmps: null,
  });
  // An inactive lot is already obvious from the row; do not repeat it here.
  return res.problems.filter((p) => p !== "inactive").map((p) => fitProblemText(p, lot));
}
