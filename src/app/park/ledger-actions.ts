"use server";

import { rentForPeriod, lastDayOfMonth } from "./rerate-helpers";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { buildStatement, type StatementFee } from "./statement-helpers";
import { COST_CATEGORY_LABEL, type CostCategory } from "./cost-helpers";
import { feesForTenancy } from "./fee-helpers";
import { planRun, toRows, summarise, currentPeriod, prettyMonth, nothingToBillReason, type Charge, type LedgerRow, type LedgerSummary, type RunPlan, dueDayFor } from "./ledger-helpers";
import { preCutoverRefusal } from "@/lib/billing-start";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { giveRefund } from "@/lib/charge-gate";
import { remainingRefundable, refundRefusal, refundAmountRefusal, refundCents, refundSignal } from "./refund-helpers";
import { sendEmail } from "@/lib/email";
import { receiptBody, type ReceiptLines } from "./receipt-helpers";
// The ENGINE, not the action: runCharges has already asserted membership
// twenty lines up, so going back through the authorized wrapper would just
// re-ask the same question.
import { applyDueRentChangesFor, servedRentHistory } from "@/lib/rent-changes";
import type { ParkResult } from "./actions";

/**
 * THE RENT LEDGER — the write path.
 *
 * Raising charges is the one action here that touches every household at once,
 * so it is PREVIEWED before it fires and it is safe to run twice: the unique
 * constraint on (reservation, month) means a second run adds nothing.
 *
 * NOTHING HERE TAKES MONEY. It records money that ARRIVED — a check handed
 * over at the window, cash, a card run on a terminal. Taking a payment from a
 * card on file needs processor keys and is a separate path; this one is the
 * whole business today and most of it forever.
 */

const DENIED = "You don't manage that park.";

/**
 * Mirrors 0102's `park_payments_received_on_is_sane` CHECK so a person gets a
 * sentence naming the field instead of a constraint name — or worse, the
 * generic retry message that never becomes true.
 *
 * Deliberately a touch TIGHTER than the database (729 days, not 730): the DB
 * compares against `created_at::date` in UTC, which is the lake date or the
 * day after it, so a JS mirror measured in lake time must stay inside the
 * narrower window or the edge day leaks a raw 23514.
 */
// NOT exported: this file carries "use server", where every export must be an
// async function — and a sync helper exported from one is both a build error
// and a server action nobody meant to create.
function paymentDateProblem(receivedOn: string, todayISO: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return "Pick the day the money arrived.";
  const day = 86_400_000;
  const got = Date.parse(`${receivedOn}T12:00:00Z`);
  const now = Date.parse(`${todayISO}T12:00:00Z`);
  if (!Number.isFinite(got)) return "That date isn't a date.";
  if (got > now + 31 * day) return "That's more than a month from now — check the year.";
  if (got < now - 729 * day) return "That's more than two years ago — check the year.";
  return null;
}

// A FAILED FEE READ IS NOT A PARK WITH NO FEES. Swallowed, it drops the
// monthly fees off every bill the run raises — nineteen households under-billed,
// with nothing on any screen to say so. The error travels back to the caller,
// which is an action and can say it in a sentence.
async function feesFor(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
): Promise<{ fees: StatementFee[]; error: unknown }> {
  const { data, error } = await admin
    .from("park_fees")
    .select("label, amount, cadence, applies_to, active")
    .eq("park_id", parkId)
    .eq("active", true);
  if (error) return { fees: [], error };
  return {
    fees: (data ?? [])
      .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string))
      .map((f) => ({
        label: f.label as string,
        amount: Number(f.amount),
        cadence: f.cadence as string,
      })),
    error: null,
  };
}


/**
 * UNBILLED COST SHARES, per tenancy.
 *
 * `lot_cost_shares` had exactly two references in the codebase — one insert
 * and one row count — so a water bill the owner split across nineteen
 * households reached none of them. This is the reader it never had.
 *
 * A share is billed ONCE: the run stamps `billed_on_charge_id`, and only a
 * void releases it again.
 */
async function unbilledCostShares(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  reservationIds: string[],
): Promise<{
  shares: Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>;
  error: unknown;
}> {
  const out = new Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>();
  if (reservationIds.length === 0) return { shares: out, error: null };

  // A FAILED READ HERE IS NOT "NOTHING TO SPLIT". Swallowed, the water the
  // owner has already paid for silently misses this month's bills — the exact
  // failure this reader was written to end. Both reads report back instead.
  const sharesRes = await admin
    .from("lot_cost_shares")
    .select("id, cost_id, reservation_id, amount, basis")
    .in("reservation_id", reservationIds)
    .is("billed_on_charge_id", null);
  if (sharesRes.error) return { shares: out, error: sharesRes.error };
  const shares = sharesRes.data;
  if (!shares?.length) return { shares: out, error: null };

  const costIds = [...new Set(shares.map((s) => s.cost_id as string))];
  const costsRes = await admin
    .from("park_costs")
    .select("id, park_id, category, period_start, period_end")
    .in("id", costIds)
    .eq("park_id", parkId);          // never bill another park's water
  if (costsRes.error) return { shares: out, error: costsRes.error };
  const costById = new Map((costsRes.data ?? []).map((c) => [c.id as string, c]));

  for (const sh of shares) {
    const cost = costById.get(sh.cost_id as string);
    if (!cost) continue;             // a cost from elsewhere, or since removed
    // THE SAME WORDS THE OWNER SEES, from the one label map.
    //
    // This built the label by de-underscoring the raw enum, so a resident's
    // bill read "grounds — your share" while the costs screen called it
    // "Grounds & mowing", and "unit electric — your share" — which means
    // nothing to anybody — against "Electric on a home you own". A bill line
    // is the most-read sentence in the whole product and it was the only one
    // written by a regex.
    const cat = String(cost.category ?? "other") as CostCategory;
    const label = `${COST_CATEGORY_LABEL[cat] ?? "Cost"} — your share`;
    const list = out.get(sh.reservation_id as string) ?? [];
    list.push({
      id: sh.id as string,
      label,
      amount: Number(sh.amount ?? 0),
      basis: cost.period_start && cost.period_end
        ? `for ${cost.period_start} to ${cost.period_end}`
        : "as allocated",
    });
    out.set(sh.reservation_id as string, list);
  }
  return { shares: out, error: null };
}

