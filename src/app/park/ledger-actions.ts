"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { buildStatement, type StatementFee } from "./statement-helpers";
import {
  planRun, toRows, summarise, currentPeriod,
  type Charge, type LedgerRow, type LedgerSummary, type RunPlan,
} from "./ledger-helpers";
import { sendEmail } from "@/lib/email";
import { receiptBody, type ReceiptLines } from "./receipt-helpers";
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
  /** The serial off the slip they dropped in the box, when that is how it came. */
  dropSlipNo?: string,
): Promise<ParkResult & { receipt?: ReceiptLines; renterEmail?: string | null }> {
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

  // The insert returns the receipt number the trigger assigned, so the renter
  // can walk away with proof of what they just handed over.
  const { data: written, error } = await admin.from("park_payments").insert({
    charge_id: chargeId,
    amount,
    method,
    reference: reference.trim() || null,
    received_on: receivedOn,
    drop_slip_no: dropSlipNo?.trim() || null,
  }).select("receipt_no").single();
  if (error) return { ok: false, error: "Couldn't record that — try again." };

  const balance = Number(charge.amount) - Number(charge.paid_total) - amount;

  // Everything the receipt needs, gathered once here rather than by a second
  // round trip from the screen.
  const [{ data: park }, { data: full }] = await Promise.all([
    admin.from("parks").select("name, address").eq("id", parkId).maybeSingle(),
    admin
      .from("park_charges")
      .select("period_month, amount, park_lot_id, renter_id")
      .eq("id", chargeId)
      .maybeSingle(),
  ]);
  const [{ data: lot }, { data: renter }] = await Promise.all([
    full?.park_lot_id
      ? admin.from("park_lots").select("lot_number").eq("id", full.park_lot_id).maybeSingle()
      : Promise.resolve({ data: null }),
    full?.renter_id
      ? admin.from("park_renters").select("display_name, email, contact_pref")
          .eq("id", full.renter_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const receipt: ReceiptLines = {
    parkName: (park?.name as string) ?? "This park",
    officeLine: park?.address
      ? `Questions? The office — ${park.address}.`
      : "Questions? Ask at the office.",
    receiptNo: (written?.receipt_no as number) ?? null,
    lotNumber: (lot?.lot_number as string) ?? "?",
    payerName: (renter?.display_name as string) ?? null,
    amount,
    method,
    reference: reference.trim() || null,
    receivedOn,
    periodMonth: (full?.period_month as string) ?? "",
    billAmount: Number(full?.amount ?? charge.amount),
    balanceAfter: Math.round(balance * 100) / 100,
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
  const { data: park } = await admin
    .from("parks").select("name, address, next_drop_slip_no").eq("id", parkId).maybeSingle();
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

  // UNANSWERED "I PAID THIS" claims. A charge carrying one is disputed, not
  // late — the two parties disagree, and disagreement is a question rather
  // than a delinquency.
  const chargeIds = (data ?? []).map((c) => c.id as string);
  const { data: claims } = chargeIds.length
    ? await admin
        .from("park_payment_claims")
        .select("charge_id")
        .in("charge_id", chargeIds)
        .is("resolved_at", null)
    : { data: [] as { charge_id: string }[] };
  const claimed = new Set((claims ?? []).map((c) => c.charge_id as string));

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

  const rows = toRows(charges, today, lagDays, claimed)
    // Late first — it is the only part that needs him today.
    .sort((a, b) => {
      // Disputed first: it is the only row that says we might be wrong.
      const rank = (s: string) =>
        s === "disputed" ? 0 : s === "late" ? 1 : s === "part_paid" ? 2 : s === "due" ? 3 : 4;
      return rank(a.state) - rank(b.state) || a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true });
    });

  return { month: period, rows, summary: summarise(rows), lagDays, today };
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
  const { data: charge } = await admin
    .from("park_charges").select("id").eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  if (!charge) return { ok: false, error: "That bill isn't here." };

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
  const { data: claim } = await admin
    .from("park_payment_claims")
    .select("id, charge_id, park_charges!inner(park_id)")
    .eq("id", claimId)
    .maybeSingle();
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

  revalidatePath("/park/rent");
  return {
    ok: true,
    signal: resolution === "not_found"
      ? "Recorded. That bill is back in arrears."
      : "Recorded.",
  };
}

async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}
