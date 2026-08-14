"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { COST_CATEGORY_LABEL, type CostCategory } from "./cost-helpers";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import {
  toRows, summarise, currentPeriod,
  type Charge, type LedgerRow, type LedgerSummary,
} from "./ledger-helpers";
import { summariseReceipts, customPeriod, type Receipt, type Method } from "./receipts-helpers";
import {
  moneyBlock, occupancyLine, generateTasks, visibleTasks, quietState, preCutover,
  type MoneyBlock, type Task, type TaskState, type OccupancySnapshot,
} from "./today-helpers";
import { livenessLine, lastNightsFindings, type RunRow, type LivenessLine } from "./machine-helpers";
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
  preCutover: ReturnType<typeof preCutover> | null;
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
  if (!(await assertMyPark(parkId))) return null;

  const admin = createServiceClient();
  const today = todayLakeDate();
  const month = currentPeriod(today);

  const { data: park } = await admin
    .from("parks")
    .select("name, rent_due_day, office_recording_lag_days, max_agreement_months, cutover_date")
    .eq("id", parkId)
    .maybeSingle();
  const parkName = (park?.name as string) ?? "Your park";
  const lagDays = (park?.office_recording_lag_days as number) ?? 3;
  const rentDueDay = (park?.rent_due_day as number) ?? 1;
  const cutoverOn = (park?.cutover_date as string) ?? null;

  // ---- lots and who is on them -------------------------------------------
  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, lifecycle")
    .eq("park_id", parkId);
  const liveLots = (lots ?? []).filter((l) => (l.lifecycle as string) === "live");
  const liveIds = liveLots.map((l) => l.id as string);
  const lotName = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));

  const { data: stays } = liveIds.length
    ? await admin
        .from("lot_reservations")
        .select("id, park_lot_id, renter_id, during, status, origin, agreement_chain_id, agreement_seq, notice_given_on, expected_move_out")
        .in("park_lot_id", liveIds)
        .in("status", ["approved", "active"])
    : { data: [] as Record<string, unknown>[] };

  const occupiedLotIds = new Set<string>();
  const reservedLotIds = new Set<string>();
  for (const s of stays ?? []) {
    const r = parseDaterange(s.during as string);
    if (!r) continue;
    // Half-open: `end` is checkout morning, so today === end is NOT occupied.
    if (r.start <= today && today < r.end) occupiedLotIds.add(s.park_lot_id as string);
    else if (r.start > today) reservedLotIds.add(s.park_lot_id as string);
  }
  // A LOT IS COUNTED ONCE. Renewing somebody writes a future tenancy on a lot
  // that already has a current one, so without this the same lot lands in both
  // sets and every renewal inflates occupancy by a lot that did not change
  // hands. Found by driving it: 3 lots, 1 tenant, "2 of 3 taken".
  for (const id of occupiedLotIds) reservedLotIds.delete(id);

  const vacantLots = liveLots.filter(
    (l) => !occupiedLotIds.has(l.id as string) && !reservedLotIds.has(l.id as string),
  );

  const snapshot: OccupancySnapshot = {
    liveLots: liveLots.length,
    occupied: occupiedLotIds.size,
    reserved: reservedLotIds.size,
    vacant: vacantLots.length,
    vacantLotNumbers: vacantLots
      .map((l) => l.lot_number as string)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };

  // ---- money --------------------------------------------------------------
  const { data: charges } = await admin
    .from("park_charges")
    .select("id, park_lot_id, renter_id, period_month, due_on, amount, paid_total, status")
    .eq("park_id", parkId);

  const allIds = (charges ?? []).map((c) => c.id as string);
  const { data: claims } = allIds.length
    ? await admin.from("park_payment_claims").select("charge_id")
        .in("charge_id", allIds).is("resolved_at", null)
    : { data: [] as { charge_id: string }[] };
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
  const { data: payments } = allIds.length
    ? await admin.from("park_payments")
        .select("id, charge_id, amount, fee_amount, method, reference, received_on, reversed_at, reversed_reason")
        .in("charge_id", allIds)
        .is("reversed_at", null)
    : { data: [] as Record<string, unknown>[] };

  const chargeById = new Map((charges ?? []).map((c) => [c.id as string, c]));
  const receipts: Receipt[] = (payments ?? []).map((p) => {
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

  const money = moneyBlock({
    monthToDateCents: mtd.totalCents,
    todayCents: cashToday.totalCents,
    monthSummary,
    lagDays,
    arrears,
    disputedOlder,
    today,
  });

  // ---- the to-do list -----------------------------------------------------
  const chains = new Map<string, number>();
  for (const s of stays ?? []) {
    const cid = (s.agreement_chain_id as string) ?? null;
    if (!cid) continue;
    const seq = (s.agreement_seq as number) ?? 1;
    chains.set(cid, Math.max(chains.get(cid) ?? 0, seq));
  }

  // reservation -> lot, so a rent change can name its lot without a column
  // that does not exist.
  const lotOfReservation = new Map(
    (stays ?? []).map((s) => [s.id as string, s.park_lot_id as string]),
  );

  const { data: renters } = await admin
    .from("park_renters").select("id, display_name").eq("park_id", parkId);
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  const agreements = (stays ?? []).flatMap((s) => {
    const r = parseDaterange(s.during as string);
    if (!r) return [];
    const cid = (s.agreement_chain_id as string) ?? null;
    const seq = (s.agreement_seq as number) ?? 1;
    return [{
      reservationId: s.id as string,
      lotNumber: lotName.get(s.park_lot_id as string) ?? "?",
      renterName: renterName.get(s.renter_id as string) ?? null,
      endsOn: r.end,
      chainId: cid,
      seq,
      // A successor is a later link in the same chain. Without one, this
      // tenancy simply stops being billed when it lapses.
      hasSuccessor: cid != null && (chains.get(cid) ?? 0) > seq,
    }];
  });

  // Rate cards, actually counted. Claiming "3 of 3" from the lot count alone
  // would put a tick against work nobody has done.
  const { data: rates } = liveIds.length
    ? await admin.from("lot_rates").select("park_lot_id, term, amount")
        .in("park_lot_id", (lots ?? []).map((l) => l.id as string))
    : { data: [] as Record<string, unknown>[] };
  const lotsWithRates = new Set((rates ?? []).map((r) => r.park_lot_id as string)).size;
  const monthlyRoll = (rates ?? [])
    .filter((r) => (r.term as string) === "monthly")
    .reduce((s, r) => s + Number(r.amount), 0);

  const [{ data: costs }, { data: rentChanges }, { data: states }, { data: noteRows }] =
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
    ]);

  // What recurs here, and what has already been entered for this month. A
  // category with a cost inside the month is done — matched on category rather
  // than amount, because two identical bills are two bills.
  const [{ data: schedules }, { data: monthCosts }] = await Promise.all([
    admin.from("park_cost_schedules")
      .select("id, category, due_day, typical_amount, label")
      .eq("park_id", parkId).eq("active", true),
    // WHAT COUNTS AS "DEALT WITH" — and the first version of this could never
    // be satisfied.
    //
    // It matched costs with `period_start >= ${month}-01`. But the sewer bill
    // that ARRIVES on 1 August is the bill FOR JULY, and the period he types is
    // 2026-07-01 to 2026-07-31. period_start is then before the window, the
    // category never lands in `billedCategories`, and "Sewer for August 2026
    // still isn't entered" stays on his morning screen after he entered it.
    // A reminder that will not clear is what teaches a person to stop reading
    // the screen — which costs more than the reminder was ever worth.
    //
    // So two ways to satisfy it, and either is real evidence: he RECORDED a
    // bill of that category this month (`created_at`, which is NOT NULL and set
    // by the database), or the bill's period overlaps this month at all.
    admin.from("park_costs")
      .select("category, period_start, period_end, created_at")
      .eq("park_id", parkId)
      .or(`created_at.gte.${month}-01,period_end.gte.${month}-01`),
  ]);
  const monthEnd = `${month}-31`;
  const billedCategories = new Set(
    (monthCosts ?? [])
      .filter((c) => {
        const enteredThisMonth = String(c.created_at ?? "").slice(0, 7) === month;
        const periodTouchesMonth =
          String(c.period_start ?? "") <= monthEnd &&
          String(c.period_end ?? "") >= `${month}-01`;
        return enteredThisMonth || periodTouchesMonth;
      })
      .map((c) => c.category as string),
  );

  // The last week of evening checks. Absence is the alarm.
  const { data: runs } = await admin
    .from("park_machine_runs")
    .select("runner, run_on, ok, error, found, finished_at, findings")
    .eq("park_id", parkId)
    .gte("run_on", addDaysISO(today, -7))
    .order("run_on", { ascending: false });

  const allTasks = generateTasks({
    today,
    parkId,
    currentMonth: month,
    rentDueDay,
    agreements,
    monthBilled: monthRows.length > 0,
    liveOccupiedLots: occupiedLotIds.size,
    // A holdover is a CURRENT tenancy written as grandfathered — somebody
    // living here on the seller's terms who has not signed the new lease.
    holdoverLots: (stays ?? [])
      .filter((s) => (s.origin as string) === "grandfathered")
      .filter((s) => {
        const r = parseDaterange(s.during as string);
        return r != null && r.start <= today && today < r.end;
      })
      .map((s) => lotName.get(s.park_lot_id as string) ?? "?")
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    lateCount: monthSummary.lateCount,
    lateAmount: monthSummary.lateAmount,
    disputedCount: monthSummary.disputedCount,
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
    billsDue: (schedules ?? [])
      .filter((sc) => !billedCategories.has(sc.category as string))
      .map((sc) => ({
        scheduleId: sc.id as string,
        category: sc.category as string,
        label: (sc.label as string)
          || COST_CATEGORY_LABEL[sc.category as CostCategory]
          || (sc.category as string),
        dueOn: `${month}-${String(Math.min(Number(sc.due_day ?? 5), 28)).padStart(2, "0")}`,
        typical: sc.typical_amount == null ? null : Number(sc.typical_amount),
      })),
    noticed: (stays ?? [])
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
    quiet: tasks.length === 0 && notes.length === 0 ? quietState(checked) : null,
    preCutover: cutoverOn && cutoverOn >= today
      ? preCutover({
          today, cutoverOn, parkName,
          lots: (lots ?? []).length,
          lotsWithRates,
          monthlyRoll,
          households: (renters ?? []).length,
          rentDueDay,
          maxAgreementMonths: (park?.max_agreement_months as number) ?? null,
        })
      : null,
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
  return { ok: true, signal: `Back on ${until}.` };
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
 * property tax, the insurance binder, the licence renewal — none of those have
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
