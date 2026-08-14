"use server";

import { revalidatePath } from "next/cache";
import { ordinal } from "./today-helpers";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { parseDaterange, overlaps } from "@/lib/parks";
import {
  allocateCost, recoveryByCategory, canSplit, whyNotSplit,
  type CostCategory, type CostLot, type CostAllocation,
  buildCostScheduleRow, type CostScheduleInput, COST_CATEGORY_LABEL,

  carryFromRow, type CostCarry,} from "./cost-helpers";
import type { ParkResult } from "./actions";

/**
 * COST RECOVERY — the write path.
 *
 * Entering a bill records what the park PAID and nothing else. Splitting it is
 * a second, deliberate step, so the owner sees the per-lot number before any
 * resident is asked for anything.
 *
 * The database refuses to let the shares exceed the bill (0064). This layer
 * exists so he reads "you'd be billing back more than you paid" instead of a
 * constraint name — and so the split is computed once, by the pure allocator,
 * rather than in a query nobody can test.
 */

const DENIED = "You don't manage that park.";

export interface CostPreview {
  allocation: CostAllocation;
  category: CostCategory;
  amountPaid: number;
}

/** Who was on a lot during the billing period. */
async function lotsForPeriod(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CostLot[]> {
  // EVERY LOT, and the flags decide. Filtering here is what made the
  // denominator wrong: `.eq("active", true)` dropped a lot switched off for
  // repairs, which still has a live tap and a sewer connection, and the
  // occupied-only divisor dropped the empties the park is supposed to carry.
  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, active, lifecycle, park_owned_home")
    .eq("park_id", parkId);

  const ids = (lots ?? []).map((l) => l.id as string);
  if (ids.length === 0) return [];

  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, status")
    .in("park_lot_id", ids)
    .in("status", ["approved", "active"]);

  // A lot counts as occupied if somebody held it at ANY point in the period.
  // Billing only the lots occupied on the last day would let a mid-month
  // move-out shift a whole month's water onto their neighbours.
  const want = { start: periodStart, end: periodEnd };
  const byLot = new Map<string, string>();
  for (const s of stays ?? []) {
    const range = parseDaterange(s.during as string);
    if (range && overlaps(range, want)) {
      byLot.set(s.park_lot_id as string, s.id as string);
    }
  }

  return (lots ?? []).map((l) => ({
    lotId: l.id as string,
    lotNumber: l.lot_number as string,
    reservationId: byLot.get(l.id as string) ?? null,
    // RENTABLE = the pedestal exists. `lifecycle` is whether the lot EXISTS
    // (0065); `active` is only whether it is being advertised, and a lot taken
    // off the market for a month still draws on the well. Deliberately NOT
    // `active && live`, which is the rule for BOOKING, not for a water bill.
    rentable: ((l.lifecycle as string) ?? "live") === "live",
    // In the denominator, never a payer: its guests use the well, and a
    // three-night guest is not sent a month of park water. The park carries it.
    parkOwned: Boolean(l.park_owned_home),
  }));
}

/** What the split would look like, before anything is written. */
export async function previewCostSplit(
  parkId: string,
  category: CostCategory,
  periodStart: string,
  periodEnd: string,
  amountPaid: number,
): Promise<{ ok: boolean; error?: string; preview?: CostPreview }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    return { ok: false, error: "That bill amount isn't a number." };
  }
  if (!(periodEnd > periodStart)) {
    return { ok: false, error: "The period has to end after it starts." };
  }

  const admin = createServiceClient();
  const lots = await lotsForPeriod(admin, parkId, periodStart, periodEnd);
  const allocation = allocateCost({ amountPaid, method: "per_lot", lots });
  return { ok: true, preview: { allocation, category, amountPaid } };
}

/**
 * Record the bill AND its split, together.
 *
 * One action rather than two because a bill entered but never split is a
 * number sitting in a table doing nothing, and a split with no bill behind it
 * is a charge with no evidence.
 */
