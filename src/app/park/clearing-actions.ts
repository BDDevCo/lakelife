"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { readFailedMessage } from "@/lib/must-read";
import { todayLakeDate } from "@/lib/booking";
import { money } from "@/lib/allocations";
import {
  clearingRefusal, inFlight, returnRefusal, returnReason, whatToDoAfterReturn,
  returnSaidToResident, type InFlightKind,
} from "./clearing-helpers";

/**
 * THE OUTLET THE BANK RAIL NEVER HAD.
 *
 * 0155 added `returned_at` / `return_code` and said in its own header:
 * "NOTHING IN THE APP WRITES `returned_at` YET... the writer is the webhook
 * that does not exist." 0191 added `settled_at` the same way. The webhook
 * arrived with 0157 — but it records events and deliberately decides no
 * policy, and the handler that drains it was left "after the processor call,
 * against real event names". Nobody wrote the half in between.
 *
 * So the state until this file: five screens explain money that is on its way,
 * the reminder run refuses to chase it, the arrears figure correctly leaves it
 * out — and nothing in the application could ever say it arrived. A household
 * reads "$542.53 is on its way from your bank and takes a few days" on
 * `RenterHome` and that sentence has no end.
 *
 * ============ WHY A PERSON, AND NOT THE PROCESSOR ============
 *
 * The same reason `OpsPaymentSetup` records a merchant id a human read off a
 * dashboard: the processor's event names, their timing and their payload shape
 * are Step 1 of the processor roadmap and nobody has answered it. A guessed
 * event map would be an integration written against a contract that does not
 * exist, and it would be WRONG in the direction that matters — silently
 * marking money as landed.
 *
 * What a person always has is their own bank statement. Rent settles to the
 * park's own account under Architecture A, so the owner is the one who can see
 * it. That makes this door the honest shape for a pilot AND the permanent
 * fallback for the day the processor is late or quiet — which is the day this
 * matters most. When the drain exists it calls the same two writes.
 *
 * ============ WHAT THIS FILE MUST NEVER DO ============
 *
 * It never moves money and it never talks to a processor: it records what a
 * bank already did. A clearing stamp is not a charge and a return is not a
 * refund — 0155's header is explicit that sending money back here would pay
 * out a second time against a debit that never settled. There is no `fetch`
 * in this file and a test refuses one.
 */

export interface ClearingResult {
  ok: boolean;
  error?: string;
  signal?: string;
  /** The same fact in the household's words, for whoever tells them. */
  saidToResident?: string;
}

const DENIED = "You don't manage that park.";

/** Everything the two writers need off the row, read once. */
const ROW = "id, amount, method, received_on, receipt_no, settled_at, returned_at, return_code, reversed_at, charge_id, renter_id";

export interface InFlightPayment {
  id: string;
  amountCents: number;
  receivedOn: string;
  receiptNo: number | null;
  reference: string | null;
  lotNumber: string | null;
  payerName: string | null;
  periodMonth: string | null;
  kind: InFlightKind;
  weekdays: number | null;
  said: string;
}

/**
 * MONEY ASKED FOR AND NOT LANDED, oldest first.
 *
 * NULL ON A FAILED READ, never an empty list. "Nothing is on its way" is the
 * reassuring way to be wrong about money in flight: it is the sentence that
 * makes a stuck debit invisible, and a stuck debit is usually one the
 * processor never sent.
 *
 * The three exclusions are the same three every other reader of this table
 * uses: a reversed row never happened, a bank-returned row came back, and a
 * settled row has landed. What is left is genuinely in flight.
 */
export async function getMoneyInFlight(parkId: string): Promise<InFlightPayment[] | null> {
  if (!(await assertMyPark(parkId))) return null;
  const admin = createServiceClient();
  const today = todayLakeDate();

  const [payRes, lotRes, renterRes] = await Promise.all([
    admin
      .from("park_payments")
      .select(`${ROW}, reference, park_charges(period_month, park_lot_id)`)
      .eq("park_id", parkId)
      .is("settled_at", null)
      .is("reversed_at", null)
      .is("returned_at", null)
      .order("received_on", { ascending: true }),
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_renters").select("id, display_name").eq("park_id", parkId),
  ]);
  if (payRes.error) {
    console.error("[clearing] money in flight:", payRes.error.message);
    return null;
  }
  // A MISSING NAME IS NOT A MISSING ANSWER. The lot and household reads are
  // decoration on a row whose money is the point, so they degrade to null
  // rather than hiding a debit nobody is watching.
  if (lotRes.error) console.error("[read failed, degraded] lot numbers for money in flight:", lotRes.error.message);
  if (renterRes.error) console.error("[read failed, degraded] household names for money in flight:", renterRes.error.message);

  const lotName = new Map((lotRes.data ?? []).map((l) => [l.id as string, l.lot_number as string]));
  const renterName = new Map((renterRes.data ?? []).map((r) => [r.id as string, r.display_name as string]));

  return (payRes.data ?? []).map((p) => {
    const charge = Array.isArray(p.park_charges) ? p.park_charges[0] : p.park_charges;
    const c = (charge ?? null) as { period_month?: string; park_lot_id?: string } | null;
    const verdict = inFlight({ receivedOn: String(p.received_on ?? ""), today });
    return {
      id: p.id as string,
      amountCents: Math.round(Number(p.amount ?? 0) * 100),
      receivedOn: String(p.received_on ?? ""),
      receiptNo: (p.receipt_no as number | null) ?? null,
      reference: (p.reference as string | null) ?? null,
      lotNumber: c?.park_lot_id ? lotName.get(c.park_lot_id) ?? null : null,
      payerName: p.renter_id ? renterName.get(p.renter_id as string) ?? null : null,
      periodMonth: c?.period_month ?? null,
      kind: verdict.kind,
      weekdays: verdict.weekdays,
      said: verdict.said,
    };
  });
}

