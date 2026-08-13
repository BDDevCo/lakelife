"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayLakeDate } from "@/lib/booking";
import { assertMyPark } from "./data";

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
 * RENTER, exactly one. Money on account has no charge, so `sync_charge_paid` —
 * which sums by `charge_id` — cannot see it, and it therefore reaches no
 * `paid_total`, no arrears figure and no statement until somebody applies it.
 * That is the same shape as a tip in 0097: a different kind of money kept out
 * of the revenue path by the anchor it does not have, rather than by a filter
 * every future query has to remember.
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
}

type Method = "cash" | "check" | "card" | "ach" | "transfer" | "other";
const METHODS: Method[] = ["cash", "check", "card", "ach", "transfer", "other"];

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

function amountProblem(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "That amount isn't a number.";
  if (amount > 100_000) return "That amount looks like a typo.";
  return null;
}

/** The renter must be in THIS park, or a browser could file money anywhere. */
async function renterInPark(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  renterId: string,
): Promise<{ id: string; name: string } | null> {
  const { data } = await admin
    .from("park_renters").select("id, display_name, park_id")
    .eq("id", renterId).eq("park_id", parkId).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, name: (data.display_name as string) ?? "that household" };
}

/**
 * MONEY ON ACCOUNT — it arrived, and there is no bill for it yet.
 *
 * Deliberately does NOT go looking for an open charge to attach it to. A
 * cheque handed over on 28 December for January is not a payment of December's
 * bill, and guessing would settle the wrong month and change what the arrears
 * screen says. It sits against the household until somebody applies it.
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
  if (!METHODS.includes(method)) return { ok: false, error: "That isn't a way money arrives." };

  const admin = createServiceClient();
  const renter = await renterInPark(admin, parkId, renterId);
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

  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    paymentId: data.id as string,
    receiptNo: (data.receipt_no as number) ?? null,
    signal: `$${amount.toFixed(2)} recorded for ${renter.name}. It's on account until you put it against a bill.`,
  };
}

/**
 * Put money on account against a bill.
 *
 * One UPDATE. `sync_charge_paid` then does the arithmetic, so the charge, the
 * arrears figure and the statement all move together — there is no second
 * number here to get out of step with the first.
 */
