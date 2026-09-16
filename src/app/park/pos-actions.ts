"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark, compareLotNumbers } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { openBillsFor, oldestFirst, onAccountSources } from "@/lib/allocations";
import { tenancyFactsFor, nothingMoreBills, type TenancyFacts } from "@/lib/tenancy-facts";
import { readFailedMessage } from "@/lib/must-read";

/**
 * WHO THE OFFICE CAN TAKE MONEY FROM, AND WHAT EACH OF THEM OWES.
 *
 * The ⊕ Take a payment window has to work in three taps while somebody is
 * standing at the counter with a money order: the button, the household, and
 * Record. That means the list behind tap two must already know each
 * household's OLDEST open bill and its balance, so the amount is filled in
 * before the office reads it. No existing loader can hand it that: the rent
 * screen (getLedger) is scoped to ONE month, so a January bill still open in
 * March is structurally invisible to it — and it is exactly the bill this
 * window must put the money on.
 *
 * ONE COPY OF EVERY RULE. "Open" here is the database's own word:
 * recompute_charge_paid (0167) rewrites `park_charges.status` on every
 * payment, allocation, refund and reversal — 'paid' when the total covers
 * the bill, else 'open', void staying void — so `status = 'open'` IS the
 * statement that `amount > paid_total`. This file does not write that query;
 * it calls `openBillsFor` (lib/allocations), the read the settlement door
 * makes, and orders with `oldestFirst`, the order that same door pays bills
 * in. If the window and the ledger disagreed on which bill is oldest, the
 * receipt's "still owing" and the arrears screen would diverge on the same
 * morning — and a household who overpaid would read "late".
 *
 * WHY THIS RETURNS A SENTENCE INSTEAD OF THROWING. A server action that
 * throws reaches the browser as Next's opaque production error, and the modal
 * would have nothing true to say; a bare `[]` on a failed read is the calm lie
 * lib/must-read.ts documents ("nobody is on your roll" to an office with a
 * cheque in hand — or worse, "nothing owed, goes on account" for every
 * household, so the money lands on account instead of on the bill). Every
 * read below is checked and a failure comes back as { ok: false } with the
 * non-money sentence, because nothing has moved.
 *
 * TWO FACTS THE ROW MUST CARRY OR THE FORM LIES ABOUT MONEY. What of theirs
 * the office ALREADY holds on account: after an office correction (a line
 * taken off a bill, a paid month cancelled — both deliberately "no
 * auto-settle") a household can have an open bill AND their own money
 * sitting beside it, and a form that reads only the bill says "Owes $542.53"
 * and "Settles February" over cash it never needed to take. And whether
 * anything more will ever bill for them: "comes off their next bill" is a
 * promise, and to a household that has moved out with their final month
 * billed it is a promise of a bill the park will never raise (the void door
 * learned this first — whatBillsNext, ledger-actions). Both are read here,
 * once, for every household on the list.
 */

const DENIED = "You don't manage that park.";

export interface PaymentTarget {
  renterId: string;
  /**
   * The live tenancy's lot, or "—" when they are not on one — the same dash
   * the on-account receipt prints (money-actions.ts) for a cheque taken at
   * signing or from a household that has left owing.
   */
  lotNumber: string;
  name: string;
  /** How many bills are open for them — "oldest of 3 open bills". */
  openCount: number;
  oldestOpen: { chargeId: string; month: string; balance: number; disputed: boolean } | null;
  /**
   * Money of theirs the office already holds on account — 0167's view's
   * `remaining`, summed (onAccountSources, the settlement door's own read).
   * NEVER deposits: a deposit is not money that covers a rent bill, so this
   * is not heldOnAccountFor. Zero when nothing is held.
   */
  onAccount: number;
  /**
   * Whether anything more will ever bill for them (lib/tenancy-facts: the
   * tenancy has ended AND their final month is billed). `null` when that
   * could not be read — the void door's "unknown": the form then makes NO
   * promise either way, never "comes off their next bill" by default.
   */
  nothingMoreBills: boolean | null;
}