/** What a run WOULD do. Nothing is written. */
export async function previewChargeRun(
  parkId: string,
  month: string,
): Promise<{ ok: boolean; error?: string; plan?: RunPlan }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const [parkRes, feeRes] = await Promise.all([
    admin.from("parks").select("rent_due_day, cutover_date").eq("id", parkId).maybeSingle(),
    feesFor(admin, parkId),
  ]);
  // FAILS OPEN IF SWALLOWED. `cutover_date` is the gate immediately below; a
  // failed read arrives as `park = null`, which reads as "no cutover set", so
  // the refusal never fires and the preview offers to bill a month the
  // previous owner already collected. Same for the fees: absent reads as free.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park's billing settings", parkRes.error, { money: true }) };
  }
  if (feeRes.error) {
    return { ok: false, error: readFailedMessage("your park's fees", feeRes.error, { money: true }) };
  }
  const park = parkRes.data;
  const fees = feeRes.fees;
  // THE PARK'S DAY IS THE FALLBACK, not the answer. A tenancy may carry its
  // own `due_day`; see dueDayFor.
  const dueDay = (park?.rent_due_day as number) ?? 1;

  // NOT OURS TO BILL. A month that began before the park went live belongs to
  // whoever was collecting rent then. The preview refuses first so the owner
  // reads the reason, rather than seeing an empty plan and wondering.
  const tooEarly = preCutoverRefusal(
    month, (park?.cutover_date as string | null) ?? null, prettyMonth);
  if (tooEarly) return { ok: false, error: tooEarly };

  const lotsRes = await admin
    .from("park_lots")
    .select("id, lot_number, rental_mode, lifecycle")
    .eq("park_id", parkId)
    .eq("lifecycle", "live");
  // An empty plan is a real answer for a park with no live lots. It must not
  // also be the answer for a dropped connection.
  if (lotsRes.error) {
    return { ok: false, error: readFailedMessage("your lots", lotsRes.error, { money: true }) };
  }
  const lots = lotsRes.data;
  const lotById = new Map((lots ?? []).map((l) => [l.id as string, l]));
  if (lotById.size === 0) return { ok: true, plan: planRun([], new Set()) };

  // Same rule as the run (0101): an ended tenancy with a recorded move-out is
  // billed for the days it covered. Leaving it out here would break this
  // function's own stated invariant, two comments below — the preview would
  // omit a final part-month the run then charges.
  const staysRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, quoted_amount, status, moved_out_on, due_day, origin")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active", "ended"]);
  if (staysRes.error) {
    return { ok: false, error: readFailedMessage("who's on your lots", staysRes.error, { money: true }) };
  }
  const staysRaw = staysRes.data;
  const stays = (staysRaw ?? []).filter(
    (s) => s.status !== "ended" || s.moved_out_on != null,
  );

  // A PREVIEW MUST SHOW WHAT THE RUN WILL ACTUALLY DO.
  //
  // This used to read its own narrower set of changes — the ones already due
  // TODAY — while the run resolved the rate at the END of the month being
  // billed. Billing January on the 2nd with an increase due the 15th, the
  // preview quoted the old rent and the run charged the new one. Same query,
  // same instant, or the number he approves is not the number he sends.
  const histRes = await servedRentHistory((stays ?? []).map((s) => s.id as string));
  if (histRes.error) {
    return { ok: false, error: readFailedMessage("the rent history for these lots", histRes.error, { money: true }) };
  }
  const changesByRes = histRes.byRes;

  // A VOIDED BILL IS NOT A BILL. Without this filter, cancelling a charge made
  // that household's month permanently unbillable — the row still occupied the
  // slot, `summarise` skips void charges so it didn't even read as
  // outstanding, and they simply stopped being billed for a month as a
  // consequence of the owner fixing a mistake. 0081 makes the unique index
  // agree.
  const existingRes = await admin
    .from("park_charges")
    .select("reservation_id")
    .eq("park_id", parkId)
    .eq("period_month", month)
    .neq("status", "void");
  // A failed read reads as "nothing billed yet", so the preview would promise
  // to raise bills that already exist.
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("the bills already raised for that month", existingRes.error, { money: true }) };
  }
  const already = new Set((existingRes.data ?? []).map((c) => c.reservation_id as string));

  // The preview must include what the run will bill (its own stated
  // invariant, forty lines up) — and the run now bills cost shares.
  const shareRes = await unbilledCostShares(admin, parkId, (stays ?? []).map((s) => s.id as string));
  if (shareRes.error) {
    return { ok: false, error: readFailedMessage("the costs you've split", shareRes.error, { money: true }) };
  }
  const shareMap = shareRes.shares;

  const candidates = (stays ?? []).map((s) => {
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    // Resolved exactly as the run resolves it — see servedRentHistory.
    const rentNow = rentForPeriod(
      changesByRes.get(s.id as string) ?? [],
      lastDayOfMonth(month),
      s.quoted_amount == null ? null : Number(s.quoted_amount),
    );
    const st = range
      ? buildStatement({
          month,
          stay: range,
          rent: rentNow,
          // A nightly home is priced per stay, and an INHERITED tenancy is
          // charged no fee at all — see feesForTenancy. The preview must use
          // the same function as the run or it quotes a number the run will
          // not raise.
          fees: feesForTenancy(fees, lot, s),
          dueDay: dueDayFor(s.due_day, dueDay),
          costShares: shareMap.get(s.id as string) ?? [],
        })
      : null;
    return {
      reservationId: s.id as string,
      lotNumber: lot.lot_number as string,
      // Zero means "they weren't here" — a real answer, but not worth a charge.
      amount: st == null || st.total === 0 ? null : st.total,
    };
  });

  return { ok: true, plan: planRun(candidates, already) };
}

/**
 * Raise the charges. Safe to run twice — the second adds nothing.
 *
 * The statement is SNAPSHOTTED into the charge. Re-rating somebody in June
 * must not move May's bill.
 */
