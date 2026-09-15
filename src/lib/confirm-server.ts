import { createServiceClient } from "@/lib/supabase/server";
import { mustRead, readFailedMessage, ReadFailed } from "@/lib/must-read";
import { isBearerToken } from "@/lib/token-format";
import { receiptRef, METHOD_WORD } from "@/app/park/receipt-helpers";
import { splitSiblingKey } from "@/app/park/ledger-helpers";
import { longDate } from "@/lib/lake-time";
import { describeAllocations, type AllocationLine } from "@/lib/allocations";

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
   * Whether any of that part has since been put against a bill. This page is
   * a permanent URL printed on paper, and "held for you, not yet put against
   * a bill" was true the day the receipt was written and false from the day
   * the run or the office allocated it (0167). Read, never assumed.
   */
  onAccountApplied: boolean;
  /**
   * WHAT IS STILL HELD of the on-account part — the database's `remaining`,
   * not `amount`. Null when nothing went on account. A quarter paid ahead
   * with two months applied is one month here.
   */
  onAccountRemaining: number | null;
  /**
   * WHERE THE MONEY ON ACCOUNT HAS GONE: which bill months, how much to each.
   * For a split receipt these are the sibling's; for a receipt that IS money
   * on account (a cheque taken before its bill existed) they are its own.
   * Empty when nothing has been applied.
   */
  allocations: AllocationLine[];
  /** The same, as one sentence: "$542.53 to January 2027, $57.47 on account". Empty when nothing to say. */
  whereItWent: string;
  /**
   * THIS PAYMENT NO LONGER STANDS. The office reversed it (a bounced cheque,
   * a typo) or the bank returned it. The link is a permanent URL on paper:
   * read a month later, "held for you — it comes off the next bill" about
   * money the office has recorded as never having arrived is a promise the
   * park cannot keep. Null while the payment stands. `takenBackWhy` is the
   * office's reason or the bank's return code, for the sentence.
   */
  takenBackOn: string | null;
  takenBackWhy: string | null;
  /**
   * THE OTHER HALF'S OWN STANDING. On a split receipt `takenBackOn` is the
   * bill row's; the $57.47 sibling is its own row with its own reversed_at.
   * reversePayment takes both halves back together (it is one cheque), so
   * ordinarily these agree — but the page must never SAY "that no longer
   * stands" about the sibling's allocations from the bill row's standing,
   * nor "held for you" about a sibling that was taken back on its own.
   * Null when there is no sibling, or it still stands. `onAccount`,
   * `allocations` and `whereItWent` are still the sibling's whether or not
   * it stands: what she handed over does not change when the office
   * corrects the record; the record of the correction is these two.
   */
  siblingTakenBackOn: string | null;
  siblingTakenBackWhy: string | null;
  /** Card convenience fee charged on top, or null. */
  fee: number | null;
  method: string;
  reference: string | null;
  receivedOn: string;
  ref: string;
  alreadyConfirmedAt: string | null;
}

/**
 * The key the other half of a split is written under — from the ONE
 * spelling in ledger-helpers, the same one recordPayment writes and
 * reversePayment reads. Null for a row that has no other half.
 */
function siblingKey(key: string | null, chargeId: unknown): string | null {
  return splitSiblingKey(key, chargeId);
}

/**
 * WHERE A PAYMENT ON ACCOUNT HAS GONE (0167): its live allocations, with the
 * month of each bill, and what is still unapplied. Read, never derived from
 * `charge_id` — the payment row never moves; the allocations are the record.
 *
 * `remaining` IS THE VIEW'S, not `amount − allocations` here. The one
 * definition lives in park_payment_remaining (amount − live allocations −
 * refunds), and the view lists only payments that still stand: a row absent
 * from it is reversed, bank-returned, or not rent on account at all, and
 * has NOTHING on account — whatever a subtraction here would have said. A
 * bounced quarter-ahead cheque's own link used to read "held for you"
 * because this file did the arithmetic itself.
 *
 * mustRead, for the same reason the sibling read is: a failed read rendering
 * as "nothing applied" would tell a resident in March that her January
 * cheque is still in a drawer.
 */
