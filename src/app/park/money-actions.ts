"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate, lakeDateOf } from "@/lib/booking";
import { assertMyPark } from "./data";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { handKeyedRefusal, paymentAmountRefusal, prettyMonth, splitSiblingKey, onAccountPromise, type HandKeyedMethod } from "./ledger-helpers";
import { settleOnAccount, describeSettlement, heldOnAccountFor, money, type AllocationLine } from "@/lib/allocations";
import { dayInWords } from "./park-helpers";
import { tenancyFactsFor, nothingMoreBills } from "@/lib/tenancy-facts";
import { dbSaid } from "@/lib/db-said";
import type { ReceiptLines } from "./receipt-helpers";

/**
 * MONEY THAT ARRIVES BEFORE A BILL DOES — and money that is not a bill at all.
 *
 * `recordPayment` needs an open charge, and the only button that opens it is
 * gated on a positive balance. At a window where nineteen households pay cash
 * and check, that leaves four ordinary events with nowhere to go: a January
 * check handed over on 28 December, a second check for a month already paid,
 * an overpayment, and a deposit taken at signing.
 *
 * WHAT KEEPS THIS HONEST (0102): a payment is anchored to a CHARGE or to a
 * RENTER, exactly one. Money on account has no charge, so it reaches no
 * `paid_total`, no arrears figure and no statement until it is APPLIED. That
 * is the same shape as a tip in 0097: a different kind of money kept out of
 * the revenue path by the anchor it does not have, rather than by a filter
 * every future query has to remember.
 *
 * HOW IT IS APPLIED (0167): never by moving the row. A `park_payment_
 * allocations` row says "$542.53 of this payment went against January", and
 * one payment can carry several — a quarter paid ahead settles three months.
 * The run writes them the moment it raises a bill for a household with money
 * on account; `recordOnAccount` writes them the moment money arrives for a
 * household with an open bill (oldest first — R1, one helper for both);
 * `applyOnAccount` writes one by hand. What is still on account is
 * `park_on_account_payments.remaining`, the database's own arithmetic, and
 * every reader here asks that view rather than summing `amount`.
 *
 * TAKING ONE BACK OFF A BILL (R3) is `unapplyAllocation`: a correction with
 * a reason, the class reversePayment belongs to. The row is never deleted —
 * it is marked removed, the bill owes again, the money is back on account.
 *
 * A DEPOSIT IS HELD MONEY, NOT INCOME. It may never carry a charge_id at all —
 * the database refuses it — so it can never quietly settle a rent bill.
 *
 * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). A payment keyed
 * straight against a bill keeps its charge_id forever — the row never moves
 * — and when the office cancels that bill the money does not vanish and
 * does not reopen anything: the view lists the payment as on account, with
 * `released_from_charge_id`, the bill's month and the day it was cancelled
 * appended, and `remaining` is still the one remainder. So "on account" is
 * MEMBERSHIP IN THE VIEW, never `charge_id is null` decided here: a door
 * that keyed its refusal on charge_id alone would turn a released $542.53
 * away as "already against a bill" — the bill it names is cancelled. The
 * two doors below read the view row first; absent, with a charge, the money
 * is a live bill's and the sentence says so.
 */

export interface MoneyResult {
  ok: boolean;
  error?: string;
  signal?: string;
  paymentId?: string;
  receiptNo?: number | null;
  /**
   * PAPER FOR MONEY ON ACCOUNT. A household that pays a quarter ahead walks
   * away with a numbered receipt saying where the money went the moment it
   * was recorded ("$542.53 to January 2027, $1,085.06 on account") — the
   * same ReceiptLines the bill door prints, kind "on_account".
   */
  receipt?: ReceiptLines;
  /** Where to email it, or null for a paper household. */
  renterEmail?: string | null;
}

/**
 * THE FOUR HAND-KEYED WAYS, from the one list in ledger-helpers. This file had
 * its own six — with `card` and `ach` still on it — so the rent screen's door
 * refused a bank rail while the on-account and deposit doors here took it from
 * a crafted call: a deposit on `ach` hit 0108's constraint and surfaced the
 * raw constraint text; money on account keyed as `ach` with any reference
 * became a row 0142 will never let him reverse, with no charge to refund
 * against. Rule 1's own standard is the API, not the select.
 */
type Method = HandKeyedMethod;

const DENIED = "You don't manage that park.";

/**
 * Mirrors 0102's DB check, so somebody gets a sentence rather than a 23514.
 *
 * `what` is the act the day is for — "the money arrived" for a receipt, "it
 * went back" for a return or a hand-back — so the format refusal on the
 * hand-back door never says "Pick the day the money arrived" about the day
 * it left.
 */
function dateProblem(receivedOn: string, todayISO: string, what: "the money arrived" | "it went back" = "the money arrived"): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return `Pick the day ${what}.`;
  const day = 86_400_000;
  const got = Date.parse(`${receivedOn}T12:00:00Z`);
  const now = Date.parse(`${todayISO}T12:00:00Z`);
  if (!Number.isFinite(got)) return "That date isn't a date.";
  // A mistyped year moves income into another tax year and nobody finds out
  // until an accountant does.
  if (got > now + 31 * day) return "That's more than a month from now — check the year.";
  // 729, not 730: the DB compares against created_at::date in UTC, which is
  // the lake date or the day after, so the JS mirror must sit strictly inside
  // the DB window or the edge day leaks a raw constraint name to the office.
  if (got < now - 729 * day) return "That's more than two years ago — check the year.";
  return null;
}

/**
 * The three amount refusals are the rent door's (paymentAmountRefusal): this
 * one said "isn't a number" of 0 and of -5, and passed 0.004 straight to the
 * insert unrounded, where numeric(10,2) made it 0.00 and the office read
 * park_payments_amount_check by name. The typo line is this file's own.
 */
function amountProblem(amount: number): string | null {
  const bad = paymentAmountRefusal(amount);
  if (bad) return bad;
  if (amount > 100_000) return "That amount looks like a typo.";
  return null;
}

/**
 * The renter must be in THIS park, or a browser could file money anywhere.
 *
 * A FAILED READ IS NOT AN ABSENT HOUSEHOLD. Swallowed, it returns null and the
 * callers say "That household isn't in this park" to somebody standing at the
 * window with their own money — a flat assertion about their tenancy that the
 * code had no fact to support. The error travels back instead.
 */
async function renterInPark(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  renterId: string,
): Promise<{ renter: { id: string; name: string } | null; error: unknown }> {
  const { data, error } = await admin
    .from("park_renters").select("id, display_name, park_id")
    .eq("id", renterId).eq("park_id", parkId).maybeSingle();
  if (error) return { renter: null, error };
  if (!data) return { renter: null, error: null };
  return {
    renter: { id: data.id as string, name: (data.display_name as string) ?? "that household" },
    error: null,
  };
}

/**
 * MONEY ON ACCOUNT — it arrived, whether or not a bill exists for it yet.
 *
 * The row is the same either way: no charge, the household, kind 'rent'.
 * Then the one settle door (R1): if the household has an OPEN bill, the
 * oldest is settled from the money on account immediately — a cheque
 * handed over on 4 January for January goes against January the moment it
 * is keyed, and the arrears screen stops chasing them. Nothing open, and it
 * waits for the next bill the run raises. The sentence and the receipt say
 * which happened; "it's on account" alone about money that just settled
 * December is the sentence this door used to say.
 */