export async function runCharges(
  parkId: string,
  month: string,
): Promise<ParkResult & { raised?: number; total?: number }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();

  // RENT INCREASES THAT ARE DUE GET APPLIED BEFORE ANYTHING IS BILLED.
  //
  // `applyDueRentChanges` only ran from the nightly — 00:00 UTC, which is
  // about 8pm in Indiana. So an owner billing on the morning of the 1st raised
  // every bill at the OLD rate, and the increase landed twelve hours later
  // with the statements already frozen. At 19 lots and $25 that is $475 he
  // never collects, every time.
  //
  // Safe to call here: it is idempotent, scoped to this park, and the database
  // refuses any change whose notice was not properly served — so this can only
  // ever apply increases that were already legitimately due today.
  // ONLY WHEN BILLING THE MONTH WE ARE ACTUALLY IN. This writes today's due
  // increases onto lot_reservations.quoted_amount; running it while raising a
  // PAST month pulled a later increase back over an earlier month's bill.
  // (The rate used for the bill itself is chosen per-period below, so this is
  // belt as well as braces.)
  const billingCurrentMonth = month === todayLakeDate().slice(0, 7);
  const rateMoves = billingCurrentMonth
    ? await applyDueRentChangesFor(parkId)
    : { applied: 0, skipped: [] as string[] };

  const [parkRes, feeRes] = await Promise.all([
    admin.from("parks").select("rent_due_day, cutover_date").eq("id", parkId).maybeSingle(),
    feesFor(admin, parkId),
  ]);
  // FAILS OPEN IF SWALLOWED, and this is the write path. A failed park read
  // reads as "no cutover set" to the refusal below, which is the third of the
  // three layers that stop nineteen bills going out for a month somebody else
  // already collected. A layer that cannot run is not a layer.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park's billing settings", parkRes.error, { money: true }) };
  }
  if (feeRes.error) {
    return { ok: false, error: readFailedMessage("your park's fees", feeRes.error, { money: true }) };
  }
  const park = parkRes.data;
  const fees = feeRes.fees;
  // THE PARK'S DAY IS THE FALLBACK, not the answer. A tenancy may carry its
  // own `due_day`; see dueDayFor.
  const dueDay = (park?.rent_due_day as number) ?? 1;

  // The same refusal as the preview, checked again here rather than trusted.
  // These are two exported server actions and either can be called on its own;
  // a gate that only lives in the one the button happens to call first is not
  // a gate. The database refuses this too (0131) — three layers, because the
  // failure is nineteen real bills for rent somebody else already collected.
  const tooEarly = preCutoverRefusal(
    month, (park?.cutover_date as string | null) ?? null, prettyMonth);
  if (tooEarly) return { ok: false, error: tooEarly };

  const lotsRes = await admin
    .from("park_lots")
    .select("id, lot_number, rental_mode")
    .eq("park_id", parkId)
    .eq("lifecycle", "live");
  // "No live lots to bill" is a statement about his park. Do not make it on
  // the strength of a read that never came back.
  if (lotsRes.error) {
    return { ok: false, error: readFailedMessage("your lots", lotsRes.error, { money: true }) };
  }
  const lots = lotsRes.data;
  const lotById = new Map((lots ?? []).map((l) => [l.id as string, l]));
  if (lotById.size === 0) return { ok: false, error: "No live lots to bill." };

  // ENDED TENANCIES ARE BILLED FOR THEIR LAST PART-MONTH (0101).
  //
  // This filtered to approved/active, which meant a household that moved out
  // on the 20th dropped out of every future run — so their twenty days were
  // either inside a full-month charge nobody could correct (voiding it made
  // the month permanently unbillable) or were never billed at all, silently.
  //
  // Including 'ended' is safe without a date filter, because `buildStatement`
  // returns a total of 0 for a stay that covers none of the month and the loop
  // below already skips a zero. A tenancy that ended in July simply
  // contributes nothing to August.
  //
  // 'cancelled' stays OUT: nobody ever lived there.
  const staysRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, quoted_amount, status, moved_out_on, due_day, origin")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active", "ended"]);
  // Swallowed, this ends as "Nothing to bill — it may already be done", which
  // is how a whole month quietly goes unbilled.
  if (staysRes.error) {
    return { ok: false, error: readFailedMessage("who's on your lots", staysRes.error, { money: true }) };
  }
  const staysRaw = staysRes.data;

  // An 'ended' row with no `moved_out_on` was closed by the old one-click
  // path, so its range was never trimmed and still runs to the end of the
  // agreement. Billing from that range would charge a departed household for
  // months they were not here. No move-out date, no bill.
  const stays = (staysRaw ?? []).filter(
    (s) => s.status !== "ended" || s.moved_out_on != null,
  );

  // Same rule as the preview: a cancelled bill leaves the month billable.
  const existingRes = await admin
    .from("park_charges").select("reservation_id")
    .eq("park_id", parkId).eq("period_month", month)
    .neq("status", "void");
  // This is the "safe to run twice" guarantee. A failed read empties it, and
  // the run tries to re-bill everybody — the unique index catches it, but as
  // an anonymous insert failure rather than a sentence.
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("the bills already raised for that month", existingRes.error, { money: true }) };
  }
  const already = new Set((existingRes.data ?? []).map((c) => c.reservation_id as string));

  // The money the owner already paid out and split (0104). Billed once: the
  // stamp below is what stops a second run charging the water twice.
  const shareRes = await unbilledCostShares(admin, parkId, (stays ?? []).map((x) => x.id as string));
  if (shareRes.error) {
    return { ok: false, error: readFailedMessage("the costs you've split", shareRes.error, { money: true }) };
  }
  const shareMap = shareRes.shares;
  /** reservation -> the share ids that went onto its charge, stamped after insert. */
  // THE RENT HISTORY FOR THESE TENANCIES, so each month is billed at its own
  // rate rather than at today's — and only the increases actually SERVED. This
  // read every non-cancelled change, so an increase scheduled but never
  // noticed was billed anyway; see servedRentHistory.
  const histRes = await servedRentHistory((stays ?? []).map((x) => x.id as string));
  // Empty here would silently bill every past month at today's rate — the
  // exact defect this read exists to prevent — so it stops rather than guesses.
  if (histRes.error) {
    return { ok: false, error: readFailedMessage("the rent history for these lots", histRes.error, { money: true }) };
  }
  const changesByRes = histRes.byRes;

  const shareIdsByRes = new Map<string, string[]>();

  const rows: Record<string, unknown>[] = [];
  /**
   * WHY NOTHING WAS RAISED, when nothing is.
   *
   * "It may already be done" was asserted whenever this loop produced no rows,
   * and the loop skips for four different reasons. The one that matters is a
   * tenancy whose agreement window has ENDED: the household is still on the
   * lot, nobody moved out, and the rent simply stops.
   *
   * That is not hypothetical here. Every agreement filed on one afternoon
   * under a 3-month cap ends on the same day — file 20 households on 1 January
   * 2027 and every one of them runs out on 1 April. April's run would then have
   * told him the month was probably already billed, on the morning the whole
   * park stopped paying.
   */
  const monthStart = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  let skippedAlready = 0;
  const expiredLots: string[] = [];
  const notYetLots: string[] = [];
  const noRentLots: string[] = [];

  for (const s of stays ?? []) {
    if (already.has(s.id as string)) { skippedAlready += 1; continue; }
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    if (!range) continue;

    const shares = shareMap.get(s.id as string) ?? [];
    const st = buildStatement({
      month, stay: range,
      // THE RATE THAT WAS IN FORCE DURING THIS MONTH, not the one in force
      // today — see rentForPeriod. quoted_amount is a live value; a bill for
      // January must not inherit February's increase.
      rent: rentForPeriod(
        changesByRes.get(s.id as string) ?? [],
        lastDayOfMonth(month),
        s.quoted_amount == null ? null : Number(s.quoted_amount),
      ),
      fees: feesForTenancy(fees, lot, s),
      dueDay: dueDayFor(s.due_day, dueDay),
      costShares: shares,
    });
    // No total = a rent nobody set. Billing zero would hide it behind a paid
    // charge; skipping leaves it visible on the roll where it belongs.
    if (st.total == null || st.total === 0) {
      const name = (lot.lot_number as string) ?? "?";
      if (st.total == null) noRentLots.push(name);
      else if (range.end <= monthStart) expiredLots.push(name);
      else if (range.start > monthEnd) notYetLots.push(name);
      continue;
    }
    if (shares.length) shareIdsByRes.set(s.id as string, shares.map((c) => c.id));

    rows.push({
      park_id: parkId,
      park_lot_id: s.park_lot_id,
      reservation_id: s.id,
      renter_id: s.renter_id,
      period_month: month,
      due_on: st.dueOn,
      lines: st.lines,
      amount: st.total,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: nothingToBillReason(prettyMonth(month), {
      already: skippedAlready, expired: expiredLots, notYet: notYetLots, noRent: noRentLots,
    }) };
  }

  const { data: raised, error } = await admin
    .from("park_charges").insert(rows).select("id, reservation_id");
  if (error) return { ok: false, error: "Couldn't raise those — try again." };

  // STAMP THE SHARES. Without this a second run bills the same water again —
  // the unique index stops a second CHARGE, but the shares would still read as
  // unbilled and land on the next month's bill instead.
  //
  // AND A FAILED STAMP USED TO BE SWALLOWED — `if (!stampErr)` counted it and
  // said nothing. The charge is already raised, so the resident has been
  // billed for the water; the shares still read as unbilled, so NEXT month's
  // run picks them up and bills the same water again. The same-month guard
  // above (`already`) cannot help: that keys on period_month, and next month
  // is a different one.
  //
  // So: if we could not mark the shares as spent, we take the bill back. The
  // invariant this restores is "a charge exists only if its shares are
  // stamped" — voiding leaves the month billable, which is recoverable, where
  // a double bill is money out of a resident's pocket. If the void ALSO fails
  // there is nothing left to do but say so, loudly and by name, because the
  // one outcome we will not have is a quiet one.
  let sharesBilled = 0;
  const stampProblems: string[] = [];
  /** Charges this run took BACK, so the totals below do not report them. */
  const rolledBack = new Set<string>();
  for (const c of raised ?? []) {
    const ids = shareIdsByRes.get(c.reservation_id as string);
    if (!ids?.length) continue;
    const { error: stampErr } = await admin
      .from("lot_cost_shares")
      .update({ billed_on_charge_id: c.id })
      .in("id", ids)
      .is("billed_on_charge_id", null);   // never re-stamp one already spent
    if (!stampErr) { sharesBilled += ids.length; continue; }

    console.error(`[runCharges] couldn't stamp ${ids.length} cost share(s) onto charge ${c.id}:`, stampErr);
    // VOIDED_AT AND VOID_REASON TOO. 0070 declares
    // `check (voided_at is null or void_reason is not null)`, and `voidCharge`
    // honours it — it refuses a blank reason with "a cancelled bill needs a
    // reason". Writing only `status` left voided_at NULL, which satisfies that
    // constraint vacuously: a bill marked void with no timestamp and no reason,
    // which is precisely the row the constraint exists to forbid. An accountant
    // reading the ledger later finds a cancelled bill and nothing saying why.
    const { error: voidErr } = await admin
      .from("park_charges")
      .update({
        status: "void",
        voided_at: new Date().toISOString(),
        void_reason:
          "Taken back automatically: the allocated costs on this bill could not be marked as spent, " +
          "and leaving it would have billed those costs again next month.",
      })
      .eq("id", c.id as string);
    if (voidErr) {
      console.error(`[runCharges] and couldn't void charge ${c.id} either:`, voidErr);
      stampProblems.push(
        `One bill went out with allocated costs we couldn't mark as spent, and we couldn't take it back either. ` +
        `Check it before you run next month or that cost will be billed twice.`,
      );
    } else {
      rolledBack.add(c.id as string);
      stampProblems.push(
        `One bill was taken back: we couldn't mark its allocated costs as spent, and billing it would have charged them again next month. Run this again.`,
      );
    }
  }

  // COUNT WHAT SURVIVED, not what was inserted. The loop above voids any charge
  // whose cost shares could not be stamped — a deliberate rollback — but both
  // figures were computed from `rows`, the pre-rollback insert list. The owner
  // was told "19 bills raised — $8,645" for a month where one had just been
  // taken back, and the number he reads is the one he reconciles against.
  const survived = (raised ?? [])
    .filter((r) => !rolledBack.has(r.id as string))
    .map((r) => r.reservation_id as string);
  const keptRows = rolledBack.size === 0
    ? rows
    : rows.filter((r) => survived.includes(r.reservation_id as string));
  const total = keptRows.reduce((s, r) => s + (r.amount as number), 0);
  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    raised: keptRows.length,
    total,
    signal:
      `${keptRows.length} ${keptRows.length === 1 ? "bill" : "bills"} raised for ${prettyMonth(month)} — $${total.toFixed(2)}.` +
      (sharesBilled > 0
        ? ` ${sharesBilled} cost ${sharesBilled === 1 ? "share" : "shares"} you'd allocated went onto those bills.`
        : "") +
      (rateMoves.applied > 0
        ? ` ${rateMoves.applied} rent ${rateMoves.applied === 1 ? "increase" : "increases"} came due today and went in first.`
        : "") +
      " Nobody has been told." +
      (stampProblems.length > 0 ? ` ⚠️ ${stampProblems.join(" ")}` : ""),
  };
}

