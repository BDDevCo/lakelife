"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { parseDaterange } from "@/lib/parks";
import { buildStatement, type StatementFee } from "./statement-helpers";
import {
  planRun, toRows, summarise, currentPeriod, prettyMonth,
  type Charge, type LedgerRow, type LedgerSummary, type RunPlan,
} from "./ledger-helpers";
import { sendEmail } from "@/lib/email";
import { receiptBody, type ReceiptLines } from "./receipt-helpers";
import { applyDueRentChanges } from "./rerate-actions";
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

/**
 * Mirrors 0102's `park_payments_received_on_is_sane` CHECK so a person gets a
 * sentence naming the field instead of a constraint name — or worse, the
 * generic retry message that never becomes true.
 *
 * Deliberately a touch TIGHTER than the database (729 days, not 730): the DB
 * compares against `created_at::date` in UTC, which is the lake date or the
 * day after it, so a JS mirror measured in lake time must stay inside the
 * narrower window or the edge day leaks a raw 23514.
 */
// NOT exported: this file carries "use server", where every export must be an
// async function — and a sync helper exported from one is both a build error
// and a server action nobody meant to create.
function paymentDateProblem(receivedOn: string, todayISO: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return "Pick the day the money arrived.";
  const day = 86_400_000;
  const got = Date.parse(`${receivedOn}T12:00:00Z`);
  const now = Date.parse(`${todayISO}T12:00:00Z`);
  if (!Number.isFinite(got)) return "That date isn't a date.";
  if (got > now + 31 * day) return "That's more than a month from now — check the year.";
  if (got < now - 729 * day) return "That's more than two years ago — check the year.";
  return null;
}

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


/**
 * UNBILLED COST SHARES, per tenancy.
 *
 * `lot_cost_shares` had exactly two references in the codebase — one insert
 * and one row count — so a water bill the owner split across nineteen
 * households reached none of them. This is the reader it never had.
 *
 * A share is billed ONCE: the run stamps `billed_on_charge_id`, and only a
 * void releases it again.
 */