export async function recordOnAccount(
  parkId: string,
  renterId: string,
  amount: number,
  method: Method,
  reference: string,
  receivedOn: string,
  note?: string,
  idempotencyKey?: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const bad = amountProblem(amount) ?? dateProblem(receivedOn, todayLakeDate());
  if (bad) return { ok: false, error: bad };
  // The two processor rails are refused BEFORE any read or insert, with the
  // sentence the rent screen's door uses — not 0108's constraint name.
  const methodBad = handKeyedRefusal(method);
  if (methodBad) return { ok: false, error: methodBad };

  const admin = createServiceClient();
  const found = await renterInPark(admin, parkId, renterId);
  if (found.error) {
    return { ok: false, error: readFailedMessage("that household's file", found.error, { money: true }) };
  }
  const renter = found.renter;
  if (!renter) return { ok: false, error: "That household isn't in this park." };

  const confirmToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().slice(0, 8);
  const { data, error } = await admin.from("park_payments").insert({
    park_id: parkId,
    renter_id: renterId,
    charge_id: null,          // the whole point — see the header
    kind: "rent",
    amount,
    method,
    reference: reference.trim() || null,
    received_on: receivedOn,
    note: note?.trim() || null,
    confirm_token: confirmToken,
    idempotency_key: idempotencyKey?.trim() || null,
  }).select("id, receipt_no").single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That payment is already recorded — check the ledger before entering it again." };
    }
    return { ok: false, error: `Couldn't record that — ${error.message}` };
  }
  const paymentId = data.id as string;

  // OLDEST OPEN BILL FIRST, NOW (R1). The money is recorded, so nothing here
  // can refuse; a failed read or a refused row goes in the sentence and the
  // office applies by hand. `settled.lines` is filtered to THIS payment's
  // lines: the household may have had an older cheque on account too, and
  // that money is not what this receipt is for.
  let went: AllocationLine[] = [];
  let problem: string | null = null;
  /**
   * WHERE MONEY THEY ALREADY HAD ON ACCOUNT WENT, other than this payment's
   * own lines — the same clause recordPayment's signal carries. settleOnAccount
   * settles the household, not the payment: an older cheque sitting on
   * account (taken off a bill with a reason, or keyed when nothing was open)
   * moves onto their oldest open bill the moment this cash is keyed, and the
   * sentence used to say nothing about it — "$100.00 recorded … it's on
   * account" while $542.53 of last month's cheque had just gone back onto
   * February. The office told the household it would sit until March.
   */
  let older = "";
  const settled = await settleOnAccount(admin, parkId, [renterId], "office", await currentUserId());
  if ("error" in settled) {
    console.error(`[recordOnAccount] couldn't read ${settled.what}:`, settled.error);
    problem = `We couldn't read ${settled.what}, so it wasn't put against any bill — apply it from "Money not against a bill".`;
  } else {
    const monthOf = new Map(settled.bills.map((b) => [b.key, b.periodMonth]));
    went = settled.lines
      .filter((l) => l.paymentId === paymentId)
      .map((l) => ({ periodMonth: monthOf.get(l.key) ?? "", amount: l.amount }));
    older = describeSettlement(settled, (l) => l.paymentId !== paymentId);
    if (settled.failed.length > 0) {
      const missed = Math.round(settled.failed.reduce((t, f) => t + f.amount, 0) * 100) / 100;
      problem = `${money(missed)} of it couldn't be put against a bill — it stays on account.`;
    }
  }

  // WHAT IS STILL HELD — the database's answer after the settlement, never
  // `amount − applied` here. A failed read prints the receipt without a
  // "held" line rather than a figure nobody looked at.
  const heldRes = await admin
    .from("park_on_account_payments").select("remaining").eq("payment_id", paymentId).maybeSingle();
  if (heldRes.error) console.error("[read failed] what is still on account:", heldRes.error);
  const remaining = heldRes.error ? null : Number(heldRes.data?.remaining ?? 0);

  // WHETHER ANYTHING MORE BILLS FOR THEM — the fact the promise in the
  // sentence keys on (lib/tenancy-facts: the held panel's own read, the one
  // getHeldMoney makes further down this file), read once. This door said
  // "comes off the next bill you raise for them" to every household,
  // including one who had moved out with their final month billed — while
  // the ⊕ window's note, read off the same fact a moment earlier, had said
  // "theirs to have back" about the same money. tenancyFactsFor throws on a
  // failed read; the money is recorded, so that cannot refuse — the fact
  // stays unknown and the sentence makes no promise either way
  // (onAccountPromise).
  let nothingMore: boolean | null = null;
  try {
    nothingMore = nothingMoreBills((await tenancyFactsFor(admin, [renterId])).get(renterId));
  } catch (e) {
    console.error("[read failed] whether anything more bills for them:", e);
  }

  // THE PAPER. Same reads the bill door makes, degrading the same way: the
  // money exists, so a receipt reading "This park" is logged, not refused.
  const [parkRes, lotRes, whoRes] = await Promise.all([
    admin.from("parks").select("name, address").eq("id", parkId).maybeSingle(),
    // The lot the receipt names: their live tenancy's, the same statuses the
    // run bills. No tenancy yet (a cheque at signing) prints "—", not "?".
    admin.from("lot_reservations").select("park_lot_id, status")
      .eq("renter_id", renterId).in("status", ["approved", "active"]).limit(1).maybeSingle(),
    admin.from("park_renters").select("email, contact_pref").eq("id", renterId).maybeSingle(),
  ]);
  if (parkRes.error) console.error("[read failed] the park's name for the receipt:", parkRes.error);
  if (lotRes.error) console.error("[read failed] the lot for the receipt:", lotRes.error);
  if (whoRes.error) console.error("[read failed] who the receipt is for:", whoRes.error);
  const lotNoRes = lotRes.data?.park_lot_id
    ? await admin.from("park_lots").select("lot_number").eq("id", lotRes.data.park_lot_id as string).maybeSingle()
    : { data: null, error: null };
  if (lotNoRes.error) console.error("[read failed] the lot number for the receipt:", lotNoRes.error);
  const park = parkRes.data;
  const receipt: ReceiptLines = {
    kind: "on_account",
    parkName: (park?.name as string) ?? "This park",
    officeLine: park?.address ? `Questions? The office — ${park.address}.` : "Questions? Ask at the office.",
    receiptNo: (data.receipt_no as number) ?? null,
    feeAmount: null,
    lotNumber: (lotNoRes.data?.lot_number as string) ?? "—",
    payerName: renter.name,
    amount,
    method,
    reference: reference.trim() || null,
    receivedOn,
    periodMonth: "",
    billAmount: 0,
    balanceAfter: 0,
    onAccount: {
      amount,
      receiptNo: (data.receipt_no as number) ?? null,
      appliedTo: went,
      ...(remaining == null ? {} : { remaining }),
    },
    confirmUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/paid/${confirmToken}`,
  };

  revalidatePath("/park/rent");
  revalidatePath("/park");
  const where = describeSettlement(
    "error" in settled ? { lines: [], bills: [] } : settled,
    (l) => l.paymentId === paymentId,
  );
  // What happens to what is still held is the one promise (onAccountPromise,
  // ledger-helpers — the clause the ⊕ window's note and the bill door's
  // toast carry): the next bill you raise, theirs to have back, or nothing
  // at all. No month named: this door has no bill to count from.
  const stays = remaining == null
    ? "what's left stays on account"
    : remaining > 0
      ? `${money(remaining)} stays on account${onAccountPromise(nothingMore)}`
      : "nothing stays on account";
  return {
    ok: true,
    paymentId,
    receiptNo: (data.receipt_no as number) ?? null,
    receipt,
    renterEmail: (whoRes.data?.contact_pref as string) === "paper" ? null : ((whoRes.data?.email as string) ?? null),
    // WHAT HAPPENED TO IT, BOTH ROADS (R1): settled the oldest open bill now,
    // or nothing was open and it waits for the run — and what it waits for
    // is the same promise, with the by-hand door beside it the way this
    // sentence has always offered it.
    signal:
      `${money(amount)} recorded for ${renter.name}. ` +
      (where
        ? `${where.charAt(0).toUpperCase()}${where.slice(1)} — ${stays}.`
        : `It's on account${onAccountPromise(nothingMore, { orApplyNow: true })}.`) +
      // AND WHAT OLDER MONEY OF THEIRS MOVED, the way recordPayment says it.
      (older ? ` And ${older} from money they already had on account.` : "") +
      (problem ? ` ⚠️ ${problem}` : ""),
  };
}