/** Record money that arrived. Cash and check are the normal case. */
export async function recordPayment(
  parkId: string,
  chargeId: string,
  amount: number,
  method: "cash" | "check" | "card" | "ach" | "transfer" | "other",
  reference: string,
  receivedOn: string,
  /** The serial off the slip they dropped in the box, when that is how it came. */
  dropSlipNo?: string,
  /**
   * Minted once when the form opens, so a double-tapped submit — or a retry
   * after a flaky connection at the office window — collides on 0081's unique
   * index instead of recording the money twice and burning two receipt
   * numbers. A genuinely second payment comes from a new form and a new key.
   */
  idempotencyKey?: string,
): Promise<ParkResult & { receipt?: ReceiptLines; renterEmail?: string | null }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "That payment amount isn't a number." };
  }
  // 0102 put a sanity window on `received_on` — a mistyped year moves income
  // into another tax year and nobody finds out until an accountant does. This
  // form had no date check at all, so the database's refusal would have
  // surfaced as the anonymous "Couldn't record that — try again" below,
  // forever, with no clue which field was wrong.
  const dateBad = paymentDateProblem(receivedOn, todayLakeDate());
  if (dateBad) return { ok: false, error: dateBad };

  const admin = createServiceClient();
  // Confirm the charge belongs to this park before writing against it.
  const chargeRes = await admin
    .from("park_charges").select("id, park_id, renter_id, amount, paid_total, status")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  // "That bill isn't here" is an assertion about his own ledger, told at the
  // window with the cash already in hand. Never say it because a read failed.
  if (chargeRes.error) {
    return { ok: false, error: readFailedMessage("that bill", chargeRes.error, { money: true }) };
  }
  const charge = chargeRes.data;
  if (!charge) return { ok: false, error: "That bill isn't here." };
  if (charge.status === "void") {
    return { ok: false, error: "That bill was cancelled — record it against a live one." };
  }

  // The insert returns the receipt number the trigger assigned, so the renter
  // can walk away with proof of what they just handed over.
  // Minted here, not when a receipt is sent: there is no bank in the middle of
  // these lakes and nothing external will ever validate this record, so the
  // renter's own confirmation is the only second party there will ever be. The
  // token exists from the moment the payment does.
  const confirmToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().slice(0, 8);

  const { data: written, error } = await admin.from("park_payments").insert({
    charge_id: chargeId,
    // 0102 made `park_id` NOT NULL so money with no charge still knows which
    // park it belongs to. This insert derived the park by joining through the
    // charge and never carried it — without these two lines every payment
    // recorded at the window would fail on a not-null violation.
    park_id: parkId,
    // Whose money it is. The first question anybody asks in a dispute, and it
    // was only answerable by walking charge -> renter.
    renter_id: (charge.renter_id as string) ?? null,
    amount,
    method,
    reference: reference.trim() || null,
    received_on: receivedOn,
    drop_slip_no: dropSlipNo?.trim() || null,
    confirm_token: confirmToken,
    idempotency_key: idempotencyKey?.trim() || null,
  }).select("receipt_no, fee_amount").single();
  if (error) {
    // 23505 on the idempotency index = this exact submit already landed. That
    // is a success from the office's point of view, not a failure — telling
    // them it failed is how the same money gets entered a second time.
    if (error.code === "23505") {
      return { ok: false, error: "That payment is already recorded — check the ledger before entering it again." };
    }
    return { ok: false, error: "Couldn't record that — try again." };
  }

  // THE BALANCE ON THE PIECE OF PAPER THEY WALK AWAY WITH.
  //
  // This used to be computed from the snapshot read BEFORE the insert, so a
  // payment landing in between printed a "still owing" figure that was already
  // wrong — on the only copy the renter keeps. Re-read after the trigger has
  // recomputed the total.
  // THE MONEY IS ALREADY RECORDED, so a failed read here must not fail the
  // action — telling the office it failed is how the same cash gets keyed
  // twice. It degrades to the pre-insert arithmetic, which is right in the
  // ordinary case, and the failure is logged so its rate is knowable.
  const afterRes = await admin
    .from("park_charges").select("amount, paid_total").eq("id", chargeId).maybeSingle();
  if (afterRes.error) console.error("[read failed] the bill's new balance:", afterRes.error);
  const after = afterRes.data;
  const balance = after
    ? Number(after.amount) - Number(after.paid_total)
    : Number(charge.amount) - Number(charge.paid_total) - amount;

  // Everything the receipt needs, gathered once here rather than by a second
  // round trip from the screen.
  // Same rule as the balance above: the payment exists, so these four reads
  // degrade rather than refuse. Each one is logged — a receipt that says "This
  // park" and lot "?" is a receipt worth knowing about.
  const [parkRes, fullRes] = await Promise.all([
    admin.from("parks").select("name, address").eq("id", parkId).maybeSingle(),
    admin
      .from("park_charges")
      .select("period_month, amount, park_lot_id, renter_id")
      .eq("id", chargeId)
      .maybeSingle(),
  ]);
  if (parkRes.error) console.error("[read failed] the park's name for the receipt:", parkRes.error);
  if (fullRes.error) console.error("[read failed] the bill behind the receipt:", fullRes.error);
  const park = parkRes.data;
  const full = fullRes.data;
  const [lotRes, renterRes] = await Promise.all([
    full?.park_lot_id
      ? admin.from("park_lots").select("lot_number").eq("id", full.park_lot_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    full?.renter_id
      ? admin.from("park_renters").select("display_name, email, contact_pref")
          .eq("id", full.renter_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (lotRes.error) console.error("[read failed] the lot number for the receipt:", lotRes.error);
  if (renterRes.error) console.error("[read failed] who the receipt is for:", renterRes.error);
  const lot = lotRes.data;
  const renter = renterRes.data;

  const receipt: ReceiptLines = {
    parkName: (park?.name as string) ?? "This park",
    officeLine: park?.address
      ? `Questions? The office — ${park.address}.`
      : "Questions? Ask at the office.",
    receiptNo: (written?.receipt_no as number) ?? null,
    // Always null on this path — the office keying a card at the window does
    // not surcharge, only the resident's own online payment does. Read back
    // from the row anyway rather than hard-coded, so the receipt tells the
    // truth if that ever stops being so.
    feeAmount: written?.fee_amount == null ? null : Number(written.fee_amount),
    lotNumber: (lot?.lot_number as string) ?? "?",
    payerName: (renter?.display_name as string) ?? null,
    amount,
    method,
    reference: reference.trim() || null,
    receivedOn,
    periodMonth: (full?.period_month as string) ?? "",
    billAmount: Number(full?.amount ?? charge.amount),
    balanceAfter: Math.round(balance * 100) / 100,
    confirmUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/paid/${confirmToken}`,
  };

  revalidatePath("/park/rent");
  return {
    ok: true,
    receipt,
    // A paper household cannot be emailed one. Say which it is so the screen
    // offers the right thing rather than pretending both work.
    renterEmail: (renter?.contact_pref as string) === "paper"
      ? null
      : ((renter?.email as string) ?? null),
    signal: balance > 0
      ? `Recorded. $${balance.toFixed(2)} still outstanding.`
      : balance < 0
        ? `Recorded. They're $${Math.abs(balance).toFixed(2)} in credit.`
        : "Recorded — that one's settled.",
  };
}

/** Email a receipt to a renter who has an address and wants to be emailed. */
export async function emailReceipt(
  parkId: string,
  to: string,
  receipt: ReceiptLines,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "That isn't an email address." };
  }
  const body = receiptBody(receipt);
  const res = await sendEmail({
    to,
    subject: `${receipt.parkName} — receipt for $${receipt.amount.toFixed(2)}`,
    text: body,
    html: `<pre style="font:14px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap">${
      body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }</pre>`,
  });
  if (res?.ok === false) return { ok: false, error: "That didn't send — check the address." };
  return { ok: true, signal: "Receipt sent." };
}

/**
 * Serials for a sheet of drop slips, and the counter advanced past them.
 *
 * Advancing BEFORE the paper exists is deliberate: re-issuing a serial destroys
 * the only property that makes a slip evidence, and wasting a few numbers on a
 * jammed printer costs nothing.
 */
export async function takeDropSlipSerials(
  parkId: string,
  count: number,
): Promise<{ ok: boolean; error?: string; from?: number; parkName?: string; officeLine?: string }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return { ok: false, error: "Print between 1 and 200 slips." };
  }

  const admin = createServiceClient();
  const parkRes = await admin
    .from("parks").select("name, address, next_drop_slip_no").eq("id", parkId).maybeSingle();
  // A failed read would both tell him his own park isn't here AND, if it got
  // past that, restart the serial run at 1 — re-issuing numbers already on
  // paper, which is the one property that makes a slip evidence.
  if (parkRes.error) {
    return { ok: false, error: readFailedMessage("your park", parkRes.error) };
  }
  const park = parkRes.data;
  if (!park) return { ok: false, error: "That park isn't here." };

  const from = (park.next_drop_slip_no as number) ?? 1;
  const { error } = await admin
    .from("parks").update({ next_drop_slip_no: from + count }).eq("id", parkId);
  if (error) return { ok: false, error: "Couldn't reserve those numbers — try again." };

  revalidatePath("/park/rent");
  return {
    ok: true,
    from,
    parkName: (park.name as string) ?? "This park",
    officeLine: park.address ? `The office — ${park.address}.` : "The office.",
  };
}

