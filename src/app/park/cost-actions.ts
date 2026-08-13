"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { parseDaterange, overlaps } from "@/lib/parks";
import {
  allocateCost, recoveryByCategory,
  type CostCategory, type CostLot, type CostAllocation,
} from "./cost-helpers";
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
  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, active")
    .eq("park_id", parkId)
    .eq("active", true);

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
): Promise<ParkResult & { perLot?: number; parkAbsorbs?: number }> {
  const pre = await previewCostSplit(parkId, category, periodStart, periodEnd, amountPaid);
  if (!pre.ok || !pre.preview) return { ok: false, error: pre.error };

  const { allocation } = pre.preview;
  if (allocation.problem === "no_occupied_lots") {
    return { ok: false, error: "Nobody was on a lot for that period, so there's nothing to split." };
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
      allocated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (costErr || !cost) return { ok: false, error: "Couldn't save that bill — try again." };

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
    .select("id, category, period_start, period_end, amount_paid, allocated_total, source_note")
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

  const rows: CostRow[] = (data ?? []).map((c) => ({
    billedTotal: billed.get(c.id as string) ?? 0,
    id: c.id as string,
    category: c.category as CostCategory,
    periodStart: c.period_start as string,
    periodEnd: c.period_end as string,
    amountPaid: Number(c.amount_paid),
    allocatedTotal: Number(c.allocated_total),
    sourceNote: (c.source_note as string) ?? null,
    lots: counts.get(c.id as string) ?? 0,
  }));

  return {
    rows,
    summary: recoveryByCategory(
      rows.map((r) => ({
        category: r.category, amountPaid: r.amountPaid, allocatedTotal: r.allocatedTotal,
        billedTotal: r.billedTotal,
      })),
    ),
  };
}
