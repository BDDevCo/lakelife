"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { COST_CATEGORY_LABEL, type CostCategory , costAnswersBill, type Cadence, type BillPeriod} from "./cost-helpers";
import { todayLakeDate, lakeDateOf } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { firstBillablePeriod } from "@/lib/billing-start";
import {
  toRows, summarise, currentPeriod,
  type Charge, type LedgerRow, type LedgerSummary,
} from "./ledger-helpers";
import { summariseReceipts, customPeriod, type Receipt, type Method } from "./receipts-helpers";
import {
  moneyBlock, occupancyLine, generateTasks, visibleTasks, quietState, householdsIn, holdoverLotsOf, lotOccupancy,
  oldestUnansweredBill,
  type MoneyBlock, type Task, type TaskState,
} from "./today-helpers";
import { getHeldMoney } from "./money-actions";
// A day a person reads is words — the snooze toast said "Back on 2027-02-01".
import { dayInWords } from "./park-helpers";
// THE READINESS LIST AND THE FIRST-RUN CARD: derived from the rows this loader
// already holds plus a handful of light reads (readinessExtras). The
// pre-cutover checklist this replaces read only when a takeover day was set
// and in the future — so a park with no takeover day never saw it.
import {
  readinessFactsFrom, readinessFor, readinessHeadline, showReadinessOnToday, firstRunCard, firstRunTaskKey,
  type ReadinessRow, type FirstRunCard,
} from "./readiness";
import { readinessExtras } from "./readiness-data";
import { crewsOnSite, UNASSIGNED_CREW } from "./visits-helpers";
import { latestSeqByChain } from "./agreement-helpers";
import { livenessLine, lastNightsFindings, type RunRow, type LivenessLine } from "./machine-helpers";
import { mustRead } from "@/lib/must-read";
import type { ParkResult } from "./actions";

/**
 * THE MORNING SCREEN — read-only.
 *
 * Every number here is a ROLL-UP of something another screen owns. /park/rent
 * still owns every write; Today never records anything, and every button
 * navigates. That rule is what stops two screens drifting apart on the meaning
 * of "late".
 *
 * The one thing Today shows that nothing else CAN: arrears from earlier months.
 * `getLedger` is scoped to a single `period_month`, so a June bill still open in
 * August is structurally invisible to it.
 */

const DENIED = "You don't manage that park.";
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface TodayView {
  parkName: string;
  today: string;
  month: string;
  money: MoneyBlock;
  occupancy: { main: string; sub: string | null };
  tasks: Task[];
  notes: { id: string; body: string; createdAt: string }[];
  quiet: { headline: string; checkedLine: string } | null;
  /** The welcome card, while the park is unpublished and has raised no bill; null once it is either, or he has dismissed it. */
  firstRun: FirstRunCard | null;
  /**
   * A takeover day set and strictly in the future. Before it there is no
   * money and no occupancy, so the readiness list stands where the money
   * card would. ON the day the park is his — `>=` held the list up for one
   * morning too many, the morning nineteen bills fell due.
   */
  beforeGoLive: boolean;
  /** The readiness list — non-null before go-live, and whenever the park is unpublished or a required row is undone. */
  readiness: { headline: string; sub: string; rows: ReadinessRow[] } | null;
  /** Distinct crews with a visit in the park today; the line renders only above zero. */
  crewsOnSite: number;
  /**
   * Whether the evening check is actually running.
   *
   * Computed HERE, on page render, from run rows — never sent by the scheduler.
   * An alert that the cron is dead cannot be sent by the cron.
   */
  liveness: LivenessLine;
  /**
   * What last night's check actually found. These were computed nightly and
   * discarded — only the COUNT was stored, into a column nothing read — so an
   * occupied lot with no bill against it was detected every night and shown to
   * nobody, while the screen said "checked last night".
   */
  findings: { kind: string; urgent: boolean; line: string }[];
}