/** Cancel a bill that should never have been raised. Requires a reason. */
export async function voidCharge(
  parkId: string,
  chargeId: string,
  reason: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!reason.trim()) {
    // The database refuses it too. A cancelled bill with no reason is a hole
    // in the ledger somebody has to explain a year later.
    return { ok: false, error: "Say why — a cancelled bill needs a reason." };
  }

  const admin = createServiceClient();

  // A BILL YOU HAVE TAKEN MONEY FOR IS NOT A BILL YOU CAN CANCEL.
  //
  // "Cancel this bill" sits next to "Record it" on the rent screen, so this is
  // a mis-tap away. Cancelling a paid bill drops that cash out of every total
  // while it is sitting in the bank. 0072 refuses it in the database too; this
  // is the sentence he should see instead of an error code.
  const existingRes = await admin
    .from("park_charges").select("paid_total")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  // FAILS OPEN IF SWALLOWED. `existing` comes back null on a failed read, the
  // `existing &&` below is false, and the guard the paragraph above exists for
  // is simply skipped. 0072 still refuses it in the database, so the cash is
  // safe — but he would get "Couldn't cancel that — try again" forever instead
  // of the sentence explaining why.
  if (existingRes.error) {
    return { ok: false, error: readFailedMessage("what's been paid against that bill", existingRes.error, { money: true }) };
  }
  const existing = existingRes.data;
  if (existing && Number(existing.paid_total) > 0) {
    return {
      ok: false,
      error:
        `You've already taken $${Number(existing.paid_total).toFixed(2)} against this bill. ` +
        `Cancelling it would make that money disappear from your totals while it's ` +
        `still in the bank — sort the payment out first.`,
    };
  }

  const { error } = await admin
    .from("park_charges")
    .update({ status: "void", voided_at: new Date().toISOString(), void_reason: reason.trim() })
    .eq("id", chargeId)
    .eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't cancel that — try again." };

  // RELEASE THE COST SHARES THIS BILL WAS CARRYING (0104).
  //
  // A voided charge leaves its month billable again — that is the whole point
  // of the void filter in the run. If the water shares stayed stamped to a
  // cancelled bill they would never reach anybody: the owner would cancel one
  // wrong bill and silently lose that household's share of a bill the park
  // has genuinely paid. Same lesson 0101 learned about a voided month.
  const releasedRes = await admin
    .from("lot_cost_shares")
    .update({ billed_on_charge_id: null })
    .eq("billed_on_charge_id", chargeId)
    .select("id");
  // The bill IS cancelled by this point, so this cannot refuse. A failure
  // leaves the shares stamped to a dead charge — money that reaches nobody —
  // so it is logged rather than swallowed, and the signal below says "0".
  if (releasedRes.error) {
    console.error("[read failed] the cost shares on that bill:", releasedRes.error);
  }
  const n = releasedRes.data?.length ?? 0;

  revalidatePath("/park/rent");
  revalidatePath("/park/costs");
  return {
    ok: true,
    signal: n > 0
      ? `Cancelled. ${n} cost ${n === 1 ? "share is" : "shares are"} waiting again for the next bill.`
      : "Cancelled.",
  };
}

/**
 * The renter's open assertion against a charge, carried to the screen so it
 * can be answered. `id` is the whole point — without it the owner can see that
 * somebody disagrees and has no way to say what they found.
 */