export type PaymentTargetsResult =
  | { ok: true; today: string; targets: PaymentTarget[] }
  | { ok: false; error: string; retryable: boolean };

const NO_LOT = "—";

export async function paymentTargets(parkId: string): Promise<PaymentTargetsResult> {
  // A denial cannot become true by retrying; a dropped read can. The window
  // offers "Try again" only on the second kind.
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED, retryable: false };

  // The form's default date and its ceiling, computed here so the browser
  // never works out a lake date of its own (ParkRent takes page.today the
  // same way).
  const today = todayLakeDate();
  const admin = createServiceClient();

  // EXACTLY getHouseholds' filter (money-actions.ts): everybody on the park's
  // file whose row is not a merged duplicate. Current residents with a bill,
  // current residents with nothing owed (a prepay goes on account), and
  // households on no lot — arrears from somebody who left, a cheque at
  // signing. Nobody the office can lawfully take money from is missing.
  const rentersRes = await admin
    .from("park_renters")
    .select("id, display_name")
    .eq("park_id", parkId)
    .is("merged_into", null);
  if (rentersRes.error) {
    return { ok: false, error: readFailedMessage("the households on your roll", rentersRes.error), retryable: true };
  }
  const renters = (rentersRes.data ?? []).map((r) => ({
    id: r.id as string,
    name: (r.display_name as string | null) ?? NO_LOT,
  }));
  if (renters.length === 0) return { ok: true, today, targets: [] };
  const renterIds = renters.map((r) => r.id);

  // THE LOT ON THE ROW: their live tenancy on one of this park's lots —
  // approved or active, the two statuses the on-account receipt reads for a
  // household's lot (money-actions.ts) and every live-tenancy read in the
  // cost, fee, re-rate and signing doors. (The charge run bills a wider set —
  // approved, active AND ended — because a bill can still be raised for the
  // days somebody stayed; that is the run's rule, not this row's.) Scoped to
  // this park's lots first, the way getParkRoll scopes the roll.
  const lotsRes = await admin.from("park_lots").select("id, lot_number").eq("park_id", parkId);
  if (lotsRes.error) {
    return { ok: false, error: readFailedMessage("your lots", lotsRes.error), retryable: true };
  }
  const lotNumberOf = new Map((lotsRes.data ?? []).map((l) => [l.id as string, String(l.lot_number ?? "")]));
  const lotOfRenter = new Map<string, string>();
  const lotIds = [...lotNumberOf.keys()];
  if (lotIds.length > 0) {
    const staysRes = await admin
      .from("lot_reservations")
      .select("park_lot_id, renter_id")
      .in("park_lot_id", lotIds)
      .in("status", ["approved", "active"]);
    if (staysRes.error) {
      return { ok: false, error: readFailedMessage("who is on your lots", staysRes.error), retryable: true };
    }
    for (const s of staysRes.data ?? []) {
      const rid = s.renter_id as string | null;
      const lot = lotNumberOf.get(s.park_lot_id as string);
      if (rid && lot && !lotOfRenter.has(rid)) lotOfRenter.set(rid, lot);
    }
  }

  // THE OPEN BILLS, from the settlement door's own read. A failed read here
  // must never come back as "nothing owed" for everybody — that would send
  // every payment at the window on account.
  const billsRes = await openBillsFor(admin, parkId, renterIds);
  if (billsRes.error) {
    return { ok: false, error: readFailedMessage("the bills still open", billsRes.error), retryable: true };
  }
  const billsOf = new Map<string, typeof billsRes.bills>();
  for (const b of billsRes.bills) {
    if (!b.renterId) continue;
    const list = billsOf.get(b.renterId) ?? [];
    list.push(b);
    billsOf.set(b.renterId, list);
  }
  const oldestOf = new Map<string, { chargeId: string; month: string; balance: number; count: number }>();
  for (const [rid, list] of billsOf) {
    const [first] = oldestFirst(list);
    if (!first) continue;
    oldestOf.set(rid, { chargeId: first.key, month: first.periodMonth, balance: first.owing, count: list.length });
  }

  // A DISPUTED BILL IS SAID ON THE ROW, NOT HIDDEN. Recording against it is
  // what the rent screen's own Record payment does, and 0074's trigger closes
  // the claim as matched on the insert — so the row says "they say they've
  // paid it" and the form says what tapping Record does about that. Same read
  // getLedger makes: open claims on these charges.
  const disputed = new Set<string>();
  const oldestIds = [...oldestOf.values()].map((o) => o.chargeId);
  if (oldestIds.length > 0) {
    const claimsRes = await admin
      .from("park_payment_claims")
      .select("charge_id")
      .in("charge_id", oldestIds)
      .is("resolved_at", null);
    if (claimsRes.error) {
      return {
        ok: false,
        error: readFailedMessage("what households have told you about paying", claimsRes.error),
        retryable: true,
      };
    }
    for (const c of claimsRes.data ?? []) disputed.add(String(c.charge_id));
  }

  // MONEY OF THEIRS ALREADY IN THE OFFICE, from the settlement door's own
  // read (onAccountSources: `remaining` > 0, never `amount`). Summed in cents
  // per household. A failed read must never come back as "nothing on
  // account" — the form would then say "Settles February" over a household
  // whose own $542.53 is in the drawer, and the office would take it twice.
  const heldRes = await onAccountSources(admin, parkId, renterIds);
  if (heldRes.error) {
    return { ok: false, error: readFailedMessage("the money households have on account", heldRes.error), retryable: true };
  }
  const heldCentsOf = new Map<string, number>();
  for (const s of heldRes.sources) {
    if (!s.renterId) continue;
    heldCentsOf.set(s.renterId, (heldCentsOf.get(s.renterId) ?? 0) + Math.round(s.remaining * 100));
  }

  // WHETHER ANYTHING MORE BILLS FOR THEM — one read over the whole list, the
  // rule every "comes off the next bill" sentence keys on. tenancyFactsFor
  // throws on a failed read (mustRead); nothing about money has moved and
  // the list is still right about what is owed and held, so the window
  // opens — with NO promise for anybody rather than a guessed one. Not
  // `false`: false is "still here, a next bill is coming", a fact this
  // could not establish.
  let facts: Map<string, TenancyFacts> | null = null;
  try {
    facts = await tenancyFactsFor(admin, renterIds, today);
  } catch (e) {
    console.error("[read failed] whether anything more bills for these households:", e);
  }

  const targets: PaymentTarget[] = renters.map((r) => {
    const oldest = oldestOf.get(r.id) ?? null;
    return {
      renterId: r.id,
      lotNumber: lotOfRenter.get(r.id) ?? NO_LOT,
      name: r.name,
      openCount: oldest?.count ?? 0,
      oldestOpen: oldest
        ? { chargeId: oldest.chargeId, month: oldest.month, balance: oldest.balance, disputed: disputed.has(oldest.chargeId) }
        : null,
      onAccount: (heldCentsOf.get(r.id) ?? 0) / 100,
      nothingMoreBills: facts ? nothingMoreBills(facts.get(r.id)) : null,
    };
  });

  // Lots in the order a person reads them down the park — "2, 9, 14", never
  // "14, 2, 9" — then the households on no lot, by name.
  targets.sort((a, b) => {
    const aLot = a.lotNumber !== NO_LOT;
    const bLot = b.lotNumber !== NO_LOT;
    if (aLot && bLot) return compareLotNumbers(a.lotNumber, b.lotNumber) || a.name.localeCompare(b.name);
    if (aLot !== bLot) return aLot ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, today, targets };
}
