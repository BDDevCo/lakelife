"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { buildStatement, type StatementFee } from "./statement-helpers";
import {
  planRun, toRows, summarise, currentPeriod,
  type Charge, type LedgerRow, type LedgerSummary, type RunPlan,
} from "./ledger-helpers";
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

async function feesFor(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
): Promise<StatementFee[]> {
  const { data } = await admin
    .from("park_fees")
    .select("label, amount, cadence, applies_to, active")
    .eq("park_id", parkId)
    .eq("active", true);
  return (data ?? [])
    .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string))
    .map((f) => ({
      label: f.label as string,
      amount: Number(f.amount),
      cadence: f.cadence as string,
    }));
}

/** What a run WOULD do. Nothing is written. */
export async function previewChargeRun(
  parkId: string,
  month: string,
): Promise<{ ok: boolean; error?: string; plan?: RunPlan }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };

  const admin = createServiceClient();
  const [{ data: park }, fees] = await Promise.all([
    admin.from("parks").select("rent_due_day").eq("id", parkId).maybeSingle(),
    feesFor(admin, parkId),
  ]);
  const dueDay = (park?.rent_due_day as number) ?? 1;

  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, rental_mode, lifecycle")
    .eq("park_id", parkId)
    .eq("lifecycle", "live");
  const lotById = new Map((lots ?? []).map((l) => [l.id as string, l]));
  if (lotById.size === 0) return { ok: true, plan: planRun([], new Set()) };

  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, quoted_amount, status")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active"]);

  const { data: existing } = await admin
    .from("park_charges")
    .select("reservation_id")
    .eq("park_id", parkId)
    .eq("period_month", month);
  const already = new Set((existing ?? []).map((c) => c.reservation_id as string));

  const candidates = (stays ?? []).map((s) => {
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    const st = range
      ? buildStatement({
          month,
          stay: range,
          rent: s.quoted_amount == null ? null : Number(s.quoted_amount),
          // A nightly home is priced per stay, not billed a monthly fee.
          fees: (lot.rental_mode as string) === "short_term" ? [] : fees,
          dueDay,
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
  const [{ data: park }, fees] = await Promise.all([
    admin.from("parks").select("rent_due_day").eq("id", parkId).maybeSingle(),
    feesFor(admin, parkId),
  ]);
  const dueDay = (park?.rent_due_day as number) ?? 1;

  const { data: lots } = await admin
    .from("park_lots")
    .select("id, lot_number, rental_mode")
    .eq("park_id", parkId)
    .eq("lifecycle", "live");
  const lotById = new Map((lots ?? []).map((l) => [l.id as string, l]));
  if (lotById.size === 0) return { ok: false, error: "No live lots to bill." };

  const { data: stays } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, quoted_amount")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active"]);

  const { data: existing } = await admin
    .from("park_charges").select("reservation_id")
    .eq("park_id", parkId).eq("period_month", month);
  const already = new Set((existing ?? []).map((c) => c.reservation_id as string));

  const rows: Record<string, unknown>[] = [];
  for (const s of stays ?? []) {
    if (already.has(s.id as string)) continue;
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    if (!range) continue;

    const st = buildStatement({
      month, stay: range,
      rent: s.quoted_amount == null ? null : Number(s.quoted_amount),
      fees: (lot.rental_mode as string) === "short_term" ? [] : fees,
      dueDay,
    });
    // No total = a rent nobody set. Billing zero would hide it behind a paid
    // charge; skipping leaves it visible on the roll where it belongs.
    if (st.total == null || st.total === 0) continue;

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
    return { ok: false, error: `Nothing to bill for ${month} — it may already be done.` };
  }

  const { error } = await admin.from("park_charges").insert(rows);
  if (error) return { ok: false, error: "Couldn't raise those — try again." };

  const total = rows.reduce((s, r) => s + (r.amount as number), 0);
  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    raised: rows.length,
    total,
    signal: `${rows.length} ${rows.length === 1 ? "bill" : "bills"} raised for ${month} — $${total.toFixed(2)}. Nobody has been told.`,
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
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "That payment amount isn't a number." };
  }

  const admin = createServiceClient();
  // Confirm the charge belongs to this park before writing against it.
  const { data: charge } = await admin
    .from("park_charges").select("id, park_id, amount, paid_total, status")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  if (!charge) return { ok: false, error: "That bill isn't here." };
  if (charge.status === "void") {
    return { ok: false, error: "That bill was cancelled — record it against a live one." };
  }

  const { error } = await admin.from("park_payments").insert({
    charge_id: chargeId,
    amount,
    method,
    reference: reference.trim() || null,
    received_on: receivedOn,
  });
  if (error) return { ok: false, error: "Couldn't record that — try again." };

  const balance = Number(charge.amount) - Number(charge.paid_total) - amount;
  revalidatePath("/park/rent");
  return {
    ok: true,
    signal: balance > 0
      ? `Recorded. $${balance.toFixed(2)} still outstanding.`
      : balance < 0
        ? `Recorded. They're $${Math.abs(balance).toFixed(2)} in credit.`
        : "Recorded — that one's settled.",
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
  const { data: existing } = await admin
    .from("park_charges").select("paid_total")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
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

  revalidatePath("/park/rent");
  return { ok: true, signal: "Cancelled." };
}

export interface LedgerPage {
  month: string;
  rows: LedgerRow[];
  summary: LedgerSummary;
  lagDays: number;
  today: string;
}

export async function getLedger(parkId: string, month?: string): Promise<LedgerPage | null> {
  if (!(await assertMyPark(parkId))) return null;
  const admin = createServiceClient();
  const today = todayLakeDate();
  const period = month ?? currentPeriod(today);

  const { data: park } = await admin
    .from("parks").select("office_recording_lag_days").eq("id", parkId).maybeSingle();
  const lagDays = (park?.office_recording_lag_days as number) ?? 3;

  const { data } = await admin
    .from("park_charges")
    .select("id, park_lot_id, renter_id, period_month, due_on, amount, paid_total, status")
    .eq("park_id", parkId)
    .eq("period_month", period);

  const lotIds = [...new Set((data ?? []).map((c) => c.park_lot_id as string))];
  const renterIds = [...new Set((data ?? []).map((c) => c.renter_id as string).filter(Boolean))];

  const [{ data: lots }, { data: renters }] = await Promise.all([
    lotIds.length
      ? admin.from("park_lots").select("id, lot_number").in("id", lotIds)
      : Promise.resolve({ data: [] as { id: string; lot_number: string }[] }),
    renterIds.length
      ? admin.from("park_renters").select("id, display_name").in("id", renterIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);

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

  const rows = toRows(charges, today, lagDays)
    // Late first — it is the only part that needs him today.
    .sort((a, b) => {
      const rank = (s: string) => (s === "late" ? 0 : s === "part_paid" ? 1 : s === "due" ? 2 : 3);
      return rank(a.state) - rank(b.state) || a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true });
    });

  return { month: period, rows, summary: summarise(rows), lagDays, today };
}