export async function getToday(parkId: string): Promise<TodayView | null> {
  const membership = await assertMyPark(parkId);
  if (!membership) return null;

  const admin = createServiceClient();
  const today = todayLakeDate();
  const month = currentPeriod(today);
  // The widest window any bill cadence can need (0123): a property tax entered
  // in March must still answer November's reminder.
  const year = today.slice(0, 4);
  // And one year wider (0170): a flagged annual bill covers the year BEFORE
  // the one it is due in, so the widest period a reminder can now ask about
  // starts on 1 January of last year.
  const priorYear = String(Number(year) - 1);

  // EVERY READ IN THIS LOADER EITHER ANSWERS OR THROWS. Today is the screen he
  // opens with coffee, and every branch below has a calm empty-case sentence
  // written for the day nothing is happening: "Your park", "$0 owed",
  // "nothing needs you", "the evening check hasn't run". A swallowed failure
  // reaches all of them at once and the morning looks quiet.
  const park = mustRead(
    "your park",
    await admin
      .from("parks")
      // The readiness list's columns ride on the same read: published,
      // the lake, the pin, the hold, the online-rent switch.
      .select("name, rent_due_day, office_recording_lag_days, max_agreement_months, cutover_date, active, lake_id, lat, lng, notices_held_at, accepts_online_rent")
      .eq("id", parkId)
      .maybeSingle(),
  );
  const parkName = (park?.name as string) ?? "Your park";
  const lagDays = (park?.office_recording_lag_days as number) ?? 3;
  const rentDueDay = (park?.rent_due_day as number) ?? 1;
  const cutoverOn = (park?.cutover_date as string) ?? null;

  // HOW FAR BACK A MISSED BILL IS STILL ASKED ABOUT.
  //
  // The recurring-bill reminder used to look at TODAY's period alone, so a
  // bill he never entered stopped being mentioned the moment its period
  // rolled. It walks back now (oldestUnansweredBill), and a walk needs a
  // floor: the first period that is ours, and no further back than the costs
  // this loader actually reads — a period whose costs were never fetched
  // cannot be judged entered or not, and guessing would put a permanent card
  // on his screen for a bill that is sitting in the books.
  const firstOurs = firstBillablePeriod(cutoverOn);
  const goLiveFloor = firstOurs ? `${firstOurs}-01` : null;
  // The costs read is widened to match, so the walk is exact for any park
  // with a go-live date — which is every park that changed hands.
  const costsFrom = goLiveFloor && goLiveFloor < `${priorYear}-01-01`
    ? goLiveFloor
    : `${priorYear}-01-01`;

  // ---- lots and who is on them -------------------------------------------
  const lots = mustRead(
    "your lots",
    await admin
      .from("park_lots")
      // `active` is the "In service" switch — the column the publish gate
      // counts, so the readiness list can say when every lot is off.
      .select("id, lot_number, lifecycle, active")
      .eq("park_id", parkId),
  );
  const liveLots = (lots ?? []).filter((l) => (l.lifecycle as string) === "live");
  const liveIds = liveLots.map((l) => l.id as string);
  const lotName = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));

  // THE ENDED ROWS COME TOO — read once, then split. A household closed out
  // of its successor leaves the expired link before it approved/active, run
  // out, with nothing held after it: the lapsed shape, unless the close-out
  // is seen. Everything below that lists agreements, notices or holdovers
  // reads `stays` (held rows only, as before); the ended rows reach only the
  // two facts that must see them — whether a lot is lapsed (lapsedRowOf) and
  // whether a chain already has a later link (`chains`).
  const everyRow = liveIds.length
    ? mustRead(
        "who's on your lots",
        await admin
          .from("lot_reservations")
          .select("id, park_lot_id, renter_id, during, status, origin, agreement_chain_id, agreement_seq, notice_given_on, expected_move_out, term")
          .in("park_lot_id", liveIds)
          .in("status", ["approved", "active", "ended"]),
      )
    : ([] as Record<string, unknown>[]);
  const stays = (everyRow ?? []).filter((s) => s.status === "approved" || s.status === "active");

  // WHICH LOTS ARE TAKEN — the one copy of the rule (today-helpers
  // lotOccupancy: half-open ranges, a lot counted once across a renewal,
  // lapsed paperwork counted as taken). The readiness list reads the same
  // function, so the two cards on this screen cannot count a lot two ways.
  const occupancy = lotOccupancy(
    (everyRow ?? []).map((s) => ({
      park_lot_id: s.park_lot_id as string,
      during: s.during as string,
      status: s.status as string,
      term: s.term as string,
    })),
    liveLots.map((l) => ({ id: l.id as string, lot_number: l.lot_number as string })),
    today,
  );
  const occupiedLotIds = occupancy.occupiedLotIds;
  const snapshot = occupancy.snapshot;

  // ---- money --------------------------------------------------------------
  const charges = mustRead(
    "the bills you've raised",
    await admin
      .from("park_charges")
      .select("id, park_lot_id, renter_id, period_month, due_on, amount, paid_total, status")
      .eq("park_id", parkId),
  );

  const allIds = (charges ?? []).map((c) => c.id as string);
  // Swallowed, every disputed bill downgrades to plain arrears and lands in
  // the "go and get this" figure.
  const claims = allIds.length
    ? mustRead(
        "what households have told you about paying",
        await admin.from("park_payment_claims").select("charge_id")
          .in("charge_id", allIds).is("resolved_at", null),
      )
    : ([] as { charge_id: string }[]);
  const claimed = new Set((claims ?? []).map((c) => c.charge_id as string));

  const toCharge = (c: Record<string, unknown>): Charge => ({
    id: c.id as string,
    lotNumber: lotName.get(c.park_lot_id as string) ?? "?",
    renterName: null,
    periodMonth: c.period_month as string,
    dueOn: c.due_on as string,
    amount: Number(c.amount),
    paidTotal: Number(c.paid_total),
    status: c.status as Charge["status"],
  });

  const monthRows = toRows(
    (charges ?? []).filter((c) => c.period_month === month).map(toCharge),
    today, lagDays, claimed,
  );
  const monthSummary: LedgerSummary = summarise(monthRows);

  // Older months still open — the part /park/rent cannot see.
  //
  // A DISPUTED BILL IS NOT ARREARS. `toRows` already computes state 'disputed'
  // when a claim is open against a charge, and this filtered on the balance
  // alone — so "they say they paid and we haven't found it" was being counted
  // as money to chase, inflating the one figure on the morning screen that is
  // supposed to mean "go and get this". It is separated out below, where it
  // reads as what it is: something to settle, not something to pursue.
  const olderOpen: LedgerRow[] = toRows(
    (charges ?? [])
      .filter((c) => (c.period_month as string) < month && c.status === "open")
      .map(toCharge),
    today, lagDays, claimed,
  ).filter((r) => r.balance > 0);

  const arrears: LedgerRow[] = olderOpen.filter((r) => r.state !== "disputed");
  const disputedOlder: LedgerRow[] = olderOpen.filter((r) => r.state === "disputed");

  // Cash in, month-to-date and today, off received_on.
  //
  // REVERSED PAYMENTS ARE NOT CASH IN. A bounced check must not sit in the
  // "$X has come in this month" line on the screen he reads with coffee — that
  // is the number he plans against.
  //
  // AND MONEY WITH NO BILL BEHIND IT IS STILL MONEY. This read was keyed on
  // `.in("charge_id", allIds)`, which is every payment attached to a bill and
  // nothing else. `park_payments.charge_id` has been NULLABLE since 0102 — a
  // deposit is required to have none (park_payments_deposit_is_held), amenity
  // income has none, and rent handed over before its bill exists has none
  // until the run picks it up. All of it was invisible here.
  //
  // So the screen he reads with coffee printed "Nothing has come in yet this
  // month" on a month the office had banked deposits, and the `allIds.length`
  // guard made it worse: before the first charge run of a new park there are
  // no bills at all, so the read was skipped outright and EVERY payment
  // vanished.
  //
  // Keyed on park_id, which 0102 made NOT NULL on this table — so no row can
  // escape it, and the query needs no bills to exist.
  //
  // A payment against a CANCELLED bill (0169: released onto account) stays in receipts — it arrived against that bill; what is still held of it reaches the hand-back card through getHeldMoney below.
  const payments = mustRead(
    "the money that's come in",
    await admin.from("park_payments")
      // returned_on / returned_amount: money handed back across the counter
    // (0168) and deposits given back. `returned_at` is the BANK pulling a
    // payment back and is filtered out below; these two are the office's own
    // hand, and nothing on this screen knew about them.
    .select("id, charge_id, kind, amount, fee_amount, method, reference, received_on, reversed_at, reversed_reason, returned_at, return_code, returned_on, returned_amount")
      .eq("park_id", parkId)
      .is("reversed_at", null)
      // MONEY THE BANK PULLED BACK IS NOT MONEY THAT CAME IN. This screen
      // answers "what have we taken", and 0142 forbids reversing a card or
      // ACH payment — so `reversed_at` alone can never exclude a returned
      // ACH debit, which is the likeliest way this figure goes wrong once
      // the rail is live.
      .is("returned_at", null),
  );

  const chargeById = new Map((charges ?? []).map((c) => [c.id as string, c]));
  // A Receipt is a payment AGAINST A BILL — every label on it (lot, period,
  // bill total, bill status) comes off the charge. The billless rows are
  // summed separately below rather than folded in here with "?" for a lot and
  // "" for a month, which would also double-count them into the total.
  const receipts: Receipt[] = (payments ?? []).filter((p) => p.charge_id != null).map((p) => {
    const c = chargeById.get(p.charge_id as string);
    return {
      paymentId: p.id as string,
      chargeId: p.charge_id as string,
      amountCents: cents(p.amount),
      feeCents: cents(p.fee_amount),
      method: (p.method as Method) ?? "other",
      reference: (p.reference as string) ?? null,
      receivedOn: p.received_on as string,
      reversedAt: (p.reversed_at as string) ?? null,
      reversedReason: (p.reversed_reason as string) ?? null,
      // Always null here — the query above excludes them — but carried so
      // this row is a whole Receipt and the next reader of it is not handed
      // a half-populated one.
      bankReturnedAt: (p.returned_at as string) ?? null,
      returnCode: (p.return_code as string) ?? null,
      lotNumber: lotName.get(c?.park_lot_id as string) ?? "?",
      payerName: null,
      periodMonth: (c?.period_month as string) ?? "",
      chargeAmountCents: cents(c?.amount),
      chargeStatus: (c?.status as Receipt["chargeStatus"]) ?? "open",
      chargeLines: [],
    };
  });

  const monthStart = `${month}-01`;
  const mtd = summariseReceipts(receipts, customPeriod(monthStart, today, today)!);
  const cashToday = summariseReceipts(receipts, customPeriod(today, today, today)!);

  // The billless part, taken off the raw rows because only they carry `kind`
  // — a Receipt is built around a charge and has nowhere to put it.
  const offBook = (payments ?? []).filter((p) => p.charge_id == null);
  const offIn = (from: string, to: string) =>
    offBook.filter((p) => {
      const on = p.received_on as string;
      return on >= from && on <= to;
    });
  const offMonth = offIn(monthStart, today);
  const offToday = offIn(today, today);
  const sumCents = (rows: typeof offBook) =>
    rows.reduce((n, p) => n + cents(p.amount), 0);

  // WHAT WENT BACK OUT, by the day it went. A hand-back (0168) leaves
  // `reversed_at` and `returned_at` null — it is neither a bounce nor a bank
  // return — so every read on this screen counted the money as still in the
  // drawer. On the morning the office recorded "$70.00 handed back on
  // January 27, 2027" Today read "$50.00 came in today" and nothing said the
  // counter was $20.00 down.
  const handedBackIn = (from: string, to: string) =>
    (payments ?? [])
      .filter((p) => {
        const on = (p.returned_on as string | null) ?? null;
        return on != null && on >= from && on <= to;
      })
      .reduce((n, p) => n + cents(p.returned_amount), 0);
  const handedBackMonthCents = handedBackIn(monthStart, today);
  const handedBackTodayCents = handedBackIn(today, today);

  // WHAT IS STILL ON ACCOUNT of the money that arrived this month — the
  // view's `remaining`, the figure the held panel and the household's own
  // screen both sum (0167/0168/0169). Counted at ARRIVAL, the off-book line
  // said "$1,685.06 of that is money on account" beside a held panel reading
  // $1,142.53: the part already put against a bill was counted here and in
  // the rent line at once. Deposits and amenity income are not in the view
  // and are not on account — they keep their own arrival figure.
  const acctRes = await admin
    .from("park_on_account_payments")
    .select("payment_id, remaining, received_on")
    .eq("park_id", parkId)
    .gt("remaining", 0);
  // A failed read here would understate money the office is holding, which is
  // the one figure on this card a household can contradict — it throws to the
  // boundary like every other read on this screen.
  const acctRows = mustRead("the money households have on account", acctRes) ?? [];
  const remainingOf = new Map(acctRows.map((r) => [r.payment_id as string, cents(r.remaining)]));
  const onAccountCentsIn = (rows: typeof offBook) =>
    rows.reduce((n, p) => n + (
      (p.kind as string) === "rent" || p.kind == null
        ? (remainingOf.get(p.id as string) ?? 0)
        : cents(p.amount)
    ), 0);

  const money = moneyBlock({
    // EVERY dollar received, which is the only version of this number he can
    // tie to a bank statement. The split is named on its own line below.
    monthToDateCents: mtd.totalCents + sumCents(offMonth),
    todayCents: cashToday.totalCents + sumCents(offToday),
    handedBackMonthCents,
    handedBackTodayCents,
    // Held, not arrived — see onAccountCentsIn. The kinds are still the kinds
    // that arrived: a cheque wholly spent on a bill adds $0 here and names
    // nothing, because `describeOffBook` is only read when the figure is > 0.
    offBookCents: onAccountCentsIn(offMonth),
    offBookKinds: [...new Set(offMonth.filter((p) => (
      (p.kind as string) === "rent" || p.kind == null
        ? (remainingOf.get(p.id as string) ?? 0) > 0
        : cents(p.amount) > 0
    )).map((p) => (p.kind as string) ?? "rent"))],
    monthSummary,
    lagDays,
    arrears,
    disputedOlder,
    today,
  });

  // ---- the to-do list -----------------------------------------------------
  // ONE predicate for "already has a successor" — the same map the
  // renewals card and the nightly reminder read (latestSeqByChain); this
  // loader used to build its own copy. Built from EVERY row including the
  // ended ones: a household closed out of its successor has a later link
  // — it is just `ended` — and the prior must not read as "write the next
  // one" (nor a lapsed holdover as "hasn't signed").
  const chains = latestSeqByChain(
    (everyRow ?? []).map((s) => ({
      agreement_chain_id: (s.agreement_chain_id as string | null) ?? null,
      agreement_seq: (s.agreement_seq as number | null) ?? null,
    })),
  );

  // reservation -> lot, so a rent change can name its lot without a column
  // that does not exist.
  const lotOfReservation = new Map(
    stays.map((s) => [s.id as string, s.park_lot_id as string]),
  );

  const renters = mustRead(
    "the households",
    // email, the office number, the invite stamp and the slip stamp are the
    // readiness list's: who still lacks a contact, and whether anyone was
    // invited or had a slip printed.
    await admin.from("park_renters").select("id, display_name, email, phone_on_file_with_park, invite_sent_at, claim_code_issued_at").eq("park_id", parkId),
  );
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  const agreements = stays.flatMap((s) => {
    const r = parseDaterange(s.during as string);
    if (!r) return [];
    const cid = (s.agreement_chain_id as string) ?? null;
    const seq = (s.agreement_seq as number) ?? 1;
    return [{
      reservationId: s.id as string,
      lotNumber: lotName.get(s.park_lot_id as string) ?? "?",
      // The household, not just their name: what the park is holding for
      // them is counted per renter (strandedOnAccount).
      renterId: (s.renter_id as string | null) ?? null,
      renterName: renterName.get(s.renter_id as string) ?? null,
      // Both ends: the card's lead is the agreement's own span (R2).
      startsOn: r.start,
      endsOn: r.end,
      chainId: cid,
      seq,
      // A successor is a later link in the same chain. Without one, this
      // tenancy simply stops being billed when it lapses.
      hasSuccessor: cid != null && (chains.get(cid) ?? 0) > seq,
    }];
  });

  // Rate cards, actually counted — by the readiness builder, off the live
  // lots. Claiming "21 of 21" from the lot count alone would put a tick
  // against work nobody has done.
  const rates = liveIds.length
    ? mustRead(
        "your rate cards",
        await admin.from("lot_rates").select("park_lot_id, term, amount")
          .in("park_lot_id", liveIds),
      )
    : ([] as Record<string, unknown>[]);

  const [costsRes, rentChangesRes, statesRes, noteRes, visitsRes] =
    await Promise.all([
      admin.from("park_costs").select("id, category, amount_paid, allocated_total, park_absorbed, denominator_lots, payer_lots, allocation_method").eq("park_id", parkId),
      // lot_rent_changes keys on park_id and RESERVATION_id — it has no
      // park_lot_id at all. Two wrong column names in one select, and neither
      // is a type error: supabase-js returns {error, data:null}, so the notice
      // task read an empty list and never fired. The lot number comes back
      // through the reservation below.
      admin.from("lot_rent_changes")
        .select("id, reservation_id, effective_on, notice_days_required, notice_given_on")
        .eq("park_id", parkId)
        .is("applied_at", null)
        .is("cancelled_at", null),
      admin.from("park_task_states").select("task_key, snoozed_until, dismissed_at").eq("park_id", parkId),
      admin.from("park_notes").select("id, body, created_at")
        .eq("park_id", parkId).is("done_at", null).order("created_at", { ascending: false }),
      // Who is on the land today — the visits board's own view, so the one
      // line here and the board agree about what a visit is.
      admin.from("park_site_visits").select("crew").eq("park_id", parkId).eq("visit_date", today),
    ]);
  const costs = mustRead("your costs", costsRes);
  // A failed read here would print no line — and the line's absence is what
  // a quiet drive looks like. It throws instead.
  const visitsToday = mustRead("who's on site today", visitsRes);
  const rentChanges = mustRead("the rent changes you've scheduled", rentChangesRes);
  // A failed task-state read reads as "nothing snoozed or dismissed", which
  // brings back every chore he has already decided against.
  const states = mustRead("the tasks you've put off", statesRes);
  const noteRows = mustRead("your notes", noteRes);

  // What recurs here, and what has already been entered for this month. A
  // category with a cost inside the month is done — matched on category rather
  // than amount, because two identical bills are two bills.
  const [schedulesRes, monthCostsRes] = await Promise.all([
    admin.from("park_cost_schedules")
      // `created_at` bounds the walk back: a schedule filed in March was
      // never expected to answer for February.
      .select("id, category, cadence, due_day, due_month, typical_amount, label, covers_prior_period, created_at")
      .eq("park_id", parkId).eq("active", true),
    // WHAT COUNTS AS "DEALT WITH" lives in `costAnswersBill` (cost-helpers),
    // with the history of the two times it was wrong. What is decided HERE
    // is only how much to fetch: the widest period any cadence can need. That
    // was the year (0123); a flagged annual bill covers the year BEFORE the
    // one it is due in (0170), so it is now last 1 January onward, and
    // `costAnswersBill` narrows it per schedule below.
    admin.from("park_costs")
      .select("category, period_start, period_end, created_at")
      .eq("park_id", parkId)
      .or(`created_at.gte.${costsFrom},period_end.gte.${costsFrom}`),
  ]);
  const schedules = mustRead("the bills that recur here", schedulesRes);
  // This one decides whether a bill reminder CLEARS. An empty read makes every
  // recurring bill look unpaid, which is the reminder that will not go away.
  const monthCosts = mustRead("the costs already entered", monthCostsRes);
  const allCosts = monthCosts ?? [];

  // WHAT THE PARK STILL HOLDS FOR HOUSEHOLDS WHO HAVE LEFT. getHeldMoney
  // throws to the boundary on a failed read, the same way every read above
  // does — a quiet morning over a cheque nobody looked for is the shape
  // this screen exists to prevent. Grouped per household: on account only
  // where the final month is billed (no bill will ever take it now), a
  // deposit whenever the tenancy has ended and it is still held — and the
  // household carries `finalMonthBilled` with it, so the card can say
  // "nothing more bills for them" only when that is true, and name the bill
  // still to come when it is not. (Every row of one household carries the
  // same fact: tenancyFactsFor reads it per renter.)
  const held = await getHeldMoney(parkId);
  const departed = new Map<string, { renterId: string; renterName: string; movedOutOn: string; finalMonthBilled: boolean; onAccount: number; depositsHeld: number }>();
  const note = (r: { renterId: string | null; renterName: string; movedOutOn: string | null; finalMonthBilled: boolean }, onAccount: number, deposit: number) => {
    if (!r.renterId || !r.movedOutOn) return;
    const cur = departed.get(r.renterId) ?? { renterId: r.renterId, renterName: r.renterName, movedOutOn: r.movedOutOn, finalMonthBilled: r.finalMonthBilled, onAccount: 0, depositsHeld: 0 };
    cur.onAccount = Math.round((cur.onAccount + onAccount) * 100) / 100;
    cur.depositsHeld = Math.round((cur.depositsHeld + deposit) * 100) / 100;
    departed.set(r.renterId, cur);
  };
  for (const r of held.onAccount) {
    if (r.tenancyEnded && r.finalMonthBilled && r.remaining > 0) note(r, r.remaining, 0);
  }
  for (const d of held.deposits) {
    if (d.tenancyEnded && !d.returnedOn) note(d, 0, d.amount);
  }
  const heldForDeparted = [...departed.values()].filter((h) => h.onAccount > 0 || h.depositsHeld > 0);

  // AND WHAT IS HELD FOR HOUSEHOLDS WHO HAVE NOT LEFT. `heldForDeparted`
  // above is the hand-back list — it is keyed on a move-out day, so a
  // household still living here whose agreement simply RAN OUT is not on it:
  // no bill is ever raised for them, the money on account has nothing to come
  // off, and on the morning of 1 February two households sat holding $542.53
  // each with nothing on this screen tying the one fact to the other. The
  // agreements card says it now, off the same view's `remaining` the held
  // panel prints (one definition, three screens).
  const heldByRenter = new Map<string, number>();
  for (const r of held.onAccount) {
    if (!r.renterId || r.tenancyEnded || r.remaining <= 0) continue;
    heldByRenter.set(
      r.renterId,
      Math.round(((heldByRenter.get(r.renterId) ?? 0) + r.remaining) * 100) / 100,
    );
  }

  // The last week of evening checks. Absence is the alarm.
  // ABSENCE IS THE ALARM HERE, which is exactly why a failed read must not
  // look like absence — it would report the nightly check as dead on a night
  // it ran fine.
  const runs = mustRead(
    "last night's check",
    await admin
      .from("park_machine_runs")
      .select("runner, run_on, ok, error, found, finished_at, findings")
      .eq("park_id", parkId)
      .gte("run_on", addDaysISO(today, -7))
      .order("run_on", { ascending: false }),
  );

  const allTasks = generateTasks({
    today,
    parkId,
    currentMonth: month,
    rentDueDay,
    // The go-live gate for the bill reminders. Read at the top of this loader
    // and, until now, consumed only by the readiness checklist — so the
    // seller's tax and December sewer were raised as overdue on closing day.
    cutoverOn,
    agreements: agreements.map((a) => ({
      ...a,
      onAccountHeld: (a.renterId && heldByRenter.get(a.renterId)) || 0,
    })),
    monthBilled: monthRows.length > 0,
    liveOccupiedLots: occupiedLotIds.size,
    // A holdover is a CURRENT tenancy written as grandfathered — somebody
    // living here on the seller's terms who has not signed the new lease.
    // AND HAS NOT: a signing trims the grandfathered row and holds the new
    // lease one link later in the same chain, so a household who signed on
    // 10 December for 1 January is still current on the old row on the
    // 20th. `chains` (built above for the renewal card) knows the later
    // link; holdoverLotsOf leaves those off.
    holdoverLots: holdoverLotsOf(
      stays.map((s) => ({
        park_lot_id: s.park_lot_id as string,
        during: s.during as string,
        origin: (s.origin as string | null) ?? null,
        agreement_chain_id: (s.agreement_chain_id as string | null) ?? null,
        agreement_seq: (s.agreement_seq as number | null) ?? null,
      })),
      today,
      chains,
      (lotId) => lotName.get(lotId) ?? "?",
    ),
    lateCount: monthSummary.lateCount,
    lateAmount: monthSummary.lateAmount,
    disputedCount: monthSummary.disputedCount,
    // EARLIER MONTHS REACH THE TO-DO LIST NOW. `arrears` was computed forty
    // lines up and handed only to `moneyBlock`, so it was rendered in bold on
    // the money card and was invisible to `generateTasks` — the unpaid July
    // bill dropped off the list at midnight on 1 August and never came back.
    // HOUSEHOLDS, not rows: one row per bill, and a household with January
    // and February open read "2 households owe" beside the money card's
    // "1 household". The same helper moneyBlock counts with.
    arrearsCount: householdsIn(arrears),
    arrearsAmount: arrears.reduce((sum, r) => sum + r.balance, 0),
    // The oldest open month, so the card's door opens on the rent screen for
    // THAT month rather than the current one, where the bill is not.
    arrearsOldestMonth: arrears.length
      ? arrears.reduce((m, r) => (r.periodMonth < m ? r.periodMonth : m), arrears[0].periodMonth)
      : null,
    // MONEY HELD FOR A HOUSEHOLD THAT HAS LEFT — the held panel's own read
    // (getHeldMoney), so Today and the Rent screen name the same money. Only
    // when the final month is billed: before that, the run raises their
    // part-month and settles it from this money (R1).
    heldForDeparted,
    // A BILL THAT WAS NEVER SPLIT — but only the ones he can actually do
    // something about. Two shapes land on `allocated_total === 0` and are
    // exactly right, and both would have sat here as a permanent chore he
    // could not clear, which is how a person learns to stop reading this list:
    //   * a recurring fee already covers the category, so recordCost
    //     deliberately did not split it (it says so in the toast at the time)
    //   * the park had no paying lots at all, so there was nobody to bill
    unallocatedCosts: (costs ?? [])
      .filter((c) => Number(c.allocated_total) === 0 && Number(c.amount_paid) > 0)
      //   * he chose to carry it himself (0118) — not an oversight, a decision
      .filter((c) => c.allocation_method !== "park_only")
      .filter((c) => c.allocation_method !== "fee_covered")
      .filter((c) => !(c.denominator_lots == null && Number(c.park_absorbed ?? 0) > 0))
      .filter((c) => !(c.denominator_lots != null && Number(c.payer_lots ?? 0) === 0))
      .map((c) => ({
        id: c.id as string,
        label: String(c.category ?? "A cost"),
        amount: Number(c.amount_paid),
      })),
    pendingRentChanges: (rentChanges ?? [])
      .filter((rc) => (rc.effective_on as string) >= today)
      .map((rc) => ({
        id: rc.id as string,
        lotNumber: lotName.get(lotOfReservation.get(rc.reservation_id as string) ?? "") ?? "?",
        effectiveOn: rc.effective_on as string,
        noticeDaysRequired: (rc.notice_days_required as number) ?? 0,
        noticeServedOn: (rc.notice_given_on as string) ?? null,
      })),
    // NOTE: `notice_given_on` exists on lot_rent_changes AND on
    // lot_reservations, and they mean different things — a rent-increase
    // notice above, a notice to vacate here. Auditing for a reader of the
    // second one turned up the first and nearly closed the finding.
    //
    // `stays` is already filtered to approved/active, so a tenancy that has
    // actually been closed out drops off this list on its own.
    // A BILL THAT ARRIVES EVERY MONTH AND HAS NOT ARRIVED HERE.
    //
    // Per-park and owner-created: a new park has no schedules and sees nothing,
    // which is the point. Nothing about The Haven is a default.
    // A BILL IS DUE FOR ITS OWN PERIOD, not for the calendar month.
    //
    // A property tax reminder keyed on the month would nag twelve times a year
    // about a bill that arrives once, and go quiet only in the month it was
    // entered. `billPeriod` gives each cadence its own window and its own key,
    // so the tax bill is one task called "Property tax for 2026" and it stays
    // quiet from the moment it is entered until next November.
    billsDue: (schedules ?? [])
      .map((sc) => {
        // Cleared by a cost of that category that answers the reminder — the
        // ONE rule, in cost-helpers, with its history.
        const answered = (period: BillPeriod) => allCosts.some((c) => costAnswersBill(
          {
            category: String(c.category),
            period_start: String(c.period_start ?? ""),
            period_end: String(c.period_end ?? ""),
            enteredOn: lakeDateOf(String(c.created_at ?? "")) ?? "",
          },
          period,
          String(sc.category),
        ));
        // THE OLDEST PERIOD NOBODY HAS ENTERED, not merely today's.
        //
        // The schedule may say its bill is FOR the period before the one it
        // is due in (0170). billPeriod then keys and windows on the covered
        // period and carries the flag on its result, so the clear rule and
        // the card read one shape — and the walk asks it per period rather
        // than re-deriving anything.
        //
        // The floor is the latest of three honest limits: the costs this
        // loader read, the first period that is ours, and the day the
        // schedule was filed.
        const createdOn = lakeDateOf(String(sc.created_at ?? "")) ?? costsFrom;
        const floors = [costsFrom, `${createdOn.slice(0, 7)}-01`];
        if (goLiveFloor) floors.push(goLiveFloor);
        const p = oldestUnansweredBill({
          cadence: (sc.cadence as Cadence) ?? "monthly",
          dueMonth: sc.due_month == null ? null : Number(sc.due_month),
          dueDay: Number(sc.due_day ?? 5),
          coversPriorPeriod: Boolean(sc.covers_prior_period),
          today,
          floor: floors.reduce((a, b) => (a > b ? a : b)),
          answered,
        });
        return { sc, p };
      })
      .flatMap(({ sc, p }) => (p == null ? [] : [{
        scheduleId: sc.id as string,
        category: sc.category as string,
        label: (sc.label as string)
          || COST_CATEGORY_LABEL[sc.category as CostCategory]
          || (sc.category as string),
        periodKey: p.key,
        periodLabel: p.label,
        // The month the go-live gate compares — the bill's own period, the
        // same thing the cost door compares against `period_start`.
        periodFrom: p.from,
        dueOn: p.dueOn,
        typical: sc.typical_amount == null ? null : Number(sc.typical_amount),
        coversPriorPeriod: p.coversPriorPeriod,
      }])),
    noticed: stays
      .filter((s) => s.expected_move_out)
      .map((s) => ({
        reservationId: s.id as string,
        lotNumber: lotName.get(s.park_lot_id as string) ?? "?",
        renterName: renterName.get(s.renter_id as string) ?? null,
        leavingOn: s.expected_move_out as string,
      })),
  });

  const tasks = visibleTasks(
    allTasks,
    (states ?? []).map((s) => ({
      taskKey: s.task_key as string,
      snoozedUntil: (s.snoozed_until as string) ?? null,
      dismissedAt: (s.dismissed_at as string) ?? null,
    })) as TaskState[],
    today,
  );

  const notes = (noteRows ?? []).map((n) => ({
    id: n.id as string,
    body: n.body as string,
    createdAt: n.created_at as string,
  }));

  // Only ever say "nothing needs you" when nothing does — including his own
  // notes, which the software has no opinion about but he still wrote down.
  const checked: string[] = [];
  if ((charges ?? []).length) checked.push("rent");
  if (agreements.length) checked.push("agreements");
  if ((costs ?? []).length) checked.push("costs");
  if ((rentChanges ?? []).length) checked.push("rent changes");

  // ---- readiness and the first-run card ---------------------------------
  // The rows this loader already holds, plus the light reads neither card
  // had (lake name, fees, deliveries, reminders, acceptance, processor).
  const extras = await readinessExtras(
    parkId,
    (park?.lake_id as string | null) ?? null,
    (renters ?? []).map((r) => r.id as string),
  );
  const ready = readinessFactsFrom({
    today,
    viewerIsOwner: membership.role === "owner",
    park: park ?? null,
    lots: lots ?? [],
    reservations: everyRow ?? [],
    renters: renters ?? [],
    rates: rates ?? [],
    chargesRaised: (charges ?? []).length,
    extras,
  });
  const rows = readinessFor(ready.facts);
  const beforeGoLive = cutoverOn != null && cutoverOn > today;
  // NO TAKEOVER-DATE GATE ON THE LIST. Before go-live it stands in for the
  // money card; otherwise it shows whenever the park is unpublished or a
  // required row is undone — a park with no takeover day sees it too.
  const readiness = beforeGoLive || showReadinessOnToday(ready.facts, rows)
    ? { ...readinessHeadline(ready.facts, rows), rows }
    : null;
  // "Don't show this again" is a task state like any other dismissal.
  const firstRunDismissed = (states ?? []).some(
    (st) => st.task_key === firstRunTaskKey(parkId) && st.dismissed_at != null,
  );
  const firstRun = firstRunDismissed ? null : firstRunCard(ready.facts, ready.contact, rows);

  const runRows: RunRow[] = (runs ?? []).map((r) => ({
    runner: r.runner as string,
    runOn: r.run_on as string,
    ok: r.ok as boolean,
    error: (r.error as string) ?? null,
    found: (r.found as number) ?? 0,
    finishedAt: (r.finished_at as string) ?? null,
    findings: Array.isArray(r.findings)
      ? (r.findings as { kind: string; urgent: boolean; line: string }[])
      : [],
  }));

  return {
    liveness: livenessLine(runRows, today, checked),
    findings: lastNightsFindings(runRows),
    parkName,
    today,
    month,
    money,
    occupancy: occupancyLine(snapshot),
    tasks,
    notes,
    // "NOTHING NEEDS YOU" MUST NOT PRINT UNDER A DEBT.
    //
    // This read `tasks` and `notes` alone, and `moneyBlock` renders the arrears
    // and disputed lines on the same card — so on a quiet morning the screen
    // printed "Nothing needs you this morning." directly beneath a bold
    // "$2,700.00 still owing from earlier months". The arrears task above now
    // makes `tasks` non-empty for the arrears case; the disputed line generates
    // no task by design (a dispute is something to settle, not chase), so it is
    // consulted here explicitly. The rule this file states about itself two
    // hundred lines up is "only ever say 'nothing needs you' when nothing does".
    quiet:
      tasks.length === 0 && notes.length === 0
        && money.arrearsLine === null && money.disputedLine === null
        ? quietState(checked)
        : null,
    firstRun,
    beforeGoLive,
    readiness,
    crewsOnSite: crewsOnSite((visitsToday ?? []).map((v) => ({ crew: String(v.crew ?? UNASSIGNED_CREW) }))),
  };
}