/**
 * Put money on account against a bill — as much of it as the bill can take.
 *
 * One INSERT into park_payment_allocations. The database then does the
 * arithmetic (`recompute_charge_paid` counts allocations), so the charge, the
 * arrears figure and the statement all move together — there is no second
 * number here to get out of step with the first.
 *
 * A PARTIAL APPLY IS THE POINT. This door used to refuse $600 against a bill
 * with $200 left — "it would strand the difference" — because the only way
 * to apply was to move the whole payment onto one bill. An allocation is
 * min(what is left on the payment, what is left on the bill); the rest stays
 * on account, and the sentence says both.
 */
export async function applyOnAccount(
  parkId: string,
  paymentId: string,
  chargeId: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();

  const payRes = await admin
    .from("park_payments")
    .select("id, park_id, renter_id, amount, charge_id, kind, reversed_at, returned_at")
    .eq("id", paymentId).eq("park_id", parkId).maybeSingle();
  // Every check below — already against a bill, reversed, a deposit, whose
  // money it is — reads off this one row. The database refuses each of them
  // too (0167's guard); saying it in words first means the office gets a
  // sentence instead of a constraint name.
  if (payRes.error) {
    return { ok: false, error: readFailedMessage("that payment", payRes.error, { money: true }) };
  }
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "That payment isn't here." };

  // IS IT ON ACCOUNT AT ALL — the view's answer, read before any refusal
  // that names a bill (0169). A payment against a bill the office has since
  // cancelled is in the view with its money released; the same row against
  // a LIVE bill is not, and that money is the bill's. `pay.charge_id` alone
  // cannot tell the two apart, so it is never the test here.
  const leftRes = await admin
    .from("park_on_account_payments")
    .select("payment_id, remaining")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (leftRes.error) {
    return { ok: false, error: readFailedMessage("what's left on that payment", leftRes.error, { money: true }) };
  }
  if (!leftRes.data && pay.charge_id) {
    return { ok: false, error: "That money is against a live bill — it is that bill's money." };
  }
  if (pay.reversed_at) return { ok: false, error: "That payment was reversed." };
  // A RETURN IS NOT A REVERSAL AND IT IS NOT A REFUND (0155). The bank pulled
  // this money back, so it is not sitting on account and cannot settle a bill.
  if (pay.returned_at) {
    return { ok: false, error: "The bank took that payment back — it never settled, so it can't pay a bill." };
  }
  if (pay.kind === "deposit") {
    return { ok: false, error: "A deposit is held money — it can't be used to pay rent." };
  }

  // WHAT IS STILL ON ACCOUNT — the database's answer, not amount. A payment
  // that has been put against February already has less to give.
  const remaining = Number(leftRes.data?.remaining ?? 0);
  if (remaining <= 0) {
    return { ok: false, error: "Nothing is left on that payment — all of it has already been put against bills." };
  }

  const chargeRes = await admin
    .from("park_charges")
    .select("id, park_id, renter_id, status, amount, paid_total, period_month")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  if (chargeRes.error) {
    return { ok: false, error: readFailedMessage("that bill", chargeRes.error, { money: true }) };
  }
  const charge = chargeRes.data;
  if (!charge) return { ok: false, error: "That bill isn't here." };
  if (charge.status === "void") return { ok: false, error: "That bill was cancelled — pick a live one." };

  // SOMEBODY ELSE'S BILL. The ids come from a browser, and applying one
  // household's cheque to another's rent is the kind of error that is only
  // ever found by the household who gets chased for money they paid.
  if (pay.renter_id && charge.renter_id && pay.renter_id !== charge.renter_id) {
    return { ok: false, error: "That money is a different household's — it can't pay this bill." };
  }

  const month = prettyMonth(String(charge.period_month ?? ""));
  const owingCents = Math.round((Number(charge.amount) - Number(charge.paid_total)) * 100);
  if (owingCents <= 0) {
    return { ok: false, error: `The ${month} bill is already settled — nothing to put against it.` };
  }
  const applyCents = Math.min(Math.round(remaining * 100), owingCents);
  const apply = applyCents / 100;

  const { error } = await admin.from("park_payment_allocations").insert({
    park_id: parkId,
    payment_id: paymentId,
    charge_id: chargeId,
    amount: apply,
    applied_via: "office",
    applied_by: await currentUserId(),
  });
  if (error) {
    // One line per payment and bill (0167's unique index). A second tap, or
    // a bill that reopened after a refund, lands here — not "try again".
    if (error.code === "23505") {
      // THE WAY THROUGH, named: the index is partial (live lines only), so
      // the existing line can come off with a reason and the money go back
      // on for the new amount. Without this the sentence reads as a dead end.
      return {
        ok: false,
        error:
          `That payment already has a line against the ${month} bill — the record keeps one live line per payment and bill. ` +
          `To put more of it against that bill, take the existing line off first ("Take it off this bill" under "Money not against a bill"), then apply it again for the new amount.`,
      };
    }
    return { ok: false, error: `Couldn't apply that — ${dbSaid(error.message, "park_payment_allocations")}` };
  }

  // THE MONEY IS ALREADY APPLIED, so this cannot refuse — but it must not let
  // the sentence ASSERT anything either. Both figures are RE-READ after the
  // write — the bill's balance and the view's `remaining` — rather than
  // computed from the reads taken before it: a run allocation landing in
  // between would make "$X is still on account" wrong on the one copy the
  // office reads. A failed read says what was applied and stops there.
  const [afterRes, leftAfterRes] = await Promise.all([
    admin.from("park_charges").select("amount, paid_total, status").eq("id", chargeId).maybeSingle(),
    admin.from("park_on_account_payments").select("remaining").eq("payment_id", paymentId).maybeSingle(),
  ]);
  if (afterRes.error) console.error("[read failed] the bill's new balance:", afterRes.error);
  if (leftAfterRes.error) console.error("[read failed] what is still on account:", leftAfterRes.error);
  const after = afterRes.data;
  const left = after && !afterRes.error ? Math.round((Number(after.amount) - Number(after.paid_total)) * 100) / 100 : null;
  const stillOnAccount = leftAfterRes.error ? null : Number(leftAfterRes.data?.remaining ?? 0);

  revalidatePath("/park/rent");
  revalidatePath("/park");
  const head = `Applied ${money(apply)} to ${month}`;
  const tail = stillOnAccount == null
    ? ""
    : stillOnAccount > 0
      ? ` ${money(stillOnAccount)} is still on account.`
      : " Nothing is left on account from that payment.";
  return {
    ok: true,
    signal: left == null
      ? `${head}.${tail}`
      : left > 0
        ? `${head} — ${money(left)} still owing on it.${tail}`
        : `${head} — that bill is settled.${tail}`,
  };
}

