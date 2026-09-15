"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate } from "@/lib/booking";
import { assertMyPark } from "./data";
import { mustRead, readFailedMessage } from "@/lib/must-read";
import { handKeyedRefusal, paymentAmountRefusal, prettyMonth, splitSiblingKey, type HandKeyedMethod } from "./ledger-helpers";
import { settleOnAccount, describeSettlement, money, type AllocationLine } from "@/lib/allocations";
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

/** Mirrors 0102's DB check, so somebody gets a sentence rather than a 23514. */
function dateProblem(receivedOn: string, todayISO: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return "Pick the day the money arrived.";
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
  const settled = await settleOnAccount(admin, parkId, [renterId], "office", await currentUserId());
  if ("error" in settled) {
    console.error(`[recordOnAccount] couldn't read ${settled.what}:`, settled.error);
    problem = `We couldn't read ${settled.what}, so it wasn't put against any bill — apply it from "Money not against a bill".`;
  } else {
    const monthOf = new Map(settled.bills.map((b) => [b.key, b.periodMonth]));
    went = settled.lines
      .filter((l) => l.paymentId === paymentId)
      .map((l) => ({ periodMonth: monthOf.get(l.key) ?? "", amount: l.amount }));
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
  const stays = remaining == null
    ? "what's left stays on account"
    : remaining > 0
      ? `${money(remaining)} stays on account and comes off the next bill you raise for them`
      : "nothing stays on account";
  return {
    ok: true,
    paymentId,
    receiptNo: (data.receipt_no as number) ?? null,
    receipt,
    renterEmail: (whoRes.data?.contact_pref as string) === "paper" ? null : ((whoRes.data?.email as string) ?? null),
    // WHAT HAPPENED TO IT, BOTH ROADS (R1): settled the oldest open bill now,
    // or nothing was open and it waits for the run.
    signal:
      `${money(amount)} recorded for ${renter.name}. ` +
      (where
        ? `${where.charAt(0).toUpperCase()}${where.slice(1)} — ${stays}.`
        : "It's on account — it comes off the next bill you raise for them, or put it against an open one now.") +
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
  if (pay.charge_id) return { ok: false, error: "That one is already against a bill." };
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
  const leftRes = await admin
    .from("park_on_account_payments")
    .select("payment_id, remaining")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (leftRes.error) {
    return { ok: false, error: readFailedMessage("what's left on that payment", leftRes.error, { money: true }) };
  }
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
    return { ok: false, error: `Couldn't apply that — ${(error.message ?? "").replace(/^park_payment_allocations:\s*/, "")}` };
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
    return { ok: false, error: `Couldn't take that off — ${(error.message ?? "").replace(/^park_payment_allocations:\s*/, "")}` };
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
          // WHAT IS TRUE: the run settles only the households it raises a
          // bill for, so "the next run puts it against their oldest open
          // bill" promised something the run does not do for a household
          // it skips or has finished with. The money waits for the next
          // bill the run raises for THEM — and then goes oldest-first.
          : ` ${money(held)} is back on account for them — put it against the right bill now, or cancel the wrong one; the next bill the run raises for them takes it, oldest open bill first. The record shows why.`),
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
    signal: `$${amount.toFixed(2)} deposit held for ${renter.name}.`,
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
  const bad = amountProblem(amount) ?? dateProblem(returnedOn, todayLakeDate());
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
    return { ok: false, error: `They only ever paid $${Number(dep.amount).toFixed(2)} — you can't return more.` };
  }
  // KEEPING PART OF A DEPOSIT IS A MONEY DECISION and it was the only one in
  // the module with nothing behind it. 0103 refuses it at the database too;
  // this is so somebody gets a sentence rather than a constraint name.
  const kept = Math.round((Number(dep.amount) - amount) * 100) / 100;
  if (kept > 0 && !(note ?? "").trim()) {
    return {
      ok: false,
      error: `You're keeping $${kept.toFixed(2)} of their deposit — say why. In six months that note is the only record of the reason.`,
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
      ? `$${amount.toFixed(2)} returned, $${kept.toFixed(2)} kept — and the reason is on the record.`
      : `$${amount.toFixed(2)} returned in full.`,
  };
}

export interface OnAccountRow {
  paymentId: string;
  renterId: string | null;
  renterName: string;
  /** What arrived. Not what is still held — see `remaining`. */
  amount: number;
  /**
   * WHAT IS STILL ON ACCOUNT (0167) — `amount` less what has been put against
   * bills and what went back. The figure a screen prints beside "on account"
   * and the figure a picker offers; `amount` is the receipt's number.
   */
  remaining: number;
  /** Dollars of `amount` already against bills. */
  allocated: number;
  method: string;
  receivedOn: string;
  reference: string | null;
  receiptNo: number | null;
  /**
   * THE ON-ACCOUNT HALF OF ONE CHEQUE THAT ALSO PAID A BILL. recordPayment
   * writes $600 on a $542.53 bill as two rows; reversePayment takes BOTH
   * back whichever half is tapped (it is one cheque). "Take it back" on
   * this row therefore reverses the $542.53 against the bill as well, and
   * the confirm must say so — "Reverse $57.47 on account" about an act that
   * reverses $600 is the sentence this flag exists to prevent. Read off the
   * row's own key through the one spelling (splitSiblingKey). Always false
   * for a deposit.
   */
  partOfSplit: boolean;
}

export interface DepositRow extends OnAccountRow {
  returnedOn: string | null;
  returnedAmount: number | null;
  note: string | null;
  /** Why any of it was kept. The screen asks for it; this is the read back. */
  returnNote: string | null;
}

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
  // own `remaining` — what has not been put against a bill or sent back. It
  // already leaves out reversed and bank-returned rows, the same two filters
  // the deposit read below applies by hand.
  //
  // A ROW FULLY APPLIED STAYS LISTED (remaining 0, allocated > 0). This panel
  // is the ONLY screen with "Take it back" on a cheque with no bill — and a
  // bounced quarter-ahead cheque bounces AFTER the run has spent it on three
  // months. Dropped from the list the morning March was applied, it could
  // never be reversed in exactly the case the reversal was built for. What
  // is dropped is a row with nothing applied and nothing left (refunded in
  // full): there is nothing to take back and nothing to show. The total sums
  // `remaining`, so a spent cheque adds $0 to "on account".
  const acctCols = "payment_id, renter_id, amount, allocated, refunded, remaining, method, received_on, reference, receipt_no, note, idempotency_key";
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
    .filter((r) => Number(r.remaining ?? 0) > 0 || Number(r.allocated ?? 0) > 0);
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

  const base = (r: Record<string, unknown>, id: string): OnAccountRow => ({
    paymentId: id,
    renterId: (r.renter_id as string) ?? null,
    renterName: names.get(r.renter_id as string) ?? "Unknown household",
    amount: Number(r.amount ?? 0),
    remaining: Number(r.remaining ?? r.amount ?? 0),
    allocated: Number(r.allocated ?? 0),
    method: (r.method as string) ?? "other",
    receivedOn: (r.received_on as string) ?? "",
    reference: (r.reference as string) ?? null,
    receiptNo: (r.receipt_no as number) ?? null,
    partOfSplit: false,
  });

  const onAccount = (acctRows ?? []).map((r) => ({
    ...base(r, r.payment_id as string),
    // An on-account row whose key is a bill row's key + the suffix is the
    // other half of that bill's cheque.
    partOfSplit: splitSiblingKey((r.idempotency_key as string | null) ?? null, null) != null,
  }));
  // A deposit is never applied to anything (0102), so all of it is held
  // until it goes back: remaining is the amount, allocated is nothing.
  const deposits = (depRows ?? []).map((r) => ({
    ...base(r, r.id as string),
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
      label: `${lotNo.get(c.park_lot_id as string) ?? "?"} · ${prettyMonthLabel(c.period_month as string)} · $${owed.toFixed(2)} owing`,
    };
  });
}

/** "2026-08" -> "August 2026". Never show a person a hyphenated month. */
function prettyMonthLabel(period: string): string {
  const [y, m] = (period ?? "").split("-").map(Number);
  if (!y || !m) return period ?? "";
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${y}`;
}