export async function recordCost(
  parkId: string,
  category: CostCategory,
  periodStart: string,
  periodEnd: string,
  amountPaid: number,
  sourceNote: string,
  /**
   * The LakeLife job this came from, when it was filled in rather than typed.
   * 0111 makes it unique, so a double-tap cannot bill 21 households twice for
   * one mowing — the database refuses the second insert.
   */
  sourceJobId?: string | null,
  /**
   * WHO PAYS FOR THIS ONE.
   *
   * Default false — everything on this screen has always been shared, and a
   * silent change of that would be worse than the bug it fixes.
   *
   * True means THE PARK CARRIES IT: recorded, in the books, in the fee
   * comparison, divided to nobody. The Haven's guest boat is why this exists —
   * it is bookable by short-stay guests only, so winterizing it is a cost of
   * the nightly business, not of living on lot 14. Without this it would go in
   * as `other` and land on all twenty-one rentable lots.
   */
  parkCarries?: boolean,
): Promise<ParkResult & { perLot?: number; parkAbsorbs?: number }> {
  // WHOSE PARK IS THIS. Found by an audit, and it was exploitable.
  //
  // Every other exported action in this file asserts membership on its first
  // line; this one did not. The split path was safe by accident — it inherits
  // the check from `previewCostSplit` below — but the fee-covered branch
  // returns BEFORE reaching it, having already inserted a park_costs row with
  // the service-role client for whatever park_id the browser sent. This file
  // is "use server", so every export is a public endpoint.
  //
  // The damage was not a resident's bill (that branch writes no shares); it was
  // false expenses in somebody else's books, their CPA statement, and the "is
  // my fee covering my costs" comparison the whole screen is built around.
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  // NEVER SPLIT A HOME THE PARK OWNS. Guarded here as well as hidden from the
  // dropdown, because the dropdown is a courtesy and this is the rule — and a
  // category arrives from a browser.
  if (!parkCarries && !canSplit(category)) {
    return { ok: false, error: whyNotSplit(category) };
  }

  // THE PARK'S OWN COST. Taken before the fee check on purpose: a grounds fee
  // covering "grounds" says nothing about a boat, and asking him to choose and
  // then overriding him would make the choice a lie.
  if (parkCarries) {
    // The screen gates on these, but the screen is a courtesy and this is a
    // public endpoint. `previewCostSplit` validates the period for the split
    // path; this branch returns before reaching it.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return { ok: false, error: "Give the dates this bill covers." };
    }
    if (periodEnd <= periodStart) {
      return { ok: false, error: "The period has to end after it starts — for a one-day job, use the next day as the end." };
    }
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return { ok: false, error: "That amount isn't a number." };
    }
    const admin1 = createServiceClient();
    const { error: e1 } = await admin1.from("park_costs").insert({
      park_id: parkId,
      category,
      period_start: periodStart,
      period_end: periodEnd,
      amount_paid: amountPaid,
      source_note: sourceNote.trim() || null,
      source_job_id: sourceJobId ?? null,
      allocation_method: "park_only",
      allocated_total: 0,
      park_absorbed: amountPaid,
      allocated_at: new Date().toISOString(),
    });
    if (e1) return { ok: false, error: "Couldn't save that bill — try again." };
    revalidatePath("/park/costs");
    revalidatePath("/park/today");
    return {
      ok: true,
      signal: "Recorded as yours. It's in your books and in the fee comparison, and nobody was billed a share.",
      perLot: 0,
      parkAbsorbs: amountPaid,
    };
  }

  // A FEE AND A SPLIT MUST NOT BILL THE SAME THING.
  //
  // `buildStatement` pushes cost-share lines and fee lines onto one statement
  // with no check that they overlap. A $70 "Park services" fee that covers
  // grounds, plus a live grounds split, bills a resident $70 + $71 against
  // $74.74 of real per-head cost — 189% recovery. The never-over-recover
  // constraint never sees it, because it guards lot_cost_shares alone and
  // knows nothing about fees.
  //
  // The bill is still RECORDED — he needs it in his books and on the "is my
  // fee covering my costs" comparison — it is simply not split again.
  const covering = await feeCovering(parkId, category);
  if (covering) {
    const admin0 = createServiceClient();
    const { error: e0 } = await admin0.from("park_costs").insert({
      park_id: parkId,
      category,
      period_start: periodStart,
      period_end: periodEnd,
      amount_paid: amountPaid,
      source_note: sourceNote.trim() || null,
      source_job_id: sourceJobId ?? null,
      // NAMED, not inferred (0118). The screen used to work this out by
      // comparing park_absorbed against zero, which cannot tell a fee-covered
      // bill from one recorded before we tracked any of this.
      allocation_method: "fee_covered",
      park_absorbed: amountPaid,
      allocated_at: new Date().toISOString(),
    });
    if (e0) return { ok: false, error: "Couldn't save that bill — try again." };
    revalidatePath("/park/costs");
    return {
      ok: true,
      signal: `Recorded. Your "${covering}" fee already covers this, so it is not split again — it shows in the comparison below.`,
      perLot: 0,
      parkAbsorbs: amountPaid,
    };
  }

  const pre = await previewCostSplit(parkId, category, periodStart, periodEnd, amountPaid);
  if (!pre.ok || !pre.preview) return { ok: false, error: pre.error };

  const { allocation } = pre.preview;
  // An empty park is no longer a refusal: the bill is recorded and the park
  // carries all of it. Only having nothing to DIVIDE BY is a refusal.
  if (allocation.problem === "no_rentable_lots") {
    return { ok: false, error: "There are no rentable lots for that period, so there is nothing to divide it by." };
  }
  if (allocation.problem === "over_recovery") {
    return { ok: false, error: "That split would recover more than you paid, so nothing was recorded." };
  }

  const admin = createServiceClient();
  const { data: cost, error: costErr } = await admin
    .from("park_costs")
    .insert({
      park_id: parkId,
      category,
      period_start: periodStart,
      period_end: periodEnd,
      amount_paid: amountPaid,
      allocation_method: "per_lot",
      source_note: sourceNote.trim() || null,
      source_job_id: sourceJobId ?? null,
      // THE SNAPSHOT. park_lots has no history, so without these three the
      // same closed month re-splits differently once a lot goes live.
      park_absorbed: allocation.parkAbsorbs,
      denominator_lots: allocation.denominatorLots,
      payer_lots: allocation.payerLots,
      allocated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (costErr || !cost) {
    // 23505 on the unique index: this job is already a cost. Two owners with
    // the screen open, or one impatient double-tap — either way the honest
    // answer is that it is already done, not that it failed.
    if (costErr?.code === "23505") {
      return { ok: false, error: "That job has already been recorded as a cost." };
    }
    return { ok: false, error: "Couldn't save that bill — try again." };
  }

  if (allocation.shares.length > 0) {
    const { error: shareErr } = await admin.from("lot_cost_shares").insert(
      allocation.shares.map((s) => ({
        cost_id: cost.id,
        park_lot_id: s.lotId,
        reservation_id: s.reservationId,
        amount: s.amount,
        basis: s.basis,
      })),
    );
    if (shareErr) {
      // 23514 is the never-over-recover constraint. It should be unreachable —
      // the allocator rounds down — so if it fires, the bill is removed rather
      // than left half-split, and it is said out loud.
      await admin.from("park_costs").delete().eq("id", cost.id as string);
      return {
        ok: false,
        error: shareErr.code === "23514"
          ? "That split would have billed back more than the bill. Nothing was saved."
          : "Couldn't split that bill — nothing was saved.",
      };
    }
  }

  revalidatePath("/park/costs");
  revalidatePath("/park");
  return {
    ok: true,
    perLot: allocation.shares[0]?.amount ?? 0,
    parkAbsorbs: allocation.parkAbsorbs,
    signal:
      `Split across ${allocation.occupiedCount} ${allocation.occupiedCount === 1 ? "lot" : "lots"}` +
      (allocation.parkAbsorbs > 0 ? ` — you're carrying $${allocation.parkAbsorbs.toFixed(2)}.` : "."),
  };
}

export async function removeCost(parkId: string, costId: string): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  // Shares cascade, and the trigger resets the total on the way out.
  const { error } = await admin
    .from("park_costs").delete().eq("id", costId).eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't remove that — try again." };
  revalidatePath("/park/costs");
  return { ok: true, signal: "Bill removed, along with everyone's share of it." };
}