/**
 * TAKE MONEY ON ACCOUNT BACK OFF A BILL — the office's correction (R3).
 *
 * The run settles the oldest open bill the moment it exists; the office
 * applies by hand. Both can be wrong about which month the household meant,
 * and until now the only exit was reversing the whole cheque — recording as
 * "never arrived" money that did, which the standing rule forbids. This is
 * the same class as reversePayment (0081): a reason, a timestamp, a name,
 * and the row stays as the record. The database (0167's guard) refuses a
 * removal without a reason, a second removal, and any other change.
 *
 * WHAT MOVES: the bill owes again by that much (recompute, in the same
 * statement) and the money is back on account — the view's `remaining`
 * rises. Nothing is sent. AND R1 STILL HOLDS: money on account settles the
 * household's oldest open bill the next time a door runs FOR THEM — the
 * next bill the run raises for that household, the next payment keyed for
 * them. (The run settles only the households it bills that morning; a
 * household it skips, or has raised its final bill for, is not touched by
 * it.) So this is the first half of a correction, not a parking place: the
 * office puts the money against the right bill now, cancels the wrong bill
 * (which is the case voidCharge sends here for), or hands it back. The
 * sentence says exactly that.
 */
export async function unapplyAllocation(
  parkId: string,
  allocationId: string,
  reason: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const why = (reason ?? "").trim();
  if (!why) {
    return { ok: false, error: "Say why it's coming off the bill — the wrong month, the wrong household. The record has to carry the reason." };
  }
  if (why.length > 500) return { ok: false, error: "That's a bit long — a sentence is plenty." };

  const admin = createServiceClient();
  // PARK-SCOPED, ON THE ROW ITSELF. The id comes from a browser; without the
  // park filter one park's office could take money off another park's bill.
  const rowRes = await admin
    .from("park_payment_allocations")
    .select("id, payment_id, charge_id, amount, removed_at")
    .eq("id", allocationId)
    .eq("park_id", parkId)
    .maybeSingle();
  if (rowRes.error) {
    return { ok: false, error: readFailedMessage("that line", rowRes.error, { money: true }) };
  }
  const row = rowRes.data;
  if (!row) return { ok: false, error: "That line isn't here." };
  if (row.removed_at) return { ok: false, error: "That one's already been taken off its bill." };

  // The month, for the sentence — read BEFORE the write so a failed read
  // refuses rather than naming no month about a bill that just reopened.
  const chargeRes = await admin
    .from("park_charges").select("period_month, renter_id").eq("id", row.charge_id as string).maybeSingle();
  if (chargeRes.error) {
    return { ok: false, error: readFailedMessage("the bill it's on", chargeRes.error, { money: true }) };
  }
  const month = prettyMonth(String(chargeRes.data?.period_month ?? ""));
  const amount = Number(row.amount ?? 0);

  const { data: done, error } = await admin
    .from("park_payment_allocations")
    .update({ removed_at: new Date().toISOString(), removed_reason: why, removed_by: await currentUserId() })
    .eq("id", allocationId)
    .eq("park_id", parkId)
    .is("removed_at", null)          // once — a double tap does not remove it twice
    .select("id");
  if (error) {
    return { ok: false, error: `Couldn't take that off — ${dbSaid(error.message, "park_payment_allocations")}` };
  }
  if (!done?.length) return { ok: false, error: "That one was just taken off its bill by somebody else." };

  // WHERE THINGS STAND NOW — both re-read, neither asserted. A failed read
  // prints what came off and stops.
  const [afterRes, heldRes] = await Promise.all([
    admin.from("park_charges").select("amount, paid_total").eq("id", row.charge_id as string).maybeSingle(),
    admin.from("park_on_account_payments").select("remaining, renter_id").eq("payment_id", row.payment_id as string).maybeSingle(),
  ]);
  if (afterRes.error) console.error("[read failed] the bill's balance after the removal:", afterRes.error);
  if (heldRes.error) console.error("[read failed] what is on account after the removal:", heldRes.error);
  const owing = afterRes.error || !afterRes.data
    ? null
    : Math.round((Number(afterRes.data.amount) - Number(afterRes.data.paid_total)) * 100) / 100;
  // Absent from the view ⇒ the payment itself no longer stands (reversed or
  // bank-returned) ⇒ nothing of it is on account, whatever came off — and
  // the bill did not move either: the recompute stopped counting this line
  // the day the payment was taken back, so it has been outstanding since
  // then, not "again".
  const held = heldRes.error ? null : heldRes.data ? Number(heldRes.data.remaining ?? 0) : 0;
  const gone = !heldRes.error && !heldRes.data;

  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    signal:
      `Took ${money(amount)} off ${month}` +
      (owing == null
        ? "."
        : owing > 0
          ? gone
            ? ` — that bill has been outstanding since the payment was taken back, ${money(owing)} owing.`
            : ` — that bill is outstanding again, ${money(owing)} owing.`
          : " — that bill is still settled by other money.") +
      (held == null
        ? " The record shows why."
        : gone
          ? " That payment isn't standing any more, so nothing of it is on account. The record shows why."
          // WHAT IS TRUE (R1, both doors): money on account settles the
          // household's oldest OPEN bill the next time a settling door runs
          // for them — the next payment keyed for them, or the next bill the
          // run raises for them (a deposit or a refund recorded for them
          // settles nothing, so "anything recorded" was wider than true).
          // AND THE SHARP CASE, NAMED: the bill this just came off is open
          // again, so it IS their oldest open bill until something older
          // is — the next cash keyed for this household puts the money
          // straight back on it. This used to name the run alone, and the
          // office told a household "it'll sit until March" in the one flow
          // where the next payment keyed undoes the correction the same
          // afternoon.
          : ` ${money(held)} is back on account for them — put it against the right bill now, or cancel the wrong one. Otherwise the next payment keyed for them, or the next bill the run raises for them, puts it against their oldest open bill — including the one it just came off, if that is still the oldest. The record shows why.`),
  };
}

/** Who is applying, for the record. Null for a caller with no session. */
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * A DEPOSIT — taken at signing, held, and given back.
 *
 * Recorded as its own payment with no charge, which is what makes it
 * structurally incapable of paying a rent bill (0102 enforces it). It is a
 * liability, not income, and every existing total is built from charges — so
 * it stays out of all of them without anybody having to filter it.
 */
export async function recordDeposit(
  parkId: string,
  renterId: string,
  amount: number,
  method: Method,
  receivedOn: string,
  note?: string,
  idempotencyKey?: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const bad = amountProblem(amount) ?? dateProblem(receivedOn, todayLakeDate());
  if (bad) return { ok: false, error: bad };
  // A deposit carries no reference at all, so `card`/`ach` here ALWAYS hit
  // 0108 and surfaced the raw constraint text. Refused first, same sentence.
  const methodBad = handKeyedRefusal(method);
  if (methodBad) return { ok: false, error: methodBad };

  const admin = createServiceClient();
  const found = await renterInPark(admin, parkId, renterId);
  if (found.error) {
    return { ok: false, error: readFailedMessage("that household's file", found.error, { money: true }) };
  }
  const renter = found.renter;
  if (!renter) return { ok: false, error: "That household isn't in this park." };

  const confirmToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().slice(0, 8);
  const { data, error } = await admin.from("park_payments").insert({
    park_id: parkId,
    renter_id: renterId,
    charge_id: null,
    kind: "deposit",
    amount,
    method,
    received_on: receivedOn,
    note: note?.trim() || null,
    confirm_token: confirmToken,
    idempotency_key: idempotencyKey?.trim() || null,
  }).select("id, receipt_no").single();

  if (error) {
    if (error.code === "23505") return { ok: false, error: "That deposit is already recorded." };
    return { ok: false, error: `Couldn't record that — ${error.message}` };
  }

  revalidatePath("/park/rent");
  return {
    ok: true,
    paymentId: data.id as string,
    receiptNo: (data.receipt_no as number) ?? null,
    signal: `${money(amount)} deposit held for ${renter.name}.`,
  };
}