export interface OpenClaim {
  id: string;
  charge_id: string;
  claimed_amount: number | null;
  claimed_paid_on: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  asserted_by: string;
  /**
   * WHO THEY SAY THEY PAID. Collected on the claim form and written since it
   * shipped, and selected by nothing — so the screen that decides the claim
   * could not see it. In a takeover month "I paid Ron" is the single most
   * likely thing a household says, and it is the whole explanation.
   */
  paid_to: string | null;
}
type RawClaim = OpenClaim;

export interface LedgerPage {
  month: string;
  rows: LedgerRow[];
  /** Unanswered claims on this month's charges, keyed by charge id. */
  claims: Record<string, OpenClaim>;
  summary: LedgerSummary;
  lagDays: number;
  today: string;
}

export async function getLedger(parkId: string, month?: string): Promise<LedgerPage | null> {
  if (!(await assertMyPark(parkId))) return null;
  const admin = createServiceClient();
  const today = todayLakeDate();
  const period = month ?? currentPeriod(today);

  // EVERY READ BELOW EITHER ANSWERS OR THROWS. This loader returns `null` to
  // mean "you don't manage that park"; a swallowed failure would render an
  // empty rent roll — no bills, nobody late, nobody disputing — which is the
  // calmest possible lie about a month's money.
  const park = mustRead(
    "your park's settings",
    await admin
      .from("parks").select("office_recording_lag_days").eq("id", parkId).maybeSingle(),
  );
  const lagDays = (park?.office_recording_lag_days as number) ?? 3;

  const data = mustRead(
    "this month's bills",
    await admin
      .from("park_charges")
      .select("id, park_lot_id, renter_id, period_month, due_on, amount, paid_total, status")
      .eq("park_id", parkId)
      .eq("period_month", period),
  );

  // UNANSWERED "I PAID THIS" claims. A charge carrying one is disputed, not
  // late — the two parties disagree, and disagreement is a question rather
  // than a delinquency.
  const chargeIds = (data ?? []).map((c) => c.id as string);
  // The claim's OWN id comes back, and what they actually said. Without the id
  // there is nothing to resolve — which is why `resolvePaymentClaim` sat
  // written, careful and tested, with no caller: the screen had no handle on
  // the thing it was being asked to close.
  // A swallowed failure here downgrades every disputed row to plain 'late', so
  // households who have told the office they paid get chased on our word.
  const claims = chargeIds.length
    ? mustRead(
        "what households have told you about paying",
        await admin
          .from("park_payment_claims")
          .select("id, charge_id, claimed_amount, claimed_paid_on, method, reference, note, asserted_by, paid_to")
          .in("charge_id", chargeIds)
          .is("resolved_at", null),
      )
    : ([] as RawClaim[]);
  const openClaims = (claims ?? []) as unknown as RawClaim[];
  const claimed = new Set(openClaims.map((c) => c.charge_id));
  const claimByCharge = new Map(openClaims.map((c) => [c.charge_id, c]));

  const lotIds = [...new Set((data ?? []).map((c) => c.park_lot_id as string))];
  const renterIds = [...new Set((data ?? []).map((c) => c.renter_id as string).filter(Boolean))];

  const [lotsRes, rentersRes] = await Promise.all([
    lotIds.length
      ? admin.from("park_lots").select("id, lot_number").in("id", lotIds)
      : Promise.resolve({ data: [] as { id: string; lot_number: string }[], error: null }),
    renterIds.length
      ? admin.from("park_renters").select("id, display_name").in("id", renterIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[], error: null }),
  ]);
  // Without these the roll renders every row as lot "?" with no name on it.
  const lots = mustRead("your lots", lotsRes);
  const renters = mustRead("the households", rentersRes);

  const lotName = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  const charges: Charge[] = (data ?? []).map((c) => ({
    id: c.id as string,
    lotNumber: lotName.get(c.park_lot_id as string) ?? "?",
    renterName: renterName.get(c.renter_id as string) ?? null,
    periodMonth: c.period_month as string,
    dueOn: c.due_on as string,
    amount: Number(c.amount),
    paidTotal: Number(c.paid_total),
    status: c.status as Charge["status"],
  }));

  const rows = toRows(charges, today, lagDays, claimed)
    // Late first — it is the only part that needs him today.
    .sort((a, b) => {
      // Disputed first: it is the only row that says we might be wrong.
      const rank = (s: string) =>
        s === "disputed" ? 0 : s === "late" ? 1 : s === "part_paid" ? 2 : s === "due" ? 3 : 4;
      return rank(a.state) - rank(b.state) || a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true });
    });

  return {
    month: period,
    rows,
    claims: Object.fromEntries(claimByCharge),
    summary: summarise(rows),
    lagDays,
    today,
  };
}

// ---------------------------------------------------- the renter's side ----

/**
 * "THEY SAY THEY PAID."
 *
 * The only way the renter's side of a payment ever gets into this system. Most
 * of these arrive over a counter or on the phone, so the office logs them — and
 * `asserted_by: 'renter'` records whose assertion it is, not who typed it.
 *
 * IT DOES NOT MARK THE BILL PAID. It does not move the balance by a cent. What
 * it does is stop the software calling somebody delinquent while the two
 * parties disagree, until a person answers the question on purpose.
 *
 * Logging one must never require agreeing with it. An owner who thinks the
 * renter is mistaken should still record that they said it — that record is
 * what makes the eventual answer defensible.
 */
export async function logPaymentClaim(
  parkId: string,
  chargeId: string,
  input: {
    amount?: string;
    paidOn?: string;
    method?: "cash" | "check" | "card" | "ach" | "transfer" | "other";
    reference?: string;
    /** Whatever name they wrote on it. At a takeover this is the whole answer. */
    paidTo?: string;
    note?: string;
  },
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const chargeRes = await admin
    .from("park_charges").select("id").eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  // Refusing to record what somebody said, on the grounds of a read that never
  // came back, is exactly the silence this function exists to prevent.
  if (chargeRes.error) {
    return { ok: false, error: readFailedMessage("that bill", chargeRes.error) };
  }
  if (!chargeRes.data) return { ok: false, error: "That bill isn't here." };

  // Every detail optional on purpose. "I paid you" with no amount and no date
  // is still the renter's account of events, and demanding a check number
  // before recording anything silences exactly the households least able to
  // produce paperwork.
  const raw = (input.amount ?? "").replace(/[$,\s]/g, "");
  const amount = raw ? Number(raw) : null;
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    return { ok: false, error: "That amount isn't a number." };
  }

  const { error } = await admin.from("park_payment_claims").insert({
    charge_id: chargeId,
    claimed_amount: amount,
    claimed_paid_on: input.paidOn?.trim() || null,
    method: input.method ?? null,
    reference: input.reference?.trim() || null,
    paid_to: input.paidTo?.trim() || null,
    note: input.note?.trim() || null,
    asserted_by: "renter",
    logged_by: await currentUserId(),
  });
  if (error) return { ok: false, error: "Couldn't record that — try again." };

  revalidatePath("/park/rent");
  return {
    ok: true,
    signal: "Noted. They won't be chased or counted as late until you've checked.",
  };
}

/**
 * Answer the question.
 *
 * 'matched' happens on its own the moment a payment is recorded, so the two
 * answers a human gives are "we looked and there's no such payment" and "they
 * withdrew it". The first one leaves somebody owing money on the park's word
 * alone, so the database refuses it without an explanation — the explanation is
 * exactly what a court would ask for.
 */