// ------------------------------------------------------------ decisions ----

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** Put something off. A snooze EXPIRES — it is not a decision against it. */
export async function snoozeTask(
  parkId: string, taskKey: string, until: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: "That date doesn't look right." };

  const admin = createServiceClient();
  const { error } = await admin.from("park_task_states").upsert({
    park_id: parkId, task_key: taskKey, snoozed_until: until,
    dismissed_at: null, dismissed_reason: null, created_by: await currentUserId(),
  }, { onConflict: "park_id,task_key" });
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath("/park/today");
  return { ok: true, signal: `Back on ${dayInWords(until)}.` };
}

/** Decide against it. Only ever offered for things it is safe to stop showing. */
export async function dismissTask(
  parkId: string, taskKey: string, reason: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const { error } = await admin.from("park_task_states").upsert({
    park_id: parkId, task_key: taskKey,
    dismissed_at: new Date().toISOString(),
    dismissed_reason: reason.trim() || null,
    snoozed_until: null, created_by: await currentUserId(),
  }, { onConflict: "park_id,task_key" });
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath("/park/today");
  return { ok: true, signal: "Won't mention it again." };
}

/**
 * His own note.
 *
 * Half of what happens at a park is somebody telling him in the driveway. The
 * licence renewal, the quote he is waiting on — none of those have
 * a derivable column anywhere, and never will.
 */
export async function addNote(parkId: string, body: string): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const text = body.trim();
  if (!text) return { ok: false, error: "Nothing to add." };
  if (text.length > 400) return { ok: false, error: "Keep it under 400 characters." };

  const admin = createServiceClient();
  const { error } = await admin.from("park_notes").insert({
    park_id: parkId, body: text, created_by: await currentUserId(),
  });
  if (error) return { ok: false, error: "Couldn't save that — try again." };

  revalidatePath("/park/today");
  return { ok: true, signal: "Added." };
}

/** Yours stay until you tick them. Ours go when they're handled. */
export async function doneNote(parkId: string, noteId: string): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { error } = await admin
    .from("park_notes")
    .update({ done_at: new Date().toISOString() })
    .eq("id", noteId).eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't save that — try again." };
  revalidatePath("/park/today");
  return { ok: true, signal: "Ticked off." };
}