/**
 * Give a deposit back — in full or in part.
 *
 * Stamped on the deposit itself rather than written as a negative payment:
 * `park_payments_amount_check` forbids a non-positive amount, and a refund
 * dressed as a payment is how a ledger starts lying about what came in.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is track a statutory return clock. That
 * is a multi-state rules engine for an operator with parks in three states;
 * this is one park in Indiana. Recording that a deposit was taken, held and
 * returned is the whole job here.
 */
export async function returnDeposit(
  parkId: string,
  paymentId: string,
  amount: number,
  returnedOn: string,
  note?: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const bad = amountProblem(amount) ?? dateProblem(returnedOn, todayLakeDate(), "it went back");
  if (bad) return { ok: false, error: bad };

  const admin = createServiceClient();
  const depRes = await admin
    .from("park_payments")
    // `returned_on` is THIS deposit going back to the tenant; `returned_at` is
    // the bank pulling the original payment back. One letter apart, opposite
    // meanings, and both have to be read before money leaves the office.
    .select("id, park_id, kind, amount, returned_on, reversed_at, returned_at")
    .eq("id", paymentId).eq("park_id", parkId).maybeSingle();
  // The deposit is the single most argued-about number in this business.
  // "That deposit isn't here" is never a thing to say on a failed read.
  if (depRes.error) {
    return { ok: false, error: readFailedMessage("that deposit", depRes.error, { money: true }) };
  }
  const dep = depRes.data;
  if (!dep) return { ok: false, error: "That deposit isn't here." };
  if (dep.kind !== "deposit") return { ok: false, error: "That isn't a deposit." };
  if (dep.reversed_at) return { ok: false, error: "That deposit was reversed." };
  // HANDING BACK A DEPOSIT THE BANK ALREADY TOOK BACK PAYS THEM TWICE, and the
  // second payment is the park's own money. The deposit screen has no idea:
  // the row still reads as $500 held.
  if (dep.returned_at) {
    return { ok: false, error: "The bank took that deposit back — it never settled, so there is nothing of theirs to return." };
  }
  if (dep.returned_on) return { ok: false, error: "That deposit has already been returned." };
  if (amount > Number(dep.amount)) {
    return { ok: false, error: `They only ever paid ${money(Number(dep.amount))} — you can't return more.` };
  }
  // KEEPING PART OF A DEPOSIT IS A MONEY DECISION and it was the only one in
  // the module with nothing behind it. 0103 refuses it at the database too;
  // this is so somebody gets a sentence rather than a constraint name.
  const kept = Math.round((Number(dep.amount) - amount) * 100) / 100;
  if (kept > 0 && !(note ?? "").trim()) {
    return {
      ok: false,
      error: `You're keeping ${money(kept)} of their deposit — say why. In six months that note is the only record of the reason.`,
    };
  }

  const { data: done, error } = await admin
    .from("park_payments")
    .update({ returned_on: returnedOn, returned_amount: amount, return_note: note?.trim() || null })
    .eq("id", paymentId)
    .is("returned_on", null)        // one return wins a double-tap
    .select("id");
  if (error) return { ok: false, error: `Couldn't record that — ${error.message}` };
  if (!done?.length) return { ok: false, error: "That deposit was just returned by somebody else." };

  revalidatePath("/park/rent");
  return {
    ok: true,
    signal: kept > 0
      // The reason is now required above, so this states what was recorded
      // rather than asking for something the office has already given.
      ? `${money(amount)} returned, ${money(kept)} kept — and the reason is on the record.`
      : `${money(amount)} returned in full.`,
  };
}

/**
 * HAND RENT ON ACCOUNT BACK ACROSS THE WINDOW (0168).
 *
 * A household leaves with money of theirs still on account and nothing will
 * ever bill for them again. Until 0168 the only control on that row was
 * "Take it back" — a reversal, which records that the cheque never arrived
 * and drags the bill's half of it back to owing on every screen. The
 * database's own comment named the missing act: "cash and cheques are handed
 * back across a window by a person. That is a different act with a different
 * record." This is that record — the stamp the deposit already uses
 * (returned_on, returned_amount, return_note), on a rent row.
 *
 * NOT returnDeposit widened. That door's partial-return rule is "you are
 * keeping the rest — say why", and on a $600 split handing back the $57.47
 * on account is not keeping $542.53 of anything. Here the ceiling is what is
 * STILL ON ACCOUNT (the view's `remaining` — after allocations and refunds,
 * the database's own figure, never `amount − applied` here), and a reason is
 * required whatever the amount: a household is owed nothing by default, so
 * the note says why the money went back.
 *
 * WHAT MOVES: `remaining` falls by the amount (park_payment_remaining
 * subtracts it), so the held panel, the resident's card, the cash
 * statement's "still held" and the run's settlement plan all stop counting
 * it in one place. Nothing is sent. The row stays as the record, with the
 * day and the reason, and can never be reversed afterwards — the database
 * refuses that by name.
 */