export interface CostRow {
  id: string;
  category: CostCategory;
  periodStart: string;
  periodEnd: string;
  amountPaid: number;
  allocatedTotal: number;
  sourceNote: string | null;
  lots: number;
  /** Of `allocatedTotal`, how much has actually landed on a bill (0104). */
  billedTotal: number;
  /**
   * WHAT THE PARK CARRIED because a lot was empty or park-owned (0112).
   *
   * NULL means "no snapshot on this row", which is NOT the same as zero.
   * `park_absorbed` is NOT NULL DEFAULT 0, so a row written before 0112 reads
   * exactly 0.00 and is indistinguishable from a bill that genuinely recovered
   * in full. `denominator_lots` is the only nullable one of the three and is
   * therefore the only honest test for "was this ever measured".
   */
  absorbed: number | null;
  denominatorLots: number | null;
  payerLots: number | null;
  /** How this bill came to rest — stored on the row since 0118. */
  carry: CostCarry;
}

export async function listCosts(parkId: string): Promise<{
  rows: CostRow[];
  summary: ReturnType<typeof recoveryByCategory>;
}> {
  const empty = { rows: [], summary: recoveryByCategory([]) };
  if (!(await assertMyPark(parkId))) return empty;

  const admin = createServiceClient();
  const { data } = await admin
    .from("park_costs")
    .select("id, category, period_start, period_end, amount_paid, allocated_total, source_note, park_absorbed, denominator_lots, payer_lots, allocation_method")
    .eq("park_id", parkId)
    .order("period_start", { ascending: false })
    .limit(120);

  const ids = (data ?? []).map((c) => c.id as string);
  const counts = new Map<string, number>();
  // WHAT ACTUALLY REACHED A BILL (0104). This read used to select `cost_id`
  // alone and count rows — the only read of `lot_cost_shares` in the whole
  // codebase, and it answered "how many lots did I split this across", never
  // "did any of them get asked for it".
  const billed = new Map<string, number>();
  if (ids.length) {
    const { data: shares } = await admin
      .from("lot_cost_shares").select("cost_id, amount, billed_on_charge_id").in("cost_id", ids);
    for (const s of shares ?? []) {
      const k = s.cost_id as string;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (s.billed_on_charge_id) {
        billed.set(k, Math.round(((billed.get(k) ?? 0) + Number(s.amount ?? 0)) * 100) / 100);
      }
    }
  }

  const rows: CostRow[] = (data ?? []).map((c) => {
    // READ, not re-derived (0118). `allocation_method` says how the bill came
    // to rest; the numbers no longer have to be interrogated for a reason.
    const carry = carryFromRow(c);
    const measured = c.denominator_lots != null;
    const raw = Number(c.park_absorbed ?? 0);

    return {
      billedTotal: billed.get(c.id as string) ?? 0,
      id: c.id as string,
      category: c.category as CostCategory,
      periodStart: c.period_start as string,
      periodEnd: c.period_end as string,
      amountPaid: Number(c.amount_paid),
      allocatedTotal: Number(c.allocated_total),
      sourceNote: (c.source_note as string) ?? null,
      lots: counts.get(c.id as string) ?? 0,
      absorbed: carry === "unrecorded" ? null : raw,
      denominatorLots: measured ? Number(c.denominator_lots) : null,
      payerLots: measured ? Number(c.payer_lots) : null,
      carry,
    };
  });

  return {
    rows,
    summary: recoveryByCategory(
      rows.map((r) => ({
        category: r.category, amountPaid: r.amountPaid, allocatedTotal: r.allocatedTotal,
        billedTotal: r.billedTotal,
        // ONLY VACANCY CARRY. `park_absorbed` on a park_only or fee_covered
        // row is the WHOLE bill, not a share of empty pads — feeding those in
        // put the guest boat and a fee-covered mow under the label "you
        // carried for the empty lots", which is the number he uses to judge
        // what vacancy costs him and whether his fee is set right.
        absorbed: r.carry === "split" ? r.absorbed : 0,
      })),
    ),
  };
}


