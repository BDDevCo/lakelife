"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import {
  checkCoverage, payersFor, monthlyIncome,
  type ParkFee, type FeeCadence, type FeeAppliesTo, type CoverageCheck,
} from "./fee-helpers";
import type { CostCategory } from "./cost-helpers";
import type { ParkResult } from "./actions";

const DENIED = "You don't manage that park.";

export interface FeeView extends ParkFee {
  payers: number;
  monthly: number;
}

export interface FeesPage {
  fees: FeeView[];
  coverage: CoverageCheck;
  /** Lots the grounds-style fees land on — the divisor for "per lot". */
  coveragePayers: number;
  monthsObserved: number;
}

/**
 * Fees, what each brings in, and whether they cover the costs they claim to.
 *
 * `monthsObserved` is counted from the actual billing periods on record: three
 * months of water bills is not three months of cost per month, and treating it
 * that way would raise a false alarm at three times the real rate.
 */
export async function listFees(parkId: string): Promise<FeesPage> {
  const empty: FeesPage = {
    fees: [],
    coverage: { feeIncome: 0, actualCost: 0, margin: 0, unverified: [], uncovered: [] },
    coveragePayers: 0,
    monthsObserved: 1,
  };
  if (!(await assertMyPark(parkId))) return empty;

  const admin = createServiceClient();
  const [{ data: feeRows }, { data: lots }, { data: costs }] = await Promise.all([
    admin.from("park_fees")
      .select("id, label, amount, cadence, applies_to, covers, active")
      .eq("park_id", parkId).order("created_at"),
    admin.from("park_lots")
      .select("id, rental_mode, lifecycle, site_type").eq("park_id", parkId),
    admin.from("park_costs")
      .select("category, amount_paid, period_start, period_end").eq("park_id", parkId),
  ]);

  const live = (lots ?? []).filter((l) => (l.lifecycle as string) === "live");

  // WHO IS ACTUALLY BILLED. A fee rides on a rent bill, and an empty lot gets
  // none — so counting every live lot overstated fee income by exactly the
  // vacancy the park now carries on the cost side, and the two halves of this
  // screen disagreed by the amount it exists to make visible.
  const { data: liveStays } = live.length
    ? await admin
        .from("lot_reservations")
        .select("park_lot_id")
        .in("park_lot_id", live.map((l) => l.id as string))
        .in("status", ["approved", "active"])
    : { data: [] as Record<string, unknown>[] };
  const occupied = new Set((liveStays ?? []).map((s) => s.park_lot_id as string));

  const counts = {
    longTerm: live.filter(
      (l) => (l.rental_mode as string) !== "short_term"
        && !["slip", "storage"].includes(l.site_type as string)
        && occupied.has(l.id as string),
    ).length,
    shortTerm: live.filter((l) => (l.rental_mode as string) === "short_term").length,
    optedIn: 0,
  };

  const ids = (feeRows ?? []).map((f) => f.id as string);
  const optedInBy = new Map<string, number>();
  if (ids.length) {
    const { data: assigns } = await admin
      .from("lot_fee_assignments").select("fee_id").in("fee_id", ids);
    for (const a of assigns ?? []) {
      const k = a.fee_id as string;
      optedInBy.set(k, (optedInBy.get(k) ?? 0) + 1);
    }
  }

  const fees: FeeView[] = (feeRows ?? []).map((f) => {
    const fee: ParkFee = {
      id: f.id as string,
      label: f.label as string,
      amount: Number(f.amount),
      cadence: f.cadence as FeeCadence,
      appliesTo: f.applies_to as FeeAppliesTo,
      covers: (f.covers as CostCategory[]) ?? [],
      active: f.active as boolean,
    };
    const payers = payersFor(fee, { ...counts, optedIn: optedInBy.get(fee.id) ?? 0 });
    return { ...fee, payers, monthly: monthlyIncome(fee, payers) };
  });

  // How many distinct months the recorded bills actually span.
  const months = new Set<string>();
  for (const c of costs ?? []) months.add((c.period_start as string).slice(0, 7));
  const monthsObserved = Math.max(1, months.size);

  const payersByFee = new Map(fees.map((f) => [f.id, f.payers]));
  const coverage = checkCoverage(
    fees, payersByFee,
    (costs ?? []).map((c) => ({
      category: c.category as CostCategory, amountPaid: Number(c.amount_paid),
    })),
    monthsObserved,
  );

  return {
    fees,
    coverage,
    coveragePayers: Math.max(...fees.map((f) => f.payers), 0),
    monthsObserved,
  };
}

export async function saveFee(
  parkId: string,
  input: {
    id?: string;
    label: string;
    amount: number;
    cadence: FeeCadence;
    appliesTo: FeeAppliesTo;
    covers: string[];
  },
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const label = input.label.trim();
  if (label.length < 2) return { ok: false, error: "Give the fee a name residents will recognise." };
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    return { ok: false, error: "That amount isn't a number." };
  }

  const admin = createServiceClient();
  const row = {
    park_id: parkId,
    label,
    amount: input.amount,
    cadence: input.cadence,
    applies_to: input.appliesTo,
    covers: input.covers,
  };

  const { error } = input.id
    ? await admin.from("park_fees").update(row).eq("id", input.id).eq("park_id", parkId)
    : await admin.from("park_fees").insert(row);

  if (error) {
    // The covers allowlist. Unreachable from the UI, which offers checkboxes.
    if (error.code === "23514") {
      return { ok: false, error: "That fee claims to cover something we can't check it against." };
    }
    return { ok: false, error: "Couldn't save that fee — try again." };
  }

  revalidatePath("/park/costs");
  return { ok: true, signal: `${label} saved.` };
}

export async function setFeeActive(
  parkId: string, feeId: string, active: boolean,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();
  const { error } = await admin
    .from("park_fees").update({ active }).eq("id", feeId).eq("park_id", parkId);
  if (error) return { ok: false, error: "Couldn't change that — try again." };
  revalidatePath("/park/costs");
  return { ok: true, signal: active ? "Fee switched on." : "Fee switched off — nothing deleted." };
}
