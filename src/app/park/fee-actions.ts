"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { assertMyPark } from "./data";
import {
  checkCoverage, payersFor, monthlyIncome,
  type ParkFee, type FeeCadence, type FeeAppliesTo, type CoverageCheck,
} from "./fee-helpers";
import type { CostCategory } from "./cost-helpers";
import type { ParkResult } from "./actions";

const DENIED = "You don't manage that park.";

/** Whose hand this was. Null when we cannot tell, never a guess. */
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

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
  const [feeRes, lotsRes, costsRes] = await Promise.all([
    admin.from("park_fees")
      .select("id, label, amount, cadence, applies_to, covers, active")
      .eq("park_id", parkId).order("created_at"),
    admin.from("park_lots")
      .select("id, rental_mode, lifecycle, site_type").eq("park_id", parkId),
    admin.from("park_costs")
      .select("category, amount_paid, period_start, period_end").eq("park_id", parkId),
  ]);
  // This screen's whole job is the comparison between the two halves, so a
  // dropped read on either one shows a margin that was never measured — a fee
  // covering nothing, or costs covered by nothing.
  const feeRows = mustRead("your fees", feeRes);
  const lots = mustRead("your lots", lotsRes);
  const costs = mustRead("your bills", costsRes);

  const live = (lots ?? []).filter((l) => (l.lifecycle as string) === "live");

  // WHO IS ACTUALLY BILLED. A fee rides on a rent bill, and an empty lot gets
  // none — so counting every live lot overstated fee income by exactly the
  // vacancy the park now carries on the cost side, and the two halves of this
  // screen disagreed by the amount it exists to make visible.
  const liveStays = mustRead("who is on your lots", live.length
    ? await admin
        .from("lot_reservations")
        .select("park_lot_id")
        .in("park_lot_id", live.map((l) => l.id as string))
        .in("status", ["approved", "active"])
    : { data: [] as Record<string, unknown>[], error: null });
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
    const assigns = mustRead("who has opted in to each fee", await admin
      .from("lot_fee_assignments").select("fee_id").in("fee_id", ids));
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
  if (!Number.isFinite(input.amount)) {
    return { ok: false, error: "That amount isn't a number." };
  }
  // A ZERO FEE IS A LINE ON NINETEEN BILLS THAT SAYS $0.00.
  //
  // The database allows `amount >= 0`, this checked only for negatives, and the
  // Save button blocks an empty box but not the string "0" — so a fee could be
  // saved at zero and `buildStatement` would push a $0.00 line onto every
  // charge, frozen into `park_charges.lines` where it cannot be edited out. A
  // fee somebody has not decided the price of yet is not a fee; it is a note.
  if (input.amount <= 0) {
    return { ok: false, error: "A fee needs an amount. If you haven't settled on one yet, add it when you have." };
  }

  const admin = createServiceClient();

  // TWO ACTIVE FEES WITH THE SAME NAME BOTH BILL.
  //
  // There is no unique index on (park_id, label) and no way to EDIT a fee from
  // the screen, so the obvious way to fix a wrong amount — add it again with
  // the right one — silently charges the resident twice, on two lines with the
  // same label. Switching the old one off is the correct move and this says so.
  const clash = mustRead("your existing fees", await admin
    .from("park_fees")
    .select("id, label")
    .eq("park_id", parkId)
    .eq("active", true)
    .ilike("label", label));
  if ((clash ?? []).some((f) => (f.id as string) !== input.id)) {
    return {
      ok: false,
      error: `You already have an active fee called "${label}". Edit that one, or switch it off first — two with the same name would both be charged.`,
    };
  }

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
    // WHO ADDED IT. `created_by` has existed since 0067 and nothing has ever
    // written it, so the one question a disputed line provokes — who put this
    // on my bill — had no answer. Written only on insert: an edit is a
    // different act from an addition, and overwriting it would erase the
    // person who made the original decision.
    : await admin.from("park_fees").insert({ ...row, created_by: await currentUserId() });

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