async function whereItWent(
  admin: ReturnType<typeof createServiceClient>,
  paymentId: string,
): Promise<{ allocations: AllocationLine[]; remaining: number }> {
  const allocs = mustRead("where that money has gone", await admin
    .from("park_payment_allocations")
    .select("charge_id, amount")
    .eq("payment_id", paymentId)
    .is("removed_at", null)) ?? [];
  const held = mustRead("what is still on account", await admin
    .from("park_on_account_payments")
    .select("remaining")
    .eq("payment_id", paymentId)
    .maybeSingle());
  const remaining = Number(held?.remaining ?? 0);
  if (allocs.length === 0) return { allocations: [], remaining };
  const charges = mustRead("the bills it was put against", await admin
    .from("park_charges")
    .select("id, period_month")
    .in("id", allocs.map((a) => a.charge_id as string))) ?? [];
  const monthOf = new Map(charges.map((c) => [c.id as string, c.period_month as string]));
  const allocations = allocs.map((a) => ({
    periodMonth: monthOf.get(a.charge_id as string) ?? "",
    amount: Number(a.amount ?? 0),
  }));
  return { allocations, remaining };
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
 * WHERE THE REST SITS is read, not assumed (0167): the run or the office puts
 * it against bills as `park_payment_allocations` rows, and the receipt's link
 * is a permanent URL. `onAccountApplied` and `allocations` are how the page
 * stops saying "held for you" about money that was put against February a
 * month ago — and says which month.
 *
 * Only a row against a bill can have a sibling. A row that IS money on
 * account (no charge, kind rent) reports its own allocations instead, so the
 * link on a quarter-ahead cheque's receipt says where the quarter went.
 * mustRead, never maybe: a failed read here would show the bill's share as
 * the whole and ask her to agree to it (or file a claim about it). Callers
 * that return `{ ok, error }` rather than throw must catch ReadFailed.
 */
async function wholeHandedOver(
  admin: ReturnType<typeof createServiceClient>,
  pay: { id?: unknown; charge_id: unknown; amount: unknown; idempotency_key: unknown; kind?: unknown },
): Promise<{
  amount: number;
  onAccount: number | null;
  onAccountApplied: boolean;
  onAccountRemaining: number | null;
  allocations: AllocationLine[];
  /** The sibling row's id WHILE IT STANDS, so a stamp can land on both halves in one update. A taken-back sibling is never stamped. */
  siblingId: string | null;
  /** The sibling's own reversed_at / returned_at, and the reason — null while it stands or when there is none. */
  siblingTakenBackOn: string | null;
  siblingTakenBackWhy: string | null;
}> {
  // ONLY A BILL ROW LOOKS FOR A SIBLING HERE. The link on an on-account
  // row's own receipt reports that row (its allocations, its standing);
  // folding its bill half in would print the bill's $542.53 on a receipt
  // that was written for $57.47.
  const key = pay.charge_id ? siblingKey((pay.idempotency_key as string | null) ?? null, pay.charge_id) : null;
  // READ WHETHER OR NOT IT STANDS. What she handed over was $600, and a
  // page that drops the $57.47 the office has since taken back is a page
  // that hides the correction rather than stating it. The standing comes
  // along so the page can say which half no longer stands.
  const sibling = key
    ? mustRead("the rest of that payment", await admin
        .from("park_payments")
        .select("id, amount, charge_id, reversed_at, reversed_reason, returned_at, return_code")
        .eq("idempotency_key", key)
        .maybeSingle())
    : null;
  const onAccount = sibling ? Number(sibling.amount) : null;
  const siblingStands = !!sibling && sibling.reversed_at == null && sibling.returned_at == null;

  // Whose allocations to read: the sibling's on a split receipt; the row's
  // own when the row itself is money on account. A deposit has none (0102).
  const acctRowId = sibling
    ? (sibling.id as string)
    : !pay.charge_id && (pay.kind == null || pay.kind === "rent") && pay.id
      ? String(pay.id)
      : null;
  const went = acctRowId
    ? await whereItWent(admin, acctRowId)
    : { allocations: [], remaining: 0 };

  return {
    amount: Math.round((Number(pay.amount) + (onAccount ?? 0)) * 100) / 100,
    onAccount,
    onAccountApplied: went.allocations.length > 0,
    onAccountRemaining: sibling ? went.remaining : acctRowId ? went.remaining : null,
    allocations: went.allocations,
    siblingId: siblingStands ? (sibling!.id as string) : null,
    siblingTakenBackOn: sibling && !siblingStands
      ? ((sibling.reversed_at as string) ?? (sibling.returned_at as string) ?? null)
      : null,
    siblingTakenBackWhy: sibling && !siblingStands
      ? sibling.reversed_at
        ? ((sibling.reversed_reason as string) ?? null)
        : ((sibling.return_code as string) ?? "returned by the bank")
      : null,
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
  // reversed_at / returned_at / their reasons: the row's OWN standing. Every
  // other reader of park_payments filters these; this one must SHOW them,
  // because the page is the household's permanent record of the money.
  const pay = mustRead("your receipt", await admin
    .from("park_payments")
    .select("id, charge_id, park_id, kind, amount, fee_amount, method, reference, received_on, receipt_no, renter_confirmed_at, idempotency_key, reversed_at, reversed_reason, returned_at, return_code")
    .eq("confirm_token", token)
    .maybeSingle());
  if (!pay) return null;

  const { amount, onAccount, onAccountApplied, onAccountRemaining, allocations, siblingTakenBackOn, siblingTakenBackWhy } = await wholeHandedOver(admin, pay);

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
    onAccountRemaining,
    allocations,
    whereItWent: describeAllocations(allocations, onAccountRemaining ?? 0),
    takenBackOn: (pay.reversed_at as string) ?? (pay.returned_at as string) ?? null,
    takenBackWhy: pay.reversed_at
      ? ((pay.reversed_reason as string) ?? null)
      : pay.returned_at
        ? ((pay.return_code as string) ?? "returned by the bank")
        : null,
    siblingTakenBackOn,
    siblingTakenBackWhy,
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
  let whole: { amount: number; onAccount: number | null; onAccountApplied: boolean; onAccountRemaining: number | null; allocations: AllocationLine[]; siblingTakenBackOn: string | null; siblingTakenBackWhy: string | null };
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
        : whole.siblingTakenBackOn
          // The office has already taken that half back: it is not on
          // account and not on a bill, and the note must not say either.
          ? ` ($${whole.onAccount.toFixed(2)} of it had gone on account and was taken back on ${longDate(whole.siblingTakenBackOn)}${whole.siblingTakenBackWhy ? ` — ${whole.siblingTakenBackWhy}` : ""})`
          : whole.onAccountApplied
            ? ` ($${whole.onAccount.toFixed(2)} of it on account: ${describeAllocations(whole.allocations, whole.onAccountRemaining ?? 0)})`
            : ` ($${whole.onAccount.toFixed(2)} of it on account with the office)`) +
      `. Raised from their own confirmation link.`,
  });
  if (error) return { ok: false, error: "That didn't save — try again." };
  return { ok: true };
}