export async function resolvePaymentClaim(
  parkId: string,
  claimId: string,
  resolution: "not_found" | "withdrawn",
  note: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (resolution === "not_found" && !note.trim()) {
    return {
      ok: false,
      error: "Say what you checked. This one puts them back in arrears on your word alone.",
    };
  }

  const admin = createServiceClient();
  // Scope the claim to this park through its charge before touching it.
  const claimRes = await admin
    .from("park_payment_claims")
    .select("id, charge_id, park_charges!inner(park_id)")
    .eq("id", claimId)
    .maybeSingle();
  if (claimRes.error) {
    return { ok: false, error: readFailedMessage("that disagreement", claimRes.error) };
  }
  const claim = claimRes.data;
  const owner = (claim as { park_charges?: { park_id?: string } } | null)?.park_charges?.park_id;
  if (!claim || owner !== parkId) return { ok: false, error: "That isn't here." };

  const { error } = await admin
    .from("park_payment_claims")
    .update({
      resolved_at: new Date().toISOString(),
      resolution,
      resolution_note: note.trim() || null,
      resolved_by: await currentUserId(),
    })
    .eq("id", claimId);
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  // Today carries a "somebody disagrees" card that has no dismiss of its own —
  // answering the claim IS the dismissal, so that screen has to be rebuilt too.
  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
  return {
    ok: true,
    signal: resolution === "not_found"
      ? "Recorded. That bill is back in arrears."
      : "Recorded.",
  };
}

/**
 * "YES — I COLLECTED IT." THE THIRD ANSWER, AND THE ONLY HAPPY ONE.
 *
 * The claim screen shipped with two endings, both of them bad news: "there's no
 * such payment" and "they took it back". The ordinary case — the resident is
 * right, the cash is in the drawer — had no button on the claim at all. It was
 * reachable, but only by leaving this form, finding the Record-payment button
 * and typing the amount and date again from memory. The affirmative answer was
 * the slowest one, which is backwards.
 *
 * IT IS THE CONFIRMATION THAT MOVES THE MONEY, AND ONLY IT. LakeLife handles no
 * cash: the resident says they paid, and nothing is credited, no receipt number
 * is minted and the accountant's income figure does not move until the person
 * who actually took the money says they took it. That is the whole two-sided
 * record — one statement from each side, and the ledger only believes both.
 *
 * This writes an ordinary payment through `recordPayment`, so the receipt
 * number, the date sanity window and the idempotency index all apply unchanged,
 * and 0074's trigger closes the claim as `matched` on the insert — "it closes
 * the disagreement by conceding it, not by overruling it."
 */
export async function confirmClaimCollected(
  parkId: string,
  claimId: string,
  /** Prefilled from the claim, editable — he may have been handed less. */
  amount: number,
  receivedOn: string,
  idempotencyKey?: string,
): Promise<ParkResult & { receipt?: ReceiptLines; renterEmail?: string | null }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  // Scope the claim to this park through its charge, the same join
  // resolvePaymentClaim uses.
  const claimRes = await admin
    .from("park_payment_claims")
    .select("id, charge_id, method, reference, resolved_at, park_charges!inner(park_id)")
    .eq("id", claimId)
    .maybeSingle();
  // This is the answer that MOVES THE MONEY, and every check below it — whose
  // claim it is, whether it is already answered, which rail it came in on —
  // reads off this one row. A failed read must not reach any of them.
  if (claimRes.error) {
    return { ok: false, error: readFailedMessage("that disagreement", claimRes.error, { money: true }) };
  }
  const claim = claimRes.data;
  const owner = (claim as { park_charges?: { park_id?: string } } | null)?.park_charges?.park_id;
  if (!claim || owner !== parkId) return { ok: false, error: "That isn't here." };
  if (claim.resolved_at) return { ok: false, error: "That one's already been answered." };

  // A claim can name any method, but the two that settle through a processor
  // cannot be confirmed by hand — 0108 refuses a card or ACH row with no
  // reference, and a confirmation is not where a processor reference comes
  // from. Say so plainly rather than letting the database's refusal surface as
  // "couldn't record that".
  const claimed = (claim.method as string) ?? "cash";
  if ((claimed === "card" || claimed === "ach") && !(claim.reference as string)?.trim()) {
    return {
      ok: false,
      error: "That one came in on a card or bank rail — record it from the payment form with its reference.",
    };
  }
  const method = claimed as Parameters<typeof recordPayment>[3];

  return recordPayment(
    parkId,
    claim.charge_id as string,
    amount,
    method,
    (claim.reference as string) ?? "",
    receivedOn,
    undefined,
    idempotencyKey,
  );
}

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * TAKING BACK A PAYMENT THAT SHOULDN'T HAVE BEEN RECORDED.
 *
 * A transposed digit and a bounced check are the same shape, and until now
 * both were permanent: `recordPayment` was the only write to `park_payments`,
 * 0070 forbids a zero or negative amount so a compensating row is impossible,
 * and 0072 refuses to void a charge that has money against it. Type $4,395
 * instead of $439.50 and that household is unfixably in credit forever — while
 * the printed receipt promises "the bill goes back to outstanding".
 *
 * THE ROW IS NOT DELETED. It keeps its receipt number and its place in the
 * sequence, and gains a reason and a timestamp. This ledger exists because a
 * payment is something two people were there for; quietly erasing the record
 * of one is the opposite of the point. What changes is that 0081's
 * `sync_charge_paid` stops counting it, so the balance tells the truth again.
 *
 * The reason is required by the database, not just by this function. A
 * reversal moves money against somebody, and "it was wrong" with no
 * explanation is indistinguishable from an office covering a mistake.
 */
export async function reversePayment(
  parkId: string,
  paymentId: string,
  reason: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const why = reason.trim();
  if (!why) {
    return { ok: false, error: "Say what happened — a bounced check, a typo. The record has to carry the reason." };
  }
  if (why.length > 500) return { ok: false, error: "That's a bit long — a sentence is plenty." };

  const admin = createServiceClient();

  // SCOPE BY THE PARK ON THE PAYMENT, not through the charge.
  //
  // This used to read `park_charges!inner(park_id)`, and an INNER join drops
  // any row whose charge_id is NULL — which since 0102 is every deposit and
  // every cheque taken before the bill existed. So money recorded by mistake
  // at the window could never be taken back, and the office was told "That
  // isn't here" about a payment sitting on their own screen.
  const payRes = await admin
    .from("park_payments")
    .select("id, amount, receipt_no, reversed_at, park_id, kind, charge_id, method")
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .maybeSingle();
  // "That isn't here" about a payment sitting on their own screen is the exact
  // complaint the paragraph above was written to fix — do not reintroduce it
  // through a dropped connection.
  if (payRes.error) {
    return { ok: false, error: readFailedMessage("that payment", payRes.error, { money: true }) };
  }
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "That isn't here." };
  if (pay.reversed_at) return { ok: false, error: "That one's already been taken back." };

  // A REVERSAL IS NOT A REFUND, AND THIS IS WHERE THE TWO USED TO BE CONFUSED.
  //
  // Reversing says the money never arrived. For a cheque that bounced that is
  // exactly right. For a card or ACH payment the money demonstrably DID arrive
  // — 0108 will not even record one without a processor reference — so this
  // path would tell the office "$542.53 taken back" while the cardholder's
  // statement still showed the charge. 0142 makes the database refuse it; this
  // says so in a sentence rather than as a constraint name.
  if (pay.method === "card" || pay.method === "ach") {
    return {
      ok: false,
      error: "That was paid by card, so the money really did arrive — reversing it would only change our record. Refund it instead and it goes back to their card.",
    };
  }

  // A DEPOSIT ALREADY GIVEN BACK CANNOT BE UNSAID. Reversing means "this never
  // happened", and the money demonstrably did go back out — leaving a
  // returned_amount on a reversed row would be the ledger holding two
  // contradictory facts about the same cash.
  if (pay.kind === "deposit") {
    const depRes = await admin
      .from("park_payments").select("returned_on").eq("id", paymentId).maybeSingle();
    // FAILS OPEN IF SWALLOWED. `dep?.returned_on` on a failed read is
    // undefined, the guard falls through, and a deposit that has demonstrably
    // gone back to the household gets reversed — the ledger then holding two
    // contradictory facts about the same cash, which is what this refuses.
    if (depRes.error) {
      return { ok: false, error: readFailedMessage("whether that deposit was already returned", depRes.error, { money: true }) };
    }
    const dep = depRes.data;
    if (dep?.returned_on) {
      return { ok: false, error: "That deposit was already returned — reversing it would contradict the record." };
    }
  }

  const { error } = await admin
    .from("park_payments")
    .update({
      reversed_at: new Date().toISOString(),
      reversed_reason: why,
      reversed_by: await currentUserId(),
    })
    .eq("id", paymentId)
    .is("reversed_at", null); // never reverse twice
  if (error) return { ok: false, error: "Couldn't record that — try again." };

  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
  const amount = Number(pay.amount ?? 0);
  return {
    ok: true,
    signal:
      `$${amount.toFixed(2)} taken back${pay.receipt_no ? ` (receipt ${pay.receipt_no})` : ""}. ` +
      // Money with no charge has no bill to become outstanding again — saying
      // it does would send somebody looking for a balance that never moved.
      (pay.charge_id
        ? "The bill is outstanding again, and the record shows why."
        : pay.kind === "deposit"
          ? "That deposit is no longer held, and the record shows why."
          : "It's off the household's account, and the record shows why."),
  };
}

