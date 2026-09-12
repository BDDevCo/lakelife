import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage, ReadFailed } from "@/lib/must-read";
import { isBearerToken } from "@/lib/token-format";
import { receiptRef, METHOD_WORD } from "@/app/park/receipt-helpers";
import { longDate } from "@/lib/lake-time";

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
  /**
   * WHAT THEY HANDED OVER — the whole of it. A payment for more than the bill
   * is recorded as two rows (recordPayment: the bill's share against the
   * charge, the rest on account), and the receipt's link carries the bill
   * row's token. Asking "does this match what you handed over?" against
   * $542.53 when she handed $600 manufactures a dispute, so the on-account
   * sibling is folded back in here. What the card was actually charged is
   * amount + fee.
   */
  amount: number;
  /** The part of `amount` that went on account with the office, or null when none did. */
  onAccount: number | null;
  /**
   * Whether the office has since put that part against a bill. This page is
   * a permanent URL printed on paper, and "held for you, not yet put against
   * a bill" was true the day the receipt was written and false from the day
   * applyOnAccount set the sibling's charge_id. Read, never assumed.
   */
  onAccountApplied: boolean;
  /** Card convenience fee charged on top, or null. */
  fee: number | null;
  method: string;
  reference: string | null;
  receivedOn: string;
  ref: string;
  alreadyConfirmedAt: string | null;
}

/** The key recordPayment gives the on-account half of a split — spelled once. */
function siblingKey(key: string): string {
  return `${key}:onaccount`;
}

/**
 * THE OTHER HALF OF A SPLIT PAYMENT — one helper, because three doors read it.
 *
 * recordPayment writes the on-account row under the bill row's key +
 * ":onaccount", in the same insert, and the receipt's link carries the bill
 * row's token. The page that asks "does this match what you handed over?",
 * the claim filed when the answer is "no", and the stamp written when the
 * answer is "yes" must therefore all cover the SAME money: she reads $600 on
 * the page, taps "That's not what I paid", and the office must see a claim
 * about $600 — not one that says the receipt records $542.53, a number nobody
 * printed for her. Taps "Yes, that's right", and both rows carry her
 * confirmation, not just the one whose token she had. One rule in one place,
 * so the next door that quotes a receipt cannot fold half of it in.
 *
 * WHERE THE REST SITS is read, not assumed: applyOnAccount moves it by
 * setting the sibling's charge_id, and the receipt's link is a permanent URL.
 * `onAccountApplied` is how the page stops saying "held for you" about money
 * that was put against February a month ago.
 *
 * Only a row against a bill can have a sibling. mustRead, never maybe: a
 * failed read here would show the bill's share as the whole and ask her to
 * agree to it (or file a claim about it). Callers that return `{ ok, error }`
 * rather than throw must catch ReadFailed.
 */
async function wholeHandedOver(
  admin: ReturnType<typeof createServiceClient>,
  pay: { charge_id: unknown; amount: unknown; idempotency_key: unknown },
): Promise<{
  amount: number;
  onAccount: number | null;
  onAccountApplied: boolean;
  /** The sibling row's id, so a stamp can land on both halves in one update. */
  siblingId: string | null;
}> {
  const key = (pay.idempotency_key as string | null) ?? null;
  const sibling = pay.charge_id && key
    ? mustRead("the rest of that payment", await admin
        .from("park_payments")
        .select("id, amount, charge_id")
        .eq("idempotency_key", siblingKey(key))
        .is("reversed_at", null)
        .maybeSingle())
    : null;
  const onAccount = sibling ? Number(sibling.amount) : null;
  return {
    amount: Math.round((Number(pay.amount) + (onAccount ?? 0)) * 100) / 100,
    onAccount,
    onAccountApplied: sibling?.charge_id != null,
    siblingId: sibling ? (sibling.id as string) : null,
  };
}