export interface BillableParkJob {
  jobId: string;
  service: string;
  date: string;
  amount: number;
  periodStart: string;
  periodEnd: string;
  note: string;
}

/**
 * WORK THE PARK HAS PAID FOR AND NOT YET PASSED ON.
 *
 * The last manual step in the loop: the owner read a figure off the jobs
 * screen and typed it into the costs form. That is where a digit gets
 * dropped, and the household whose share is wrong has no way to know.
 *
 * ONLY WORK ON THE PARK'S OWN GROUNDS. Scoped through
 * `parks.service_property_id`, so a job at a RESIDENT'S lot can never appear
 * here — that is their private purchase, and offering the park a button to
 * bill it back to them would invert every privacy rule in the module.
 *
 * ONLY WORK THAT IS DONE. A scheduled mow is not a cost yet; passing on money
 * before a crew has turned up is how a park bills for a visit that then gets
 * rained off.
 */
export async function getBillableParkJobs(parkId: string): Promise<BillableParkJob[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();

  const { data: park } = await admin
    .from("parks").select("service_property_id").eq("id", parkId).maybeSingle();
  const propertyId = (park?.service_property_id as string) ?? null;
  if (!propertyId) return [];

  const { data: jobs } = await admin
    .from("jobs")
    .select("id, date, customer_price, status, services(name)")
    .eq("property_id", propertyId)
    .in("status", ["complete", "paid"])
    .order("date", { ascending: false })
    .limit(24);
  if (!jobs?.length) return [];

  // Already passed on? `source_job_id` is the only honest answer — a match on
  // amount and date would treat two identical mows as one.
  const { data: taken } = await admin
    .from("park_costs")
    .select("source_job_id")
    .eq("park_id", parkId)
    .not("source_job_id", "is", null);
  const done = new Set((taken ?? []).map((c) => c.source_job_id as string));

  return jobs
    .filter((j) => !done.has(j.id as string))
    .filter((j) => Number(j.customer_price ?? 0) > 0)
    .map((j) => {
      const svc = Array.isArray(j.services)
        ? (j.services[0] as { name?: string } | undefined)?.name
        : (j.services as { name?: string } | null)?.name;
      const date = j.date as string;
      return {
        jobId: j.id as string,
        service: svc ?? "Park work",
        date,
        amount: Number(j.customer_price ?? 0),
        // The period a mow covers is the month it happened in — that is what
        // decides WHO is billed, because the allocator splits across whoever
        // was on a lot during it.
        periodStart: `${date.slice(0, 7)}-01`,
        periodEnd: date,
        note: `${svc ?? "Park work"} — LakeLife, ${date}`,
      };
    });
}