async function unbilledCostShares(
  admin: ReturnType<typeof createServiceClient>,
  parkId: string,
  reservationIds: string[],
): Promise<Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>> {
  const out = new Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>();
  if (reservationIds.length === 0) return out;

  const { data: shares } = await admin
    .from("lot_cost_shares")
    .select("id, cost_id, reservation_id, amount, basis")
    .in("reservation_id", reservationIds)
    .is("billed_on_charge_id", null);
  if (!shares?.length) return out;

  const costIds = [...new Set(shares.map((s) => s.cost_id as string))];
  const { data: costs } = await admin
    .from("park_costs")
    .select("id, park_id, category, period_start, period_end")
    .in("id", costIds)
    .eq("park_id", parkId);          // never bill another park's water
  const costById = new Map((costs ?? []).map((c) => [c.id as string, c]));

  for (const sh of shares) {
    const cost = costById.get(sh.cost_id as string);
    if (!cost) continue;             // a cost from elsewhere, or since removed
    const label = `${String(cost.category ?? "cost").replace(/_/g, " ")} — your share`;
    const list = out.get(sh.reservation_id as string) ?? [];
    list.push({
      id: sh.id as string,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      amount: Number(sh.amount ?? 0),
      basis: cost.period_start && cost.period_end
        ? `for ${cost.period_start} to ${cost.period_end}`
        : "as allocated",
    });
    out.set(sh.reservation_id as string, list);
  }
  return out;
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

  // Same rule as the run (0101): an ended tenancy with a recorded move-out is
  // billed for the days it covered. Leaving it out here would break this
  // function's own stated invariant, two comments below — the preview would
  // omit a final part-month the run then charges.
  const { data: staysRaw } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, during, quoted_amount, status, moved_out_on")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active", "ended"]);
  const stays = (staysRaw ?? []).filter(
    (s) => s.status !== "ended" || s.moved_out_on != null,
  );

  // A PREVIEW MUST SHOW WHAT THE RUN WILL ACTUALLY DO.
  //
  // `runCharges` now applies any properly-served increase that has come due
  // before it bills. If this preview kept reading the old `quoted_amount`, the
  // total he approves and the total he gets would differ — which is the one
  // thing a confirm screen must never do. Nothing is written here: the new
  // amounts are overlaid for the arithmetic only.
  const { data: dueChanges } = await admin
    .from("lot_rent_changes")
    .select("reservation_id, to_amount")
    .eq("park_id", parkId)
    .lte("effective_on", todayLakeDate())
    .is("applied_at", null)
    .is("cancelled_at", null)
    .not("notice_given_on", "is", null);
  const pendingRate = new Map(
    (dueChanges ?? []).map((c) => [c.reservation_id as string, Number(c.to_amount)]),
  );

  // A VOIDED BILL IS NOT A BILL. Without this filter, cancelling a charge made
  // that household's month permanently unbillable — the row still occupied the
  // slot, `summarise` skips void charges so it didn't even read as
  // outstanding, and they simply stopped being billed for a month as a
  // consequence of the owner fixing a mistake. 0081 makes the unique index
  // agree.
  const { data: existing } = await admin
    .from("park_charges")
    .select("reservation_id")
    .eq("park_id", parkId)
    .eq("period_month", month)
    .neq("status", "void");
  const already = new Set((existing ?? []).map((c) => c.reservation_id as string));

  // The preview must include what the run will bill (its own stated
  // invariant, forty lines up) — and the run now bills cost shares.
  const shareMap = await unbilledCostShares(admin, parkId, (stays ?? []).map((s) => s.id as string));

  const candidates = (stays ?? []).map((s) => {
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    const rentNow = pendingRate.has(s.id as string)
      ? pendingRate.get(s.id as string)!
      : (s.quoted_amount == null ? null : Number(s.quoted_amount));
    const st = range
      ? buildStatement({
          month,
          stay: range,
          rent: rentNow,
          // A nightly home is priced per stay, not billed a monthly fee.
          fees: (lot.rental_mode as string) === "short_term" ? [] : fees,
          dueDay,
          costShares: shareMap.get(s.id as string) ?? [],
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

  // RENT INCREASES THAT ARE DUE GET APPLIED BEFORE ANYTHING IS BILLED.
  //
  // `applyDueRentChanges` only ran from the nightly — 00:00 UTC, which is
  // about 8pm in Indiana. So an owner billing on the morning of the 1st raised
  // every bill at the OLD rate, and the increase landed twelve hours later
  // with the statements already frozen. At 19 lots and $25 that is $475 he
  // never collects, every time.
  //
  // Safe to call here: it is idempotent, scoped to this park, and the database
  // refuses any change whose notice was not properly served — so this can only
  // ever apply increases that were already legitimately due today.
  const rateMoves = await applyDueRentChanges(parkId);

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

  // ENDED TENANCIES ARE BILLED FOR THEIR LAST PART-MONTH (0101).
  //
  // This filtered to approved/active, which meant a household that moved out
  // on the 20th dropped out of every future run — so their twenty days were
  // either inside a full-month charge nobody could correct (voiding it made
  // the month permanently unbillable) or were never billed at all, silently.
  //
  // Including 'ended' is safe without a date filter, because `buildStatement`
  // returns a total of 0 for a stay that covers none of the month and the loop
  // below already skips a zero. A tenancy that ended in July simply
  // contributes nothing to August.
  //
  // 'cancelled' stays OUT: nobody ever lived there.
  const { data: staysRaw } = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, quoted_amount, status, moved_out_on")
    .in("park_lot_id", [...lotById.keys()])
    .in("status", ["approved", "active", "ended"]);

  // An 'ended' row with no `moved_out_on` was closed by the old one-click
  // path, so its range was never trimmed and still runs to the end of the
  // agreement. Billing from that range would charge a departed household for
  // months they were not here. No move-out date, no bill.
  const stays = (staysRaw ?? []).filter(
    (s) => s.status !== "ended" || s.moved_out_on != null,
  );

  // Same rule as the preview: a cancelled bill leaves the month billable.
  const { data: existing } = await admin
    .from("park_charges").select("reservation_id")
    .eq("park_id", parkId).eq("period_month", month)
    .neq("status", "void");
  const already = new Set((existing ?? []).map((c) => c.reservation_id as string));

  // The money the owner already paid out and split (0104). Billed once: the
  // stamp below is what stops a second run charging the water twice.
  const shareMap = await unbilledCostShares(admin, parkId, (stays ?? []).map((x) => x.id as string));
  /** reservation -> the share ids that went onto its charge, stamped after insert. */
  const shareIdsByRes = new Map<string, string[]>();

  const rows: Record<string, unknown>[] = [];
  for (const s of stays ?? []) {
    if (already.has(s.id as string)) continue;
    const lot = lotById.get(s.park_lot_id as string)!;
    const range = parseDaterange(s.during as string);
    if (!range) continue;

    const shares = shareMap.get(s.id as string) ?? [];
    const st = buildStatement({
      month, stay: range,
      rent: s.quoted_amount == null ? null : Number(s.quoted_amount),
      fees: (lot.rental_mode as string) === "short_term" ? [] : fees,
      dueDay,
      costShares: shares,
    });
    // No total = a rent nobody set. Billing zero would hide it behind a paid
    // charge; skipping leaves it visible on the roll where it belongs.
    if (st.total == null || st.total === 0) continue;
    if (shares.length) shareIdsByRes.set(s.id as string, shares.map((c) => c.id));

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
    return { ok: false, error: `Nothing to bill for ${prettyMonth(month)} — it may already be done.` };
  }

  const { data: raised, error } = await admin
    .from("park_charges").insert(rows).select("id, reservation_id");
  if (error) return { ok: false, error: "Couldn't raise those — try again." };

  // STAMP THE SHARES. Without this a second run bills the same water again —
  // the unique index stops a second CHARGE, but the shares would still read as
  // unbilled and land on the next month's bill instead.
  let sharesBilled = 0;
  for (const c of raised ?? []) {
    const ids = shareIdsByRes.get(c.reservation_id as string);
    if (!ids?.length) continue;
    const { error: stampErr } = await admin
      .from("lot_cost_shares")
      .update({ billed_on_charge_id: c.id })
      .in("id", ids)
      .is("billed_on_charge_id", null);   // never re-stamp one already spent
    if (!stampErr) sharesBilled += ids.length;
  }

  const total = rows.reduce((s, r) => s + (r.amount as number), 0);
  revalidatePath("/park/rent");
  revalidatePath("/park");
  return {
    ok: true,
    raised: rows.length,
    total,
    signal:
      `${rows.length} ${rows.length === 1 ? "bill" : "bills"} raised for ${prettyMonth(month)} — $${total.toFixed(2)}.` +
      (sharesBilled > 0
        ? ` ${sharesBilled} cost ${sharesBilled === 1 ? "share" : "shares"} you'd allocated went onto those bills.`
        : "") +
      (rateMoves.applied > 0
        ? ` ${rateMoves.applied} rent ${rateMoves.applied === 1 ? "increase" : "increases"} came due today and went in first.`
        : "") +
      " Nobody has been told.",
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
  /**
   * Minted once when the form opens, so a double-tapped submit — or a retry
   * after a flaky connection at the office window — collides on 0081's unique
   * index instead of recording the money twice and burning two receipt
   * numbers. A genuinely second payment comes from a new form and a new key.
   */
  idempotencyKey?: string,
): Promise<ParkResult & { receipt?: ReceiptLines; renterEmail?: string | null }> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "That payment amount isn't a number." };
  }
  // 0102 put a sanity window on `received_on` — a mistyped year moves income
  // into another tax year and nobody finds out until an accountant does. This
  // form had no date check at all, so the database's refusal would have
  // surfaced as the anonymous "Couldn't record that — try again" below,
  // forever, with no clue which field was wrong.
  const dateBad = paymentDateProblem(receivedOn, todayLakeDate());
  if (dateBad) return { ok: false, error: dateBad };

  const admin = createServiceClient();
  // Confirm the charge belongs to this park before writing against it.
  const { data: charge } = await admin
    .from("park_charges").select("id, park_id, renter_id, amount, paid_total, status")
    .eq("id", chargeId).eq("park_id", parkId).maybeSingle();
  if (!charge) return { ok: false, error: "That bill isn't here." };
  if (charge.status === "void") {
    return { ok: false, error: "That bill was cancelled — record it against a live one." };
  }

  // The insert returns the receipt number the trigger assigned, so the renter
  // can walk away with proof of what they just handed over.
  // Minted here, not when a receipt is sent: there is no bank in the middle of
  // these lakes and nothing external will ever validate this record, so the
  // renter's own confirmation is the only second party there will ever be. The
  // token exists from the moment the payment does.
  const confirmToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().slice(0, 8);

  const { data: written, error } = await admin.from("park_payments").insert({
    charge_id: chargeId,
    // 0102 made `park_id` NOT NULL so money with no charge still knows which
    // park it belongs to. This insert derived the park by joining through the
    // charge and never carried it — without these two lines every payment
    // recorded at the window would fail on a not-null violation.
    park_id: parkId,
    // Whose money it is. The first question anybody asks in a dispute, and it
    // was only answerable by walking charge -> renter.
    renter_id: (charge.renter_id as string) ?? null,
    amount,
    method,
    reference: reference.trim() || null,
    received_on: receivedOn,
    drop_slip_no: dropSlipNo?.trim() || null,
    confirm_token: confirmToken,
    idempotency_key: idempotencyKey?.trim() || null,
  }).select("receipt_no").single();
  if (error) {
    // 23505 on the idempotency index = this exact submit already landed. That
    // is a success from the office's point of view, not a failure — telling
    // them it failed is how the same money gets entered a second time.
    if (error.code === "23505") {
      return { ok: false, error: "That payment is already recorded — check the ledger before entering it again." };
    }
    return { ok: false, error: "Couldn't record that — try again." };
  }

  // THE BALANCE ON THE PIECE OF PAPER THEY WALK AWAY WITH.
  //
  // This used to be computed from the snapshot read BEFORE the insert, so a
  // payment landing in between printed a "still owing" figure that was already
  // wrong — on the only copy the renter keeps. Re-read after the trigger has
  // recomputed the total.
  const { data: after } = await admin
    .from("park_charges").select("amount, paid_total").eq("id", chargeId).maybeSingle();
  const balance = after
    ? Number(after.amount) - Number(after.paid_total)
    : Number(charge.amount) - Number(charge.paid_total) - amount;

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
    confirmUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/paid/${confirmToken}`,
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

  // RELEASE THE COST SHARES THIS BILL WAS CARRYING (0104).
  //
  // A voided charge leaves its month billable again — that is the whole point
  // of the void filter in the run. If the water shares stayed stamped to a
  // cancelled bill they would never reach anybody: the owner would cancel one
  // wrong bill and silently lose that household's share of a bill the park
  // has genuinely paid. Same lesson 0101 learned about a voided month.
  const { data: released } = await admin
    .from("lot_cost_shares")
    .update({ billed_on_charge_id: null })
    .eq("billed_on_charge_id", chargeId)
    .select("id");
  const n = released?.length ?? 0;

  revalidatePath("/park/rent");
  revalidatePath("/park/costs");
  return {
    ok: true,
    signal: n > 0
      ? `Cancelled. ${n} cost ${n === 1 ? "share is" : "shares are"} waiting again for the next bill.`
      : "Cancelled.",
  };
}

/**
 * The renter's open assertion against a charge, carried to the screen so it
 * can be answered. `id` is the whole point — without it the owner can see that
 * somebody disagrees and has no way to say what they found.
 */
export interface OpenClaim {
  id: string;
  charge_id: string;
  claimed_amount: number | null;
  claimed_paid_on: string | null;
  method: string | null;
  reference: string | null;
  note: string | null;
  asserted_by: string;
}
type RawClaim = OpenClaim;

export interface LedgerPage {
  month: string;
  rows: LedgerRow[];
  /** Unanswered claims on this month's charges, keyed by charge id. */
  claims: Record<string, OpenClaim>;
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
  // The claim's OWN id comes back, and what they actually said. Without the id
  // there is nothing to resolve — which is why `resolvePaymentClaim` sat
  // written, careful and tested, with no caller: the screen had no handle on
  // the thing it was being asked to close.
  const { data: claims } = chargeIds.length
    ? await admin
        .from("park_payment_claims")
        .select("id, charge_id, claimed_amount, claimed_paid_on, method, reference, note, asserted_by")
        .in("charge_id", chargeIds)
        .is("resolved_at", null)
    : { data: [] as RawClaim[] };
  const openClaims = (claims ?? []) as unknown as RawClaim[];
  const claimed = new Set(openClaims.map((c) => c.charge_id));
  const claimByCharge = new Map(openClaims.map((c) => [c.charge_id, c]));

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

  return {
    month: period,
    rows,
    claims: Object.fromEntries(claimByCharge),
    summary: summarise(rows),
    lagDays,
    today,
  };
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

  // Today carries a "somebody disagrees" card that has no dismiss of its own —
  // answering the claim IS the dismissal, so that screen has to be rebuilt too.
  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
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

/**
 * TAKING BACK A PAYMENT THAT SHOULDN'T HAVE BEEN RECORDED.
 *
 * A transposed digit and a bounced check are the same shape, and until now
 * both were permanent: `recordPayment` was the only write to `park_payments`,
 * 0070 forbids a zero or negative amount so a compensating row is impossible,
 * and 0072 refuses to void a charge that has money against it. Type $4,395
 * instead of $439.50 and that household is unfixably in credit forever — while
 * the printed receipt promises "the bill goes back to outstanding".
 *
 * THE ROW IS NOT DELETED. It keeps its receipt number and its place in the
 * sequence, and gains a reason and a timestamp. This ledger exists because a
 * payment is something two people were there for; quietly erasing the record
 * of one is the opposite of the point. What changes is that 0081's
 * `sync_charge_paid` stops counting it, so the balance tells the truth again.
 *
 * The reason is required by the database, not just by this function. A
 * reversal moves money against somebody, and "it was wrong" with no
 * explanation is indistinguishable from an office covering a mistake.
 */
export async function reversePayment(
  parkId: string,
  paymentId: string,
  reason: string,
): Promise<ParkResult> {
  if (!(await assertMyPark(parkId))) return { ok: false, error: DENIED };
  const why = reason.trim();
  if (!why) {
    return { ok: false, error: "Say what happened — a bounced check, a typo. The record has to carry the reason." };
  }
  if (why.length > 500) return { ok: false, error: "That's a bit long — a sentence is plenty." };

  const admin = createServiceClient();

  // SCOPE BY THE PARK ON THE PAYMENT, not through the charge.
  //
  // This used to read `park_charges!inner(park_id)`, and an INNER join drops
  // any row whose charge_id is NULL — which since 0102 is every deposit and
  // every cheque taken before the bill existed. So money recorded by mistake
  // at the window could never be taken back, and the office was told "That
  // isn't here" about a payment sitting on their own screen.
  const { data: pay } = await admin
    .from("park_payments")
    .select("id, amount, receipt_no, reversed_at, park_id, kind, charge_id")
    .eq("id", paymentId)
    .eq("park_id", parkId)
    .maybeSingle();
  if (!pay) return { ok: false, error: "That isn't here." };
  if (pay.reversed_at) return { ok: false, error: "That one's already been taken back." };

  // A DEPOSIT ALREADY GIVEN BACK CANNOT BE UNSAID. Reversing means "this never
  // happened", and the money demonstrably did go back out — leaving a
  // returned_amount on a reversed row would be the ledger holding two
  // contradictory facts about the same cash.
  if (pay.kind === "deposit") {
    const { data: dep } = await admin
      .from("park_payments").select("returned_on").eq("id", paymentId).maybeSingle();
    if (dep?.returned_on) {
      return { ok: false, error: "That deposit was already returned — reversing it would contradict the record." };
    }
  }

  const { error } = await admin
    .from("park_payments")
    .update({
      reversed_at: new Date().toISOString(),
      reversed_reason: why,
      reversed_by: await currentUserId(),
    })
    .eq("id", paymentId)
    .is("reversed_at", null); // never reverse twice
  if (error) return { ok: false, error: "Couldn't record that — try again." };

  revalidatePath("/park/rent");
  revalidatePath("/park/today");
  revalidatePath("/park");
  const amount = Number(pay.amount ?? 0);
  return {
    ok: true,
    signal:
      `$${amount.toFixed(2)} taken back${pay.receipt_no ? ` (receipt ${pay.receipt_no})` : ""}. ` +
      // Money with no charge has no bill to become outstanding again — saying
      // it does would send somebody looking for a balance that never moved.
      (pay.charge_id
        ? "The bill is outstanding again, and the record shows why."
        : pay.kind === "deposit"
          ? "That deposit is no longer held, and the record shows why."
          : "It's off the household's account, and the record shows why."),
  };
}