export async function loadPaymentByToken(token: string): Promise<ConfirmView | null> {
  // Was `token.length < 12` — a length floor is not a shape check, so any
  // 12-character string reached `.eq()`. park_payments.confirm_token is minted
  // as 32 hex + 8 hex (park/ledger-actions.ts, park/money-actions.ts), so the
  // shared 32-char default fits it with room to spare.
  if (!isBearerToken(token)) return null;
  const admin = createServiceClient();

  // `return null` renders "This link doesn't match a payment" — a flat denial
  // that their receipt exists. Only say it when we actually looked.
  const pay = mustRead("your receipt", await admin
    .from("park_payments")
    .select("id, charge_id, park_id, kind, amount, fee_amount, method, reference, received_on, receipt_no, renter_confirmed_at, idempotency_key")
    .eq("confirm_token", token)
    .maybeSingle());
  if (!pay) return null;

  const { amount, onAccount, onAccountApplied } = await wholeHandedOver(admin, pay);

  // A PAYMENT NEED NOT HAVE A CHARGE ANY MORE (0102). This resolved the park by
  // reading it OFF the charge and bailed when there wasn't one — so the
  // confirmation link minted for a deposit, or for a cheque handed over before
  // the bill existed, pointed at a "not found" page. The renter's own
  // confirmation is the only second party this ledger will ever have, and it
  // matters MOST for money with no bill to check it against.
  const charge = mustRead("the bill behind it", pay.charge_id
    ? await admin
        .from("park_charges").select("park_id, park_lot_id").eq("id", pay.charge_id as string).maybeSingle()
    : { data: null, error: null });

  const parkId = (charge?.park_id as string) ?? (pay.park_id as string) ?? null;
  if (!parkId) return null;

  const [parkRes, lotRes] = await Promise.all([
    admin.from("parks").select("name").eq("id", parkId).maybeSingle(),
    charge?.park_lot_id
      ? admin.from("park_lots").select("lot_number").eq("id", charge.park_lot_id as string).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  // "the park" and "?" are the fallbacks for rows that genuinely carry neither.
  // A failed read reaching them would print a receipt with the park's name
  // rubbed off, and ask somebody to agree to it.
  const park = mustRead("the park", parkRes);
  const lot = mustRead("the lot", lotRes);

  const parkName = (park?.name as string) ?? "the park";
  return {
    parkName,
    // A deposit or a cheque with no bill has no lot on the record. Say so
    // rather than printing "?" as though something were missing.
    lotNumber: (lot?.lot_number as string) ?? (pay.charge_id ? "?" : "—"),
    amount,
    onAccount,
    onAccountApplied,
    // Asking "does this match what you handed over?" while showing a figure
    // smaller than the one on their bank statement invites a dispute we caused.
    fee: pay.fee_amount == null ? null : Number(pay.fee_amount),
    method: METHOD_WORD[pay.method as string] ?? (pay.method as string),
    reference: (pay.reference as string) ?? null,
    receivedOn: pay.received_on as string,
    ref: receiptRef(parkName, (pay.receipt_no as number) ?? null, pay.received_on as string),
    alreadyConfirmedAt: (pay.renter_confirmed_at as string) ?? null,
  };
}

/**
 * "Yes, that's right." Recorded as the renter's act, not the park's.
 *
 * BOTH HALVES OR NEITHER. The page asked whether $600 matches what she
 * handed over; her "yes" is about $600. This stamped the bill row alone, so
 * the $57.47 sibling — the row the office later moves to February, and the
 * one most likely to be argued about — sat in park_payments_unconfirmed_idx
 * (0077) with no account of how it was given. One update over both ids, so
 * the record cannot say she confirmed half of what she was shown. A sibling
 * already confirmed on its own (a reversed one is never returned) keeps its
 * stamp: the update touches only rows still unconfirmed.
 */
export async function confirmByToken(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createServiceClient();
  const payRes = await admin
    .from("park_payments")
    .select("id, charge_id, amount, idempotency_key, renter_confirmed_at")
    .eq("confirm_token", token)
    .maybeSingle();
  if (payRes.error) return { ok: false, error: readFailedMessage("your receipt", payRes.error) };
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };
  // Confirming twice is not an error — people tap links twice.
  if (pay.renter_confirmed_at) return { ok: true };

  // A failed sibling read refuses rather than stamping the bill's share as
  // the whole — that is the half-confirmation this exists to prevent.
  let whole: { siblingId: string | null };
  try {
    whole = await wholeHandedOver(admin, pay);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("the rest of that payment", e) };
  }

  const ids = [pay.id as string, ...(whole.siblingId ? [whole.siblingId] : [])];
  const { error } = await admin
    .from("park_payments")
    .update({ renter_confirmed_at: new Date().toISOString(), renter_confirmed_via: "link" })
    .in("id", ids)
    .is("renter_confirmed_at", null);
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
  const payRes = await admin
    .from("park_payments").select("id, charge_id, amount, received_on, receipt_no, idempotency_key").eq("confirm_token", token).maybeSingle();
  if (payRes.error) return { ok: false, error: readFailedMessage("your receipt", payRes.error) };
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "This link doesn't match a payment." };

  // `park_payment_claims.charge_id` is NOT NULL, so a disagreement about money
  // with no bill behind it — a deposit, or a cheque taken before the bill
  // existed — has nowhere to be recorded. Say that plainly instead of
  // inserting a null and telling them "that didn't save, try again" forever.
  // Widening the claims table to hang off a payment is its own piece of work.
  if (!pay.charge_id) {
    return {
      ok: false,
      error: `Please ring the office and quote receipt ${pay.receipt_no ?? "on this page"} — this one isn't against a bill, so it can't be flagged here yet.`,
    };
  }

  // THE FIGURE SHE WAS SHOWN. The page said $600 (bill share + on account);
  // the claim must say $600, or the office reads a dispute about a number
  // nobody printed. A failed sibling read refuses rather than filing the
  // bill's share as the whole — that would write the very lie this fixes into
  // the claim log, where nothing later corrects it.
  let whole: { amount: number; onAccount: number | null; onAccountApplied: boolean };
  try {
    whole = await wholeHandedOver(admin, pay);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("the rest of that payment", e) };
  }

  const openRes = await admin
    .from("park_payment_claims")
    .select("id")
    .eq("charge_id", pay.charge_id as string)
    .is("resolved_at", null)
    .maybeSingle();
  // FAILS OPEN IF LEFT ALONE. This is the don't-stack-duplicates guard, and a
  // failed read looks exactly like "nothing flagged yet" — so a dropped
  // connection files a second claim against the same bill.
  if (openRes.error) return { ok: false, error: readFailedMessage("what's already flagged", openRes.error) };
  const open = openRes.data;
  if (open) return { ok: true }; // already flagged; don't stack duplicates

  const { error } = await admin.from("park_payment_claims").insert({
    charge_id: pay.charge_id,
    asserted_by: "renter",
    note:
      `They say the receipt is wrong — it records $${whole.amount.toFixed(2)} ` +
      `taken on ${longDate(pay.received_on as string)}` +
      // Where the rest sits, as of the day she taps — a claim note is never
      // corrected later, so it must not say "on account" about money the
      // office has already put against a bill.
      (whole.onAccount == null
        ? ""
        : whole.onAccountApplied
          ? ` ($${whole.onAccount.toFixed(2)} of it since put against a bill)`
          : ` ($${whole.onAccount.toFixed(2)} of it on account with the office)`) +
      `. Raised from their own confirmation link.`,
  });
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}