/**
 * Is an ACTIVE fee already charging residents for this category?
 *
 * Returns the fee's label so the message can name it — "your Park services fee
 * already covers this" is actionable; "this is covered" is not.
 */
async function feeCovering(parkId: string, category: CostCategory): Promise<string | null> {
  const admin = createServiceClient();
  const { data: fees } = await admin
    .from("park_fees")
    .select("label, covers, active")
    .eq("park_id", parkId)
    .eq("active", true);
  const hit = (fees ?? []).find((f) =>
    ((f.covers as string[]) ?? []).includes(category));
  return hit ? ((hit.label as string) ?? "recurring") : null;
}

/**
 * A TYPICAL MONTH OF SHARED COST, and who is actually billed for it.
 *
 * Feeds the "what does adding a lot do" line on /park/lots. Uses the most
 * recent month that HAS costs rather than the current one — the water bill for
 * August arrives in September, so asking about today would show $0 for the
 * first three weeks of every month and make the impact line silently vanish.
 *
 * Returns 0 when he has recorded nothing yet, and the screen then says nothing
 * rather than inventing a comparison.
 */
export async function getSharedCostBaseline(parkId: string): Promise<{
  monthlyShared: number;
  payersNow: number;
}> {
  if (!(await assertMyPark(parkId))) return { monthlyShared: 0, payersNow: 0 };
  const admin = createServiceClient();

  const [{ data: costs }, { data: lots }] = await Promise.all([
    admin.from("park_costs")
      .select("category, amount_paid, period_start")
      .eq("park_id", parkId)
      .order("period_start", { ascending: false })
      .limit(40),
    admin.from("park_lots")
      .select("id, lifecycle, park_owned_home").eq("park_id", parkId),
  ]);

  // Only what actually gets split. `unit_electric` is a park-owned home's own
  // power and never touches a resident (0069, enforced by canSplit).
  const splittable = (costs ?? []).filter((c) => canSplit(c.category as CostCategory));
  const latest = splittable[0]?.period_start as string | undefined;
  const monthlyShared = latest
    ? splittable
        .filter((c) => String(c.period_start).slice(0, 7) === latest.slice(0, 7))
        .reduce((sum, c) => sum + Number(c.amount_paid ?? 0), 0)
    : 0;

  const live = (lots ?? []).filter((l) => (l.lifecycle as string ?? "live") === "live");
  const liveIds = live.map((l) => l.id as string);
  const { data: stays } = liveIds.length
    ? await admin.from("lot_reservations").select("park_lot_id")
        .in("park_lot_id", liveIds).in("status", ["approved", "active"])
    : { data: [] as Record<string, unknown>[] };
  const occupied = new Set((stays ?? []).map((s) => s.park_lot_id as string));

  const payersNow = live.filter(
    (l) => occupied.has(l.id as string) && !l.park_owned_home,
  ).length;

  return { monthlyShared: Math.round(monthlyShared * 100) / 100, payersNow };
}