/** What is still refundable on a payment, and why it might not be. */
export interface RefundableState {
  /** Rent still sendable back, in dollars. */
  amount: number;
  /** Card surcharge still sendable back, in dollars. */
  fee: number;
  /** Null when a refund is possible; otherwise the sentence saying why not. */
  refusal: string | null;
}

/**
 * HOW MUCH OF THIS PAYMENT COULD STILL GO BACK.
 *
 * Derived every time from the refunds actually recorded, never stored on the
 * payment. A `refunded_total` column would be a second answer to a question
 * the rows already answer, and this codebase keeps finding that exact shape as
 * a bug — a number some writers update and others forget.
 */
export async function refundableOn(parkId: string, paymentId: string): Promise<RefundableState | { error: string }> {
  if (!(await assertMyPark(parkId))) return { error: DENIED };
  const admin = createServiceClient();

  const payRes = await admin
    .from("park_payments")
    .select("id, amount, fee_amount, method, reference, reversed_at")
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .maybeSingle();
  if (payRes.error) return { error: readFailedMessage("that payment", payRes.error, { money: true }) };
  const pay = payRes.data;
  if (!pay) return { error: "That isn't here." };

  const givenRes = await admin
    .from("park_refunds")
    .select("amount, fee_amount")
    .eq("payment_id", paymentId);
  // A FAILED READ HERE IS NOT "NOTHING REFUNDED YET". Treating it as zero
  // would offer the whole payment back a second time, which is the one
  // arithmetic mistake that costs real money.
  if (givenRes.error) {
    return { error: readFailedMessage("what has already been refunded", givenRes.error, { money: true }) };
  }
  const rows = (givenRes.data ?? []) as { amount: number | null; fee_amount: number | null }[];
  const left = remainingRefundable(pay as never, rows);
  return { ...left, refusal: refundRefusal(pay as never, left) };
}

/**
 * SEND MONEY BACK TO THE CARD IT CAME FROM.
 *
 * The other half of the pair `reversePayment` had been doing alone. A reversal
 * corrects OUR record; this moves real money outward through the processor
 * that took it, and only then writes the record.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS REFUND FIRST, RECORD SECOND, AND IT IS NOT ARBITRARY.
 *
 * The two are not one transaction and cannot be — a processor call is a
 * network round trip and Postgres cannot roll it back. So one of the two
 * failure shapes has to be chosen deliberately:
 *
 *   Record first: a filed refund that never actually reached the card. The
 *   ledger says the household got their money and they did not. Nobody finds
 *   out until they ring, and the screen contradicts them.
 *
 *   Refund first: money that reached the card and was not filed. The household
 *   is whole; our ledger is short a row; the processor reference is in the
 *   error message and the office can file it by hand.
 *
 * The second is recoverable and the first is not, so the money goes first —
 * the same reasoning, and the same failure sentence, as `payRent`.
 *
 * ---------------------------------------------------------------------------
 * THE SURCHARGE IS ASKED FOR, NEVER ASSUMED. `feeAmount` arrives from the
 * office. A default would be this code deciding a money policy nobody set, and
 * 0142's header explains why the database has no column for one either.
 *
 * The PROCESSOR is asked for one refund of rent + fee together, because that
 * is how the money left: `payRent` charged `owed + fee` as a single charge and
 * the reference points at that. The two are only separate on our row.
 */
export async function refundParkPayment(
  parkId: string,
  paymentId: string,
  input: { amount: number; feeAmount: number; reason: string; idempotencyKey: string },
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const why = (input.reason ?? "").trim();
  if (!why) {
    return { ok: false, error: "Say why the money is going back — the record has to carry the reason." };
  }
  if (why.length > 500) return { ok: false, error: "That's a bit long — a sentence is plenty." };
  if (!String(input.idempotencyKey ?? "").trim()) {
    // Minted when the form opens. Without it a double-tapped submit is two
    // refunds, and the processor has no way to know they are the same one.
    return { ok: false, error: "Couldn't start that safely — reopen the refund and try again." };
  }

  const state = await refundableOn(parkId, paymentId);
  if ("error" in state) return { ok: false, error: state.error };
  if (state.refusal) return { ok: false, error: state.refusal };

  const amount = Math.round(Number(input.amount) * 100) / 100;
  const feeAmount = Math.round(Number(input.feeAmount ?? 0) * 100) / 100;
  const wrong = refundAmountRefusal(amount, feeAmount, state);
  if (wrong) return { ok: false, error: wrong };

  const admin = createServiceClient();
  const refRes = await admin
    .from("park_payments")
    .select("reference, charge_id")
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .maybeSingle();
  if (refRes.error) return { ok: false, error: readFailedMessage("that payment", refRes.error, { money: true }) };
  const chargeRef = String(refRes.data?.reference ?? "").trim();
  if (!chargeRef) return { ok: false, error: "That payment has no processor reference to refund against." };

  const done = await giveRefund({ chargeRef, amountCents: refundCents(amount, feeAmount) });
  if (!done.ok || !done.ref) {
    return {
      ok: false,
      error: `The processor wouldn't return that${done.error ? ` — ${done.error}` : ""}. Nothing has moved and nothing has been recorded.`,
    };
  }

  const { error } = await admin.from("park_refunds").insert({
    payment_id: paymentId,
    park_id: parkId,
    amount,
    fee_amount: feeAmount,
    reason: why,
    processor_ref: done.ref,
    idempotency_key: input.idempotencyKey,
    created_by: await currentUserId(),
  });
  if (error) {
    // 23505 = the idempotency index. The twin submit already filed this exact
    // refund, so the money went back once and is recorded once. Saying it
    // failed would invite a third attempt.
    if ((error as { code?: string }).code === "23505") {
      return { ok: true, signal: `$${(amount + feeAmount).toFixed(2)} is on its way back.` };
    }
    // Money left and the ledger did not record it. Recoverable, but only if
    // the reference reaches a person — so it goes in the sentence.
    return {
      ok: false,
      error: `The refund went through (${done.ref}) but we couldn't file it. Write that reference down and ring the office — do not refund again.`,
    };
  }

  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
  return { ok: true, signal: refundSignal(amount, feeAmount, Boolean(refRes.data?.charge_id)) };
}
