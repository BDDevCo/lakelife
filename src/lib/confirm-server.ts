import { createServiceClient } from "@/lib/supabase/server";
import { receiptRef, METHOD_WORD } from "@/app/park/receipt-helpers";

/**
 * THE RENTER'S OWN CONFIRMATION — the only part of the ledger they can act on.
 *
 * There is no bank in the middle of these lakes. Cash sits in a drawer until
 * somebody drives to town, and often longer than that, so nothing external will
 * ever tell us who paid or when. The record can only be validated by the two
 * people who were there.
 *
 * WHY A LINK AND NOT A TICKBOX. "The owner ticked a box saying the renter
 * agreed" is still ONE party — it has exactly the flaw the whole exercise is
 * trying to fix. A tap that arrives from the renter's own phone, on a token
 * only they were sent, is an act the owner did not perform. That distinction is
 * the entire value.
 *
 * NO ACCOUNT REQUIRED, deliberately. Most of this park will never make one, and
 * a confirmation that only signed-in renters can give would protect precisely
 * the households least at risk. Same one-tap, no-account discipline as the
 * extend-stay links.
 *
 * DISAGREEING IS AS EASY AS AGREEING. A page with only a "yes" button is a
 * rubber stamp. "That's not what I paid" files a claim against the bill, which
 * marks it disputed and stops the reminders — the same machinery a renter gets
 * when they tell the office in person.
 */

export interface ConfirmView {
  parkName: string;
  lotNumber: string;
  amount: number;
  method: string;
  reference: string | null;
  receivedOn: string;
  ref: string;
  alreadyConfirmedAt: string | null;
}

export async function loadPaymentByToken(token: string): Promise<ConfirmView | null> {
  if (!token || token.length < 12) return null;
  const admin = createServiceClient();

  const { data: pay } = await admin
    .from("park_payments")
    .select("id, charge_id, amount, method, reference, received_on, receipt_no, renter_confirmed_at")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!pay) return null;

  const { data: charge } = await admin
    .from("park_charges").select("park_id, park_lot_id").eq("id", pay.charge_id as string).maybeSingle();
  if (!charge) return null;

  const [{ data: park }, { data: lot }] = await Promise.all([
    admin.from("parks").select("name").eq("id", charge.park_id as string).maybeSingle(),
    admin.from("park_lots").select("lot_number").eq("id", charge.park_lot_id as string).maybeSingle(),
  ]);

  const parkName = (park?.name as string) ?? "the park";
  return {
    parkName,
    lotNumber: (lot?.lot_number as string) ?? "?",
    amount: Number(pay.amount),
    method: METHOD_WORD[pay.method as string] ?? (pay.method as string),
    reference: (pay.reference as string) ?? null,
    receivedOn: pay.received_on as string,
    ref: receiptRef(parkName, (pay.receipt_no as number) ?? null, pay.received_on as string),
    alreadyConfirmedAt: (pay.renter_confirmed_at as string) ?? null,
  };
}

/** "Yes, that's right." Recorded as the renter's act, not the park's. */
export async function confirmByToken(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const { data: pay } = await admin
    .from("park_payments").select("id, renter_confirmed_at").eq("confirm_token", token).maybeSingle();
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };
  // Confirming twice is not an error — people tap links twice.
  if (pay.renter_confirmed_at) return { ok: true };

  const { error } = await admin
    .from("park_payments")
    .update({ renter_confirmed_at: new Date().toISOString(), renter_confirmed_via: "link" })
    .eq("id", pay.id as string);
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}

/**
 * "That's not what I paid."
 *
 * Files a claim against the BILL rather than editing the payment. The renter is
 * not given the power to rewrite the park's record — nobody should have that
 * unilaterally — but the disagreement now exists, the charge reads as disputed,
 * and the reminders stop until a person has looked at it.
 */
export async function disputeByToken(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const { data: pay } = await admin
    .from("park_payments").select("id, charge_id, amount, received_on").eq("confirm_token", token).maybeSingle();
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };

  const { data: open } = await admin
    .from("park_payment_claims")
    .select("id")
    .eq("charge_id", pay.charge_id as string)
    .is("resolved_at", null)
    .maybeSingle();
  if (open) return { ok: true }; // already flagged; don't stack duplicates

  const { error } = await admin.from("park_payment_claims").insert({
    charge_id: pay.charge_id,
    asserted_by: "renter",
    note:
      `They say the receipt is wrong — it records $${Number(pay.amount).toFixed(2)} ` +
      `taken on ${pay.received_on}. Raised from their own confirmation link.`,
  });
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}