/** The row, proven to be this park's, or a sentence saying why not. */
async function theRow(parkId: string, paymentId: string) {
  if (!(await assertMyPark(parkId))) return { ok: false as const, error: DENIED };
  const admin = createServiceClient();
  const res = await admin
    .from("park_payments")
    .select(ROW)
    .eq("id", paymentId)
    // SCOPED TO THE PARK THE CALLER JUST PROVED IS THEIRS, not merely to the
    // id. An id out of a form is a value from a browser, and `park_id` is NOT
    // NULL on this table since 0102, so there is no row this cannot fence.
    .eq("park_id", parkId)
    .maybeSingle();
  // "That isn't here" about a payment sitting on their own screen is a lie a
  // dropped connection tells; money: true marks it as a figure, not a form.
  if (res.error) {
    return { ok: false as const, error: readFailedMessage("that payment", res.error, { money: true }) };
  }
  if (!res.data) return { ok: false as const, error: "That isn't here." };
  return { ok: true as const, admin, pay: res.data as Record<string, unknown> };
}

function refreshed() {
  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park/statements");
  // The household's own ledger. Their bill moves on this write, so the screen
  // that told them it was on its way has to stop saying so.
  revalidatePath("/portal");
}

/**
 * IT LANDED. The money is really in the park's account.
 *
 * One stamp, and everything else follows from the database: 0191 recomputes
 * every bill the payment touched, and settles any open claim the household had
 * made about it. Nothing here adds up a total or writes a status — that is
 * exactly how two screens come to disagree about what a household owes.
 */
export async function markBankPaymentCleared(
  parkId: string, paymentId: string,
): Promise<ClearingResult> {
  const got = await theRow(parkId, paymentId);
  if (!got.ok) return { ok: false, error: got.error };
  const { admin, pay } = got;

  const refusal = clearingRefusal({
    settledAt: pay.settled_at as string | null,
    returnedAt: pay.returned_at as string | null,
    reversedAt: pay.reversed_at as string | null,
    method: pay.method as string | null,
  });
  if (refusal) return { ok: false, error: refusal };

  // FILTERED ON `settled_at is null` AT THE WRITE, not just checked above.
  // Two people on the same screen is the ordinary case on a shared office
  // login, and 0191 makes settlement one-way — so without this filter the
  // second click reaches the trigger and a human reads "settlement is
  // recorded once" as a database error. Matching no rows is the same answer,
  // in words the reader can use.
  const { data, error } = await admin
    .from("park_payments")
    .update({ settled_at: new Date().toISOString() })
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .is("settled_at", null)
    .is("returned_at", null)
    .is("reversed_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That one has already landed." };

  refreshed();
  const amount = money(Math.round(Number(pay.amount ?? 0) * 100));
  return {
    ok: true,
    signal:
      `${amount} has landed. ` +
      (pay.charge_id
        ? "The bill it was paying counts it now."
        : "It is on their account now and comes off their next bill."),
  };
}

/**
 * THE BANK TOOK IT BACK.
 *
 * The money that arrived is gone again and none of it was our decision. 0155
 * built this as a THIRD act for a reason: a reversal would claim it never
 * happened (and the database refuses that on this rail), a refund would send
 * money out a second time against a debit that never settled, and deleting
 * the row would take the receipt number with it. So the row stays, keeps its
 * receipt, and stops counting.
 *
 * A RETURN AFTER IT CLEARED IS THE NORMAL CASE, not an edge: a debit succeeds
 * on Monday and is pulled back on Thursday. Proven against production — the
 * bill goes from paid back to open, with the receipt intact.
 */
export async function recordBankReturn(
  parkId: string, paymentId: string, code: string,
): Promise<ClearingResult> {
  const got = await theRow(parkId, paymentId);
  if (!got.ok) return { ok: false, error: got.error };
  const { admin, pay } = got;

  const refusal = returnRefusal({
    code,
    method: pay.method as string | null,
    alreadyReturnedAt: pay.returned_at as string | null,
    reversedAt: pay.reversed_at as string | null,
  });
  if (refusal) return { ok: false, error: refusal };

  const reason = returnReason(code);
  if (!reason) return { ok: false, error: "Pick what the bank said." };

  // THE CODE IS WRITTEN WITH THE RETURN, never after it. 0155's constraint —
  // `check (return_code is null or returned_at is not null)` — refuses a code
  // alone, and 0191's freeze refuses adding one later. One write, or none.
  //
  // AND NOTHING ELSE ON THE ROW IS TOUCHED. The first draft of this appended
  // what the bank said to `note`; 0191 freezes it as "the note that went on
  // the receipt" and production refused the write. The code carries the reason.
  const { data, error } = await admin
    .from("park_payments")
    .update({
      returned_at: new Date().toISOString(),
      return_code: reason.code,
    })
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .is("returned_at", null)
    .is("reversed_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "The bank already sent that one back." };

  refreshed();
  const amount = money(Math.round(Number(pay.amount ?? 0) * 100));
  const receipt = pay.receipt_no ? ` (receipt ${pay.receipt_no})` : "";
  return {
    ok: true,
    signal:
      `${amount}${receipt} came back — ${reason.said.toLowerCase()}. ` +
      whatToDoAfterReturn(reason.code),
    saidToResident: returnSaidToResident({ code: reason.code, amount }),
  };
}