export async function handBackOnAccount(
  parkId: string,
  paymentId: string,
  amount: number,
  handedBackOn: string,
  reason: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const bad = amountProblem(amount) ?? dateProblem(handedBackOn, todayLakeDate(), "it went back");
  if (bad) return { ok: false, error: bad };
  const why = (reason ?? "").trim();
  if (!why) {
    return { ok: false, error: "Say why it's going back — they moved out, they overpaid. The record has to carry the reason." };
  }
  if (why.length > 500) return { ok: false, error: "That's a bit long — a sentence is plenty." };

  const admin = createServiceClient();
  const payRes = await admin
    .from("park_payments")
    // `returned_on` is money the park handed back; `returned_at` is the bank
    // pulling a card or ACH payment back. Both read before anything moves.
    .select("id, park_id, renter_id, kind, charge_id, amount, method, returned_on, reversed_at, returned_at")
    .eq("id", paymentId).eq("park_id", parkId).maybeSingle();
  // "That payment isn't here" is never a thing to say on a failed read about
  // money the office is holding in its hand.
  if (payRes.error) {
    return { ok: false, error: readFailedMessage("that payment", payRes.error, { money: true }) };
  }
  const pay = payRes.data;
  if (!pay) return { ok: false, error: "That payment isn't here." };
  if (pay.kind === "deposit") return { ok: false, error: "That's a deposit — give it back from its own line under Deposits." };

  // ON ACCOUNT IS MEMBERSHIP IN THE VIEW (0169), and the ceiling is the
  // view's figure — one read for both. A payment against a bill the office
  // cancelled is in the view, its money released, and goes back across the
  // window like any other; the same row against a LIVE bill is not, and
  // that money is the bill's. A failed read refuses: "you can't hand back
  // more than $57.47" about a figure nobody read is the sentence that hands
  // back money that is on a bill.
  const leftRes = await admin
    .from("park_on_account_payments").select("payment_id, remaining").eq("payment_id", paymentId).maybeSingle();
  if (leftRes.error) {
    return { ok: false, error: readFailedMessage("what's still on account from that payment", leftRes.error, { money: true }) };
  }
  if (!leftRes.data && pay.charge_id) {
    return { ok: false, error: "That money is against a live bill, so it isn't on account — take it back with a reason if it was recorded wrongly." };
  }
  if (pay.method === "card" || pay.method === "ach") {
    return {
      ok: false,
      error: pay.method === "ach"
        ? "That came in by bank transfer through the processor — refund it and it goes back to their bank account."
        : "That was paid by card — refund it and it goes back to their card.",
    };
  }
  if (pay.reversed_at) return { ok: false, error: "That payment was reversed — there is nothing of theirs to hand back." };
  if (pay.returned_at) {
    return { ok: false, error: "The bank took that payment back — it never settled, so there is nothing of theirs to hand back." };
  }
  if (pay.returned_on) {
    return { ok: false, error: `Money from that payment was already handed back on ${dayInWords(String(pay.returned_on))} — a hand-back is recorded once.` };
  }

  // THE CEILING IS WHAT IS STILL ON ACCOUNT — the view's figure, read above.
  const remaining = Number(leftRes.data?.remaining ?? 0);
  if (remaining <= 0) {
    return { ok: false, error: "Nothing of that payment is still on account — all of it has gone against bills or already gone back." };
  }
  if (Math.round(amount * 100) > Math.round(remaining * 100)) {
    return {
      ok: false,
      error: `Only ${money(remaining)} of that payment is still on account — the rest is against bills and stays there. You can hand back up to ${money(remaining)}.`,
    };
  }

  const { data: done, error } = await admin
    .from("park_payments")
    .update({ returned_on: handedBackOn, returned_amount: amount, return_note: why })
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .is("returned_on", null)        // once — a double tap does not hand it back twice
    .select("id");
  if (error) {
    return { ok: false, error: `Couldn't record that — ${dbSaid(error.message, "park_payments")}` };
  }
  if (!done?.length) return { ok: false, error: "That one was just handed back by somebody else." };

  // WHAT THE PARK STILL HOLDS OF THEIRS, re-read after the stamp — never
  // `remaining − amount` here. The HOUSEHOLD's figure, not this payment's:
  // a household that has left may have a second cheque on account and a
  // deposit, and the office handing back $57.47 across the window needs to
  // know about the $500 deposit while they are standing there. The money is
  // recorded, so a failed read is logged and the sentence stops short.
  const theirs = pay.renter_id
    ? await heldOnAccountFor(admin, parkId, pay.renter_id as string)
    : null;
  if (theirs?.error) console.error("[read failed] what is still held for them after the hand-back:", theirs.error);
  const still = theirs && !theirs.error ? theirs : null;

  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
  return {
    ok: true,
    signal:
      `${money(amount)} handed back on ${dayInWords(handedBackOn)} — the record shows why.` +
      (still == null
        ? ""
        : (still.remaining > 0
            ? ` ${money(still.remaining)} of theirs is still on account.`
            : " Nothing of theirs is on account any more.") +
          (still.depositsHeld > 0 ? ` You still hold their ${money(still.depositsHeld)} deposit.` : "")),
  };
}

export interface OnAccountRow {
  paymentId: string;
  renterId: string | null;
  renterName: string;
  /** What arrived. Not what is still held — see `remaining`. */
  amount: number;
  /**
   * WHAT IS STILL ON ACCOUNT (0167, 0168) — `amount` less what has been put
   * against bills, what went back to the card and what was handed back
   * across the window. The figure a screen prints beside "on account" and
   * the figure a picker offers; `amount` is the receipt's number.
   */
  remaining: number;
  /** Dollars of `amount` already against bills. */
  allocated: number;
  /** Dollars sent back through the processor (park_refunds), and each event. */
  refunded: number;
  refunds: { amount: number; on: string }[];
  /**
   * Dollars handed back across the window (0168), the day, and the reason
   * the office gave — read back onto the row, or the reason the form
   * demands lives in a column no screen opens.
   */
  handedBack: number;
  handedBackOn: string | null;
  handedBackNote: string | null;
  method: string;
  receivedOn: string;
  reference: string | null;
  receiptNo: number | null;
  /**
   * THE ON-ACCOUNT HALF OF ONE CHEQUE THAT ALSO PAID A BILL. recordPayment
   * writes $600 on a $542.53 bill as two rows; reversePayment takes BOTH
   * back whichever half is tapped (it is one cheque). "Take it back" on
   * this row therefore reverses the $542.53 against the bill as well, and
   * the confirm must say so. READ, NOT DERIVED: the key's suffix alone
   * said "split" about a lone on-account row written over a settled bill
   * (recordPayment writes the suffix whether or not a bill row exists), so
   * the confirm asked the office to reverse "the whole cheque — and the
   * part against the bill" about $542.53 in cash with no other half. This
   * is set only when the sibling bill row STANDS — the same read
   * reversePayment makes — and carries what that half is. `billCancelled`
   * says the bill that half was paid on has since been cancelled (0169) —
   * that half is then itself on account, listed on its own row, and the
   * confirm must not describe "$542.53 against January 2027" as though
   * January still stood. Null on a released row itself: `split` means "the
   * other half is against a bill", and a released row's other half is on
   * account — see `releasedFrom.sibling`.
   */
  split: { against: number; billMonth: string | null; billCancelled: boolean } | null;
  /**
   * MONEY RELEASED FROM A CANCELLED BILL (0169). Set when this payment was
   * keyed straight against a bill the office has since cancelled: the row
   * never moved (charge_id still names the bill), the view lists it as on
   * account, and the screen says where it came from — the bill's month and
   * the day it was cancelled — or "$542.53 still on account" stands over
   * money the household remembers paying on January. `sibling` is the
   * on-account half of the same cheque when one STANDS (a $600 cheque on a
   * $542.53 bill — recordPayment's split), because reversePayment takes
   * both halves back whichever is tapped and the confirm must say so. Null
   * for money keyed on account through its own door.
   */
  releasedFrom: { chargeId: string; month: string; on: string; sibling: { onAccount: number } | null } | null;
  /**
   * THE HOUSEHOLD HAS LEFT. No approved or active tenancy, and at least one
   * ended; `movedOutOn` is the last day they lived here.
   */
  tenancyEnded: boolean;
  movedOutOn: string | null;
  /**
   * AND THEIR FINAL MONTH IS BILLED — a live charge exists for the month
   * they moved out in, on the link they moved out from. Only then is "no
   * next bill will take this" true: a move-out recorded before that
   * month's run still gets a prorated final bill, which the run settles
   * from money on account (R1). The screen's "this is theirs to have back"
   * needs BOTH facts.
   */
  finalMonthBilled: boolean;
}

export interface DepositRow extends OnAccountRow {
  returnedOn: string | null;
  returnedAmount: number | null;
  note: string | null;
  /** Why any of it was kept. The screen asks for it; this is the read back. */
  returnNote: string | null;
}

// WHETHER EACH HOUSEHOLD HAS LEFT, AND WHETHER THEIR LAST MONTH IS BILLED —
// tenancyFactsFor, from @/lib/tenancy-facts. It lived here as a private
// copy, word for word the one the resident receipt and the resident home
// carried too, and the three had already begun to disagree. The shared
// one reads exactly what this one read (both through mustRead: a failed
// read defaulting to "still here" would print "No open bill for them yet"
// — a promise of a next bill — over money the park owes back), so the
// held panel's rows carry the same three facts they always did.