// ------------------------------------------- bills that arrive every month --

/**
 * THE SHAPE OF A RECURRING BILL — the writer 0114 was missing.
 *
 * The table has been read by /park/today since the day it was created and
 * written by nothing, so the reminder feature existed entirely in the reader.
 * The owner had no way to say "the sewer bill lands on the 1st and runs about
 * $1,430", which is the only input the whole mechanism takes.
 */
export interface CostScheduleRow {
  id: string;
  category: CostCategory;
  dueDay: number;
  typicalAmount: number | null;
  label: string | null;
  active: boolean;
}

export async function listCostSchedules(parkId: string): Promise<CostScheduleRow[]> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();
  const { data } = await admin
    .from("park_cost_schedules")
    .select("id, category, due_day, typical_amount, label, active")
    .eq("park_id", parkId)
    .order("due_day", { ascending: true });

  // Switched-off rows come back too. They render greyed with a "switch on"
  // button — the same shape as fees — so retiring a reminder is reversible and
  // visible rather than a deletion he has to remember.
  return (data ?? []).map((r) => ({
    id: r.id as string,
    category: r.category as CostCategory,
    dueDay: Number(r.due_day ?? 5),
    typicalAmount: r.typical_amount == null ? null : Number(r.typical_amount),
    label: (r.label as string) ?? null,
    active: Boolean(r.active),
  }));
}

