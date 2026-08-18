import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";
import { ParkReRate } from "@/components/ParkReRate";
import { InviteEveryone } from "@/components/InviteEveryone";
import { ParkRentRoll, type RollRowView } from "@/components/ParkRentRoll";
import { claimStatusFor } from "@/app/parks/claim-actions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { hasSupabaseEnv } from "@/lib/env";
import { pendingReRates } from "@/app/park/rerate-actions";
import { buildStatement, rollUp, statementLine, type StatementFee } from "@/app/park/statement-helpers";
import { getMyPark, getParkLots, getParkRoll, type ParkUnitView } from "@/app/park/data";
import { lotFits, fitProblemText, type Lot } from "@/lib/parks";
import { todayLakeDate } from "@/lib/booking";
import { periodIsBillable, firstBillablePeriod } from "@/lib/billing-start";
import { prettyMonth } from "@/app/park/ledger-helpers";
import { mustRead } from "@/lib/must-read";

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

  const [roll, lots, pending] = await Promise.all([
    getParkRoll(park.id),
    getParkLots(park.id),
    pendingReRates(park.id),
  ]);

  // WHAT EACH HOUSEHOLD OWES THIS MONTH. Rent plus the monthly fees, prorated
  // for a part month, and withheld entirely where a rent was never set —
  // billing somebody the fee alone is worse than billing nothing.
  const sb = await createClient();
  // EVERY READ BELOW EITHER ANSWERS OR THROWS. Swallowed, `cutover_date` reads
  // as "no cutover", which turns the pre-go-live guard forty lines down off;
  // and missing fees quietly shrink what every household is shown as owing.
  const parkRow = mustRead(
    "your park's settings",
    await sb
      .from("parks")
      .select("rent_notice_days, rent_due_day, cutover_date")
      .eq("id", park.id)
      .maybeSingle(),
  );
  const noticeDays = (parkRow?.rent_notice_days as number) ?? 30;

  const feeRows = mustRead(
    "your park's fees",
    await sb
      .from("park_fees")
      .select("label, amount, cadence, applies_to, active")
      .eq("park_id", park.id)
      .eq("active", true),
  );

  const monthlyFees: StatementFee[] = (feeRows ?? [])
    .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string))
    .map((f) => ({
      label: f.label as string,
      amount: Number(f.amount),
      cadence: f.cadence as string,
    }));

  const thisMonth = roll.today.slice(0, 7);

  // IS THIS MONTH EVEN OURS?
  //
  // The tile below simulates what every household would owe and prorates from
  // the day each tenancy was filed. File nineteen households on the afternoon
  // you take over on the 15th, and it reads "about $2,834 owed this month" —
  // for a month the previous owner collected on the 1st and settled with you
  // at the closing table. The residents paid it. Nobody owes it.
  //
  // The nightly reconciler already understood this and goes quiet in the
  // go-live month; this screen did not, and this screen is the one he reads on
  // his first afternoon.
  const cutoverDate = (parkRow?.cutover_date as string | null) ?? null;
  const monthIsOurs = periodIsBillable(thisMonth, cutoverDate);
  const firstOurs = firstBillablePeriod(cutoverDate);

  const owed = new Map<string, string>();
  const statements = [];
  for (const r of monthIsOurs ? roll.rows : []) {
    if (!r.current?.range) continue;
    const st = buildStatement({
      month: thisMonth,
      stay: r.current.range,
      rent: r.current.quotedAmount,
      fees: r.lot.rentalMode === "short_term" ? [] : monthlyFees,
      dueDay: (parkRow?.rent_due_day as number) ?? 1,
    });
    statements.push(st);
    owed.set(r.lot.id, statementLine(st));
  }
  const owedSummary = rollUp(statements);

  // WHAT IS ACTUALLY OWED, from the ledger — not what rent WOULD be.
  //
  // `rollUp(statements)` above simulates this month's bills from the roll and
  // reads neither `park_charges` nor `park_payments`. So on the 28th, with
  // every household paid, this tile still said "$8,645 owed": it was answering
  // "what does a month here cost" while wearing the label of what people owe.
  // That is the number the owner plans against.
  //
  // A DISPUTED BILL IS NOT ARREARS. It is counted separately below, because
  // "they say they paid and we haven't found it" is a thing to go and settle,
  // not money to chase.
  //
  // AND A FAILED READ IS NOT A SETTLED MONTH. Swallowed, this pair renders
  // "0 billed, $0 outstanding, nothing disputed" — the tile he plans against,
  // saying the calmest possible wrong thing.
  const liveCharges = mustRead(
    "this month's bills",
    await sb
      .from("park_charges")
      .select("id, amount, paid_total, status, period_month")
      .eq("park_id", park.id)
      .eq("period_month", thisMonth)
      .neq("status", "void"),
  );
  const openClaims = mustRead(
    "what households have told you about paying",
    await sb
      .from("park_payment_claims")
      .select("charge_id")
      .is("resolved_at", null),
  );
  const disputedIds = new Set((openClaims ?? []).map((c) => c.charge_id as string));

  const billedThisMonth = (liveCharges ?? []).length;
  let outstanding = 0;
  let disputedAmount = 0;
  for (const c of liveCharges ?? []) {
    const bal = Math.round((Number(c.amount ?? 0) - Number(c.paid_total ?? 0)) * 100) / 100;
    if (bal <= 0) continue;
    if (disputedIds.has(c.id as string)) disputedAmount = Math.round((disputedAmount + bal) * 100) / 100;
    else outstanding = Math.round((outstanding + bal) * 100) / 100;
  }

  const lotById = new Map(lots.map((l) => [l.lot.id, l]));

  // Declared here and computed once the contact map is built, below.
  let canReachNow = 0;
  let needPaperNow = 0;

  // WHETHER EACH HOUSEHOLD CAN REACH THEIR OWN RECORDS. A fact about their
  // slip, never about them — the refusal log behind it is ops-only, because a
  // failed attempt must not become a durable note about a resident on their
  // landlord's screen.
  const renterIds = roll.rows
    .map((r) => r.current?.renterId)
    .filter((x): x is string => !!x);
  const claimStatuses = await claimStatusFor(renterIds);

  // CAN WE EMAIL THEM, AND HAVE WE ALREADY? Two facts, and the row needs both:
  // the first decides whether "Email them" appears at all, the second is what
  // makes "one invite, then silence" visible rather than merely enforced.
  // SERVICE ROLE, HAND-SCOPED — like every other read in the park module.
  //
  // The first version used the session client and came back empty with no
  // error on screen. `park_renters` has an RLS policy that WOULD let an owner
  // read it, and no table grant to `authenticated` at all, so the policy never
  // gets a chance to allow anything. supabase-js hands that back as
  // `{ data: null }`, which is indistinguishable from "this park has nobody on
  // it" — the button simply never appeared and nothing said why.
  //
  // `.eq("park_id", park.id)` is the security boundary here, spelled out
  // rather than assumed, exactly as data.ts does it.
  const contact = new Map<string, { email: string | null; invitedAt: string | null }>();
  {
    // Not swallowed, and no longer merely logged. An error here reads as
    // "nobody is reachable", which is a quiet, wrong answer to the question
    // this whole screen exists to ask — so it stops the screen instead.
    const contactRows = mustRead(
      "how to reach each household",
      await createServiceClient()
        .from("park_renters")
        .select("id, email, invite_sent_at, user_id, claim_declined_at")
        .eq("park_id", park.id),
    );

    for (const c of contactRows ?? []) {
      contact.set(c.id as string, {
        email: (c.email as string | null) ?? null,
        invitedAt: (c.invite_sent_at as string | null) ?? null,
      });

      // Only households still to be reached: anyone already claimed, already
      // invited, or who has said no thanks is nobody's job any more.
      if (c.user_id != null || c.claim_declined_at != null) continue;
      if (c.invite_sent_at != null) continue;
      if ((c.email as string | null)?.trim()) canReachNow++;
      else needPaperNow++;
    }
  }

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
    currentRenterId: r.current?.renterId ?? null,
    claimStatus: r.current?.renterId ? claimStatuses[r.current.renterId] ?? "none" : null,
    renterEmail: r.current?.renterId ? contact.get(r.current.renterId)?.email ?? null : null,
    invitedAt: r.current?.renterId ? contact.get(r.current.renterId)?.invitedAt ?? null : null,
    currentRent: r.current?.quotedAmount ?? null,
    currentDueDay: r.current?.dueDay ?? null,
    currentSource: r.current?.amountSource ?? null,
    owedThisMonth: owed.get(r.lot.id) ?? null,
    expectedMoveOut: r.current?.expectedMoveOut ?? null,
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
      {/* RESERVED counts too. The Haven's whole roll is "reserved" until the
          Dec 15 cutover, so gating on `occupied` would hide the re-rate panel
          on precisely the park it was built for — and on every park during the
          window between signing and closing. */}
      {/* THE BULK INVITE, ABOVE THE ROLL. Counted from the same two facts the
          rows use, so the button and the rows can never disagree about who is
          reachable. */}
      {(canReachNow > 0 || needPaperNow > 0) && (
        <div className="wrap" style={{ paddingTop: 14, paddingBottom: 0 }}>
          <InviteEveryone parkId={park.id} canReach={canReachNow} needPaper={needPaperNow} />
        </div>
      )}

      {roll.summary.occupied + roll.summary.reserved > 0 && (
        <div className="wrap" style={{ paddingTop: 14, paddingBottom: 0 }}>
          <ParkReRate
            parkId={park.id}
            noticeDays={noticeDays}
            pending={pending}
            todayISO={roll.today}
          />
        </div>
      )}
      <ParkRentRoll
        parkId={park.id}
        isOwner={park.role === "owner"}
        live={park.active}
        slug={park.slug}
        parkName={park.name}
        rows={rows}
        summary={roll.summary}
        owedTotal={outstanding}
        owedBlocked={owedSummary.blocked}
        owedMonth={thisMonth}
        billedThisMonth={billedThisMonth}
        disputedAmount={disputedAmount}
        wouldBill={owedSummary.total}
        preGoLive={
          monthIsOurs || firstOurs == null
            ? undefined
            : { firstMonth: firstOurs, label: prettyMonth(firstOurs) }
        }
        today={todayLakeDate()}
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