/** Money sitting against households, and deposits being held. */
export async function getHeldMoney(parkId: string): Promise<{
  onAccount: OnAccountRow[];
  deposits: DepositRow[];
  onAccountTotal: number;
  depositsHeldTotal: number;
}> {
  const empty = { onAccount: [], deposits: [], onAccountTotal: 0, depositsHeldTotal: 0 };
  if (!(await assertMyPark(parkId))) return empty;

  const admin = createServiceClient();
  // Two reads. ONE literal string each. A `+`-joined select turns every
  // column into a GenericStringError at the type level and silently into
  // nothing at runtime.
  //
  // MONEY ON ACCOUNT COMES FROM THE VIEW (0167), which carries the database's
  // own `remaining` — what has not been put against a bill, sent back to the
  // card, or handed back across the window (0168). It already leaves out
  // reversed and bank-returned rows, the same two filters the deposit read
  // below applies by hand.
  //
  // A ROW FULLY APPLIED STAYS LISTED (remaining 0, allocated > 0). This panel
  // is the ONLY screen with "Take it back" on a cheque with no bill — and a
  // bounced quarter-ahead cheque bounces AFTER the run has spent it on three
  // months. Dropped from the list the morning March was applied, it could
  // never be reversed in exactly the case the reversal was built for. A row
  // handed back stays listed too (handed_back > 0): it is the record of
  // where the money went. What is dropped is a row with nothing applied,
  // nothing handed back and nothing left (refunded in full): there is
  // nothing to take back and nothing to show. The total sums `remaining`, so
  // a spent cheque adds $0 to "on account".
  //
  // AND MONEY RELEASED FROM A CANCELLED BILL (0169) is in the view with the
  // three columns at the end: the bill it was paid on, that bill's month and
  // the day it was cancelled. The row is listed like any other — its
  // `remaining` is the same figure — and says where it came from.
  const acctCols = "payment_id, renter_id, amount, allocated, refunded, remaining, handed_back, handed_back_on, handed_back_note, method, received_on, reference, receipt_no, note, idempotency_key, released_from_charge_id, released_from_month, released_on";
  const depCols = "id, renter_id, amount, fee_amount, method, received_on, reference, receipt_no, kind, charge_id, returned_on, returned_amount, return_note, note, reversed_at, returned_at";
  // MONEY THE BANK TOOK BACK IS NOT MONEY THE PARK IS HOLDING, and a deposit
  // has no charge for `recompute_charge_paid` to correct — that is the whole
  // point of 0102's anchor. So the filter has to be here, beside the reversal
  // filter it sits with, or the held total overstates the park's cash for as
  // long as nobody reconciles the bank.
  const [acctRes, depRes] = await Promise.all([
    admin.from("park_on_account_payments").select(acctCols)
      .eq("park_id", parkId)
      .order("received_on", { ascending: false }),
    admin.from("park_payments").select(depCols)
      .eq("park_id", parkId).is("reversed_at", null).is("returned_at", null)
      .eq("kind", "deposit")
      .order("received_on", { ascending: false }),
  ]);
  // `empty` above means "$0 on account, $0 held". Told to a household whose
  // deposit is $500 that is the worst sentence on the screen, so a failed read
  // never reaches it — it throws to the error boundary instead.
  const acctRows = (mustRead("money sitting on account", acctRes) ?? [])
    .filter((r) => Number(r.remaining ?? 0) > 0 || Number(r.allocated ?? 0) > 0 || Number(r.handed_back ?? 0) > 0);
  const depRows = mustRead("the deposits you're holding", depRes);
  const rows = [...(acctRows ?? []), ...(depRows ?? [])];
  if (!rows.length) return empty;

  const renterIds = [...new Set(rows.map((r) => r.renter_id as string).filter(Boolean))];
  const names = new Map<string, string>();
  if (renterIds.length) {
    const rs = mustRead(
      "whose money it is",
      await admin.from("park_renters").select("id, display_name").in("id", renterIds),
    );
    for (const r of rs ?? []) names.set(r.id as string, (r.display_name as string) ?? "—");
  }
  const tenancy = await tenancyFactsFor(admin, renterIds);

  // THE OTHER HALF OF A SPLIT, READ. One `.in()` over the sibling keys, the
  // same standing filter reversePayment uses (park-scoped, not reversed,
  // bank-returned neither), then the bills' months in one more read.
  // mustRead: a failed read defaulting to "no split" would print "Reverse
  // it" on a real $600 split — the exact lie the flag exists to prevent.
  //
  // TWO DIRECTIONS, ONE READ. An on-account row (key `…:onaccount`) looks
  // for the bill's half under the base key — a row AGAINST a bill. A
  // released row (0169: charge_id set, key = the base key) looks the other
  // way, for the on-account half under `…:onaccount` — a row with NO bill.
  // Both key shapes go into the one `.in`, and the rows that come back are
  // sorted by which half they are.
  const acctSibKeys = (acctRows ?? [])
    .map((r) => splitSiblingKey((r.idempotency_key as string | null) ?? null, null))
    .filter((k): k is string => k != null);
  const releasedSibKeys = (acctRows ?? [])
    .filter((r) => r.released_from_charge_id != null)
    .map((r) => splitSiblingKey((r.idempotency_key as string | null) ?? null, r.released_from_charge_id))
    .filter((k): k is string => k != null);
  const sibKeys = [...new Set([...acctSibKeys, ...releasedSibKeys])];
  const sibByKey = new Map<string, { against: number; chargeId: string }>();
  const acctSibByKey = new Map<string, { onAccount: number }>();
  if (sibKeys.length) {
    const sibs = mustRead(
      "the other half of those payments",
      await admin.from("park_payments").select("idempotency_key, amount, charge_id")
        .eq("park_id", parkId).in("idempotency_key", sibKeys).is("reversed_at", null).is("returned_at", null),
    ) ?? [];
    for (const s of sibs) {
      if (!s.charge_id) {
        acctSibByKey.set(s.idempotency_key as string, { onAccount: Number(s.amount ?? 0) });
        continue;
      }
      sibByKey.set(s.idempotency_key as string, { against: Number(s.amount ?? 0), chargeId: s.charge_id as string });
    }
  }
  // EACH REFUND, WITH ITS DAY, so the row can say "$40.00 went back to the
  // card on January 9, 2027" rather than a total with no date. Card money
  // only (guard_park_refund) — none at a cash-and-cheque park, one read
  // that returns nothing there. THE DAY IS THE LAKE'S: created_at is a
  // timestamptz, and its first ten characters are the UTC date — a refund
  // keyed after seven in the evening on the 9th is 2027-01-10T00:xxZ, and
  // the row read "January 10". lakeDateOf is what the statement's refund
  // note uses for this same column.
  const refundsByPayment = new Map<string, { amount: number; on: string }[]>();
  const refundedIds = (acctRows ?? []).filter((r) => Number(r.refunded ?? 0) > 0).map((r) => r.payment_id as string);
  if (refundedIds.length) {
    const refs = mustRead(
      "what went back to the card",
      await admin.from("park_refunds").select("payment_id, amount, created_at")
        .eq("park_id", parkId).in("payment_id", refundedIds).order("created_at", { ascending: true }),
    ) ?? [];
    for (const r of refs) {
      const list = refundsByPayment.get(r.payment_id as string) ?? [];
      list.push({ amount: Number(r.amount ?? 0), on: lakeDateOf(String(r.created_at ?? "")) ?? "" });
      refundsByPayment.set(r.payment_id as string, list);
    }
  }
  // THE BILL THE OTHER HALF IS AGAINST — its month, and whether it still
  // stands. A bill the office cancelled (0169) has released that half onto
  // account; the on-account row's confirm then says "which was cancelled"
  // rather than naming January as a live bill the money goes back off.
  const monthOfCharge = new Map<string, string>();
  const cancelledCharge = new Set<string>();
  const sibChargeIds = [...new Set([...sibByKey.values()].map((s) => s.chargeId))];
  if (sibChargeIds.length) {
    const chs = mustRead(
      "the bills the other halves are against",
      await admin.from("park_charges").select("id, period_month, status").in("id", sibChargeIds),
    ) ?? [];
    for (const c of chs) {
      monthOfCharge.set(c.id as string, String(c.period_month ?? ""));
      if (c.status === "void") cancelledCharge.add(c.id as string);
    }
  }

  const base = (r: Record<string, unknown>, id: string): OnAccountRow => {
    const facts = tenancy.get(r.renter_id as string);
    return {
      paymentId: id,
      renterId: (r.renter_id as string) ?? null,
      renterName: names.get(r.renter_id as string) ?? "Unknown household",
      amount: Number(r.amount ?? 0),
      remaining: Number(r.remaining ?? r.amount ?? 0),
      allocated: Number(r.allocated ?? 0),
      refunded: Number(r.refunded ?? 0),
      refunds: refundsByPayment.get(id) ?? [],
      handedBack: Number(r.handed_back ?? 0),
      handedBackOn: (r.handed_back_on as string | null) ?? null,
      handedBackNote: (r.handed_back_note as string | null) ?? null,
      method: (r.method as string) ?? "other",
      receivedOn: (r.received_on as string) ?? "",
      reference: (r.reference as string) ?? null,
      receiptNo: (r.receipt_no as number) ?? null,
      split: null,
      releasedFrom: null,
      tenancyEnded: facts?.tenancyEnded ?? false,
      movedOutOn: facts?.movedOutOn ?? null,
      finalMonthBilled: facts?.finalMonthBilled ?? false,
    };
  };

  const onAccount = (acctRows ?? []).map((r): OnAccountRow => {
    const key = (r.idempotency_key as string | null) ?? null;
    const releasedFromChargeId = (r.released_from_charge_id as string | null) ?? null;
    // A RELEASED ROW (0169): where it came from, and its on-account half if
    // one stands. `split` stays null — its meaning is "the other half is
    // against a bill", and this row's other half is on account.
    if (releasedFromChargeId) {
      const sibKey = splitSiblingKey(key, releasedFromChargeId);
      const sib = sibKey ? acctSibByKey.get(sibKey) : undefined;
      return {
        ...base(r, r.payment_id as string),
        releasedFrom: {
          chargeId: releasedFromChargeId,
          month: String(r.released_from_month ?? ""),
          on: String(r.released_on ?? ""),
          sibling: sib ? { onAccount: sib.onAccount } : null,
        },
      };
    }
    const sibKey = splitSiblingKey(key, null);
    const sib = sibKey ? sibByKey.get(sibKey) : undefined;
    return {
      ...base(r, r.payment_id as string),
      split: sib
        ? { against: sib.against, billMonth: monthOfCharge.get(sib.chargeId) ?? null, billCancelled: cancelledCharge.has(sib.chargeId) }
        : null,
    };
  });
  // A deposit is never applied to anything (0102), so all of it is held
  // until it goes back: remaining is the amount, allocated is nothing.
  const deposits = (depRows ?? []).map((r) => ({
    ...base(r, r.id as string),
    handedBack: r.returned_amount == null ? 0 : Number(r.returned_amount),
    handedBackOn: (r.returned_on as string) ?? null,
    handedBackNote: (r.return_note as string) ?? null,
    returnedOn: (r.returned_on as string) ?? null,
    returnedAmount: r.returned_amount == null ? null : Number(r.returned_amount),
    note: (r.note as string) ?? null,
    returnNote: (r.return_note as string) ?? null,
  }));

  return {
    onAccount,
    deposits,
    // WHAT IS STILL HELD, not what arrived: a quarter paid ahead with two
    // months already applied is one month on account, not three.
    onAccountTotal: Math.round(onAccount.reduce((s, r) => s + r.remaining, 0) * 100) / 100,
    // What is actually still HELD — a returned deposit is no longer a liability.
    depositsHeldTotal: Math.round(
      deposits.filter((d) => !d.returnedOn).reduce((s, d) => s + d.amount, 0) * 100,
    ) / 100,
  };
}