export async function saveCostSchedule(
  parkId: string,
  input: CostScheduleInput,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const built = buildCostScheduleRow(input);
  if (!built.ok || !built.row) return { ok: false, error: built.error };
  const row = built.row;

  const admin = createServiceClient();

  // SELECT FIRST — NOT UPSERT, AND NOT A BARE INSERT.
  //
  // The index is `(park_id, category) WHERE active`. Postgres only infers a
  // PARTIAL index as an ON CONFLICT arbiter when the statement carries the
  // matching predicate, and PostgREST's on_conflict takes column names with no
  // predicate — so `.upsert(row, { onConflict: "park_id,category" })` comes
  // back 42P10, which supabase-js hands over as {error, data:null}, which the
  // usual `if (error) return "try again"` turns into "try again" offered for a
  // path that can never work.
  //
  // A bare insert has the same ending one step later: he adds sewer, forgets,
  // adds it again, and 23505 reads as the same generic failure. Selecting
  // first turns the second add into an edit, which is what he meant.
  const { data: existing } = await admin
    .from("park_cost_schedules")
    .select("id")
    .eq("park_id", parkId)
    .eq("category", row.category)
    .maybeSingle();

  const { error } = existing?.id
    ? await admin.from("park_cost_schedules")
        .update(row).eq("id", existing.id as string).eq("park_id", parkId)
    : await admin.from("park_cost_schedules").insert({ park_id: parkId, ...row });

  if (error) {
    // Only reachable now from two tabs racing. Name the reminder that already
    // exists rather than saying "try again" about something that never will.
    if (error.code === "23505") {
      return {
        ok: false,
        error: `You already have a ${COST_CATEGORY_LABEL[row.category as CostCategory].toLowerCase()} reminder — edit that one instead.`,
      };
    }
    if (error.code === "23514") {
      return { ok: false, error: "That reminder has a day or an amount we can't store." };
    }
    return { ok: false, error: "Couldn't save that reminder — try again." };
  }

  // Edited on one screen, read on another. Revalidating only /park/costs would
  // leave the morning screen showing a reminder he just changed.
  revalidatePath("/park/costs");
  revalidatePath("/park/today");

  // HIS WORDS, VERBATIM. Lower-casing is only right for our own category label
  // mid-sentence ("Sewer" -> "sewer"); applied to a name he typed it turned
  // "LaGrange County sewer" into "lagrange county sewer" on screen.
  const name = row.label ?? COST_CATEGORY_LABEL[row.category as CostCategory].toLowerCase();
  return {
    ok: true,
    signal: `We'll look for the ${name} bill around the ${ordinal(row.due_day)}.`,
  };
}

export async function setCostScheduleActive(
  parkId: string,
  scheduleId: string,
  active: boolean,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();

  if (active) {
    // Switching one back on can collide with a newer reminder for the same
    // bill. Check before the partial index throws, so the message can name it.
    const { data: mine } = await admin
      .from("park_cost_schedules")
      .select("category").eq("id", scheduleId).eq("park_id", parkId).maybeSingle();
    if (!mine) return { ok: false, error: "That reminder isn't there any more." };

    const { data: clash } = await admin
      .from("park_cost_schedules")
      .select("id")
      .eq("park_id", parkId)
      .eq("category", mine.category as string)
      .eq("active", true)
      .neq("id", scheduleId)
      .maybeSingle();
    if (clash) {
      return {
        ok: false,
        error: `There's already a live ${COST_CATEGORY_LABEL[mine.category as CostCategory].toLowerCase()} reminder — switch that one off first.`,
      };
    }
  }

  const { error } = await admin
    .from("park_cost_schedules")
    .update({ active })
    .eq("id", scheduleId)
    .eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };

  revalidatePath("/park/costs");
  revalidatePath("/park/today");
  return {
    ok: true,
    signal: active
      ? "Back on — we'll mention it each month."
      : "Switched off — nothing deleted.",
  };
}