export async function applyOnAccount(
  parkId: string,
  paymentId: string,
  chargeId: string,
): Promise<MoneyResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const admin = createServiceClient();

  const { data: pay } = await admin
    .from("park_payments")
    .select("id, park_id, renter_id, amount, charge_id, kind, reversed_at")
    .eq("id", paymentId).eq("park_id", parkId).maybeSingle();
  if (!pay) return { ok: false, error: "That payment isn't here." };
  if (pay.charge_id) return { ok: false, error: "That one is already against a bill." };
  if (pay.reversed_at) return { ok: false, error: "That payment was reversed." };
  // The database refuses this too. Saying it in words first means the office
  // gets a sentence instead of a constraint name.
  if (pay.kind === "deposit") {
    return { ok: false, error: "A deposit is held money — it can't be used to pay rent." };
  }

  const { data: charge } = await admin
    .from("park_charges")
    .select("id, park_id, renter_id, status, amount, paid_total, period_month")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  if (!charge) return { ok: false, error: "That bill isn't here." };
  if (charge.status === "void") return { ok: false, error: "That bill was cancelled — pick a live one." };

  // SOMEBODY ELSE'S BILL. The ids come from a browser, and applying one
  // household's cheque to another's rent is the kind of error that is only
  // ever found by the household who gets chased for money they paid.
  if (pay.renter_id && charge.renter_id && pay.renter_id !== charge.renter_id) {
    return { ok: false, error: "That money is a different household's — it can't pay this bill." };
  }

  // AN OVER-APPLY TRAPS THE EXCESS. There is no way to split a payment, so
  // putting $500 against a bill with $200 left leaves $300 attached to a
  // settled charge with no way to move it to next month — while the screen
  // says "settled". Refuse it and let the office decide, rather than swallow
  // the difference.
  const owing = Math.round((Number(charge.amount) - Number(charge.paid_total)) * 100) / 100;
  if (Number(pay.amount) > owing) {
    return {
      ok: false,
      error: `That bill only has $${owing.toFixed(2)} left on it and this payment is $${Number(pay.amount).toFixed(2)} — it would strand the difference. Put it against a bigger bill, or raise the one it belongs to first.`,
    };
  }

  const { data: done, error } = await admin
    .from("park_payments")
    .update({ charge_id: chargeId })
    .eq("id", paymentId)
    .is("charge_id", null)          // a second tap loses rather than double-applying
    .select("id");
  if (error) return { ok: false, error: `Couldn't apply that — ${error.message}` };
  if (!done?.length) return { ok: false, error: "Somebody just applied that one." };

  const { data: after } = await admin
    .from("park_charges").select("amount, paid_total, status").eq("id", chargeId).maybeSingle();
  const left = after ? Number(after.amount) - Number(after.paid_total) : 0;

  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    signal: left > 0
      ? `Applied. $${left.toFixed(2)} still owing on that bill.`
      : "Applied — that bill is settled.",
  };
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
  if (!METHODS.includes(method)) return { ok: false, error: "That isn't a way money arrives." };

  const admin = createServiceClient();
  const renter = await renterInPark(admin, parkId, renterId);
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
  const { data: dep } = await admin
    .from("park_payments")
    .select("id, park_id, kind, amount, returned_on, reversed_at")
    .eq("id", paymentId).eq("park_id", parkId).maybeSingle();
  if (!dep) return { ok: false, error: "That deposit isn't here." };
  if (dep.kind !== "deposit") return { ok: false, error: "That isn't a deposit." };
  if (dep.reversed_at) return { ok: false, error: "That deposit was reversed." };
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
  amount: number;
  method: string;
  receivedOn: string;
  reference: string | null;
  receiptNo: number | null;
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
  // Two reads, each matching one of 0102's partial indexes, rather than one
  // read of every payment the park has ever taken filtered in JavaScript.
  const cols = "id, renter_id, amount, method, received_on, reference, receipt_no, kind, charge_id, returned_on, returned_amount, return_note, note, reversed_at";
  const [{ data: acctRows }, { data: depRows }] = await Promise.all([
    admin.from("park_payments").select(cols)
      .eq("park_id", parkId).is("reversed_at", null).eq("kind", "rent").is("charge_id", null)
      .order("received_on", { ascending: false }),
    admin.from("park_payments").select(cols)
      .eq("park_id", parkId).is("reversed_at", null).eq("kind", "deposit")
      .order("received_on", { ascending: false }),
  ]);
  const rows = [...(acctRows ?? []), ...(depRows ?? [])];
  if (!rows.length) return empty;

  const renterIds = [...new Set(rows.map((r) => r.renter_id as string).filter(Boolean))];
  const names = new Map<string, string>();
  if (renterIds.length) {
    const { data: rs } = await admin
      .from("park_renters").select("id, display_name").in("id", renterIds);
    for (const r of rs ?? []) names.set(r.id as string, (r.display_name as string) ?? "—");
  }

  const base = (r: Record<string, unknown>): OnAccountRow => ({
    paymentId: r.id as string,
    renterId: (r.renter_id as string) ?? null,
    renterName: names.get(r.renter_id as string) ?? "Unknown household",
    amount: Number(r.amount ?? 0),
    method: (r.method as string) ?? "other",
    receivedOn: (r.received_on as string) ?? "",
    reference: (r.reference as string) ?? null,
    receiptNo: (r.receipt_no as number) ?? null,
  });

  const onAccount = (acctRows ?? []).map(base);
  const deposits = (depRows ?? []).map((r) => ({
    ...base(r),
    returnedOn: (r.returned_on as string) ?? null,
    returnedAmount: r.returned_amount == null ? null : Number(r.returned_amount),
    note: (r.note as string) ?? null,
    returnNote: (r.return_note as string) ?? null,
  }));

  return {
    onAccount,
    deposits,
    onAccountTotal: Math.round(onAccount.reduce((s, r) => s + r.amount, 0) * 100) / 100,
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
  const { data } = await admin
    .from("park_renters")
    .select("id, display_name, merged_into")
    .eq("park_id", parkId)
    .is("merged_into", null)          // a merged file is a duplicate, not a household
    .order("display_name");
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
  const { data } = await admin
    .from("park_charges")
    .select("id, renter_id, period_month, amount, paid_total, park_lot_id, status")
    .eq("park_id", parkId)
    .eq("status", "open")
    .order("period_month", { ascending: false })
    .limit(200);
  if (!data?.length) return [];

  const lotIds = [...new Set(data.map((c) => c.park_lot_id as string).filter(Boolean))];
  const lotNo = new Map<string, string>();
  if (lotIds.length) {
    const { data: lots } = await admin
      .from("park_lots").select("id, lot_number").in("id", lotIds);
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