/**
 * The households on this park's roll, for the "whose money is this" picker.
 * Confirmed renters only — an application that was never approved is not a
 * household you take a deposit from.
 */
export async function getHouseholds(parkId: string): Promise<Array<{ id: string; name: string }>> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();
  // An empty picker reads as "this park has nobody on it", and the office then
  // cannot file the cash in their hand against anyone.
  const data = mustRead(
    "the households on your roll",
    await admin
      .from("park_renters")
      .select("id, display_name, merged_into")
      .eq("park_id", parkId)
      .is("merged_into", null)          // a merged file is a duplicate, not a household
      .order("display_name"),
  );
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: (r.display_name as string) ?? "—",
  }));
}

/**
 * Live bills money on account can be put against, WITH the renter id.
 *
 * The ledger's own `Charge` type carries `renterName` and not the id, and a
 * name is not an identity — two households called Smith would silently share
 * a picker. This reads the id so the screen can offer a household only their
 * own bills, and `applyOnAccount` re-checks it server-side regardless.
 */
export async function getOpenChargesForApply(
  parkId: string,
): Promise<Array<{ id: string; renterId: string | null; label: string }>> {
  if (!(await assertMyPark(parkId))) return [];
  const admin = createServiceClient();
  // An empty list reads as "nothing is owed" and hides every bill this money
  // could be put against.
  const data = mustRead(
    "the open bills",
    await admin
      .from("park_charges")
      .select("id, renter_id, period_month, amount, paid_total, park_lot_id, status")
      .eq("park_id", parkId)
      .eq("status", "open")
      .order("period_month", { ascending: false })
      .limit(200),
  );
  if (!data?.length) return [];

  const lotIds = [...new Set(data.map((c) => c.park_lot_id as string).filter(Boolean))];
  const lotNo = new Map<string, string>();
  if (lotIds.length) {
    const lots = mustRead(
      "the lots those bills are for",
      await admin.from("park_lots").select("id, lot_number").in("id", lotIds),
    );
    for (const l of lots ?? []) lotNo.set(l.id as string, (l.lot_number as string) ?? "?");
  }

  return data.map((c) => {
    const owed = Number(c.amount ?? 0) - Number(c.paid_total ?? 0);
    return {
      id: c.id as string,
      renterId: (c.renter_id as string) ?? null,
      label: `${lotNo.get(c.park_lot_id as string) ?? "?"} · ${prettyMonthLabel(c.period_month as string)} · ${money(owed)} owing`,
    };
  });
}

/** "2026-08" -> "August 2026". Never show a person a hyphenated month. */
function prettyMonthLabel(period: string): string {
  const [y, m] = (period ?? "").split("-").map(Number);
  if (!y || !m) return period ?? "";
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${y}`;
}
