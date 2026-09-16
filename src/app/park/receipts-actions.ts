"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate, lakeDateOf } from "@/lib/booking";
import { mustRead } from "@/lib/must-read";
import { parseDaterange } from "@/lib/parks";
import { coversDay } from "./park-helpers";
import { withRaisedAgain } from "@/lib/allocations";
import { tenancyFactsFor, nothingMoreBills } from "@/lib/tenancy-facts";
import {
  monthPeriod,
  quarterPeriod,
  yearPeriod,
  customPeriod,
  summariseReceipts,
  exclusionLines,
  notCollectedAt,
  takenBackOfRow,
  type Receipt,
  type Period,
  type ReceiptSummary,
  type Method,
  type ChargeLine,
  type OtherReceipt,
} from "./receipts-helpers";

/**
 * THE READ SIDE OF THE CASH STATEMENT.
 *
 * Reads only. Nothing here writes, so re-running it a hundred times before
 * filing changes nothing and costs nothing.
 *
 * The one rule that matters: a receipt is a `park_payments` row, and it is
 * dated by `received_on`. The join to charges and lots is for LABELS — the lot
 * number, the payer, the bill's frozen breakdown. None of it is allowed to
 * filter which cash counts.
 */

/** Money arrives from Postgres numeric as a string. Round once, to cents. */
function cents(v: unknown): number {
  return Math.round(Number(v ?? 0) * 100);
}

/** A refund row's figures are negative — and a zero fee is 0, never -0. */
function negate(c: number): number {
  return c === 0 ? 0 : -c;
}

export interface StatementPage {
  parkName: string;
  period: Period;
  summary: ReceiptSummary;
  receipts: Receipt[];
  /**
   * Money that reached the park in this window but is NOT rent against a bill —
   * deposits, money on account, and what a park rents out — INCLUDING the rows
   * that were since taken back (marked, out of every figure), each refund
   * through the processor as its own NEGATIVE row on the day it went back
   * (kind "refund"), and each hand-back across the window the same way (kind
   * "handed_back": a deposit returned, rent on account handed back).
   * Excluded from the rent total on purpose; carried so the FILE can state the
   * same figures the screen does and still add up to the bank.
   */
  otherReceipts: OtherReceipt[];
  notes: string[];
  /**
   * EVERY CARD FEE THAT REACHED THE PROCESSOR IN THIS WINDOW, in cents — on
   * rent against a bill (summary.cardFeesCents) AND on the on-account and
   * amenity rows that still stand, LESS any fee sent back with a refund. One
   * figure, computed once here, read by the summary card and the note both:
   * the note used to say "$16.28 in card fees" while the file's Card fee
   * column summed to $34.28, because the sentence counted bill rows only.
   */
  cardFeesReceivedCents: number;
  /** Earliest payment ever recorded here — the edge of what we can know. */
  recordsBeginOn: string | null;
  /** What was BILLED as due in this window. Accrual, shown for contrast only. */
  billedInWindowCents: number;
  today: string;
  generatedAt: string;
}

export async function resolvePeriod(
  kind: "month" | "quarter" | "year" | "custom",
  a: string,
  b?: string,
): Promise<Period | null> {
  const today = todayLakeDate();
  if (kind === "month") return monthPeriod(a, today);
  if (kind === "year") return yearPeriod(Number(a), today);
  if (kind === "quarter") {
    const [y, q] = a.split("-").map(Number);
    if (!y || q < 1 || q > 4) return null;
    return quarterPeriod(y, q as 1 | 2 | 3 | 4, today);
  }
  return customPeriod(a, b ?? a, today);
}

/** Everything the statement screen and the file both need. */
export async function getStatement(
  parkId: string,
  from: string,
  to: string,
): Promise<StatementPage | null> {
  if (!(await assertMyPark(parkId))) return null;
  const today = todayLakeDate();
  const period = customPeriod(from, to, today);
  if (!period) return null;

  const admin = createServiceClient();
  // EVERY READ BELOW EITHER ANSWERS OR THROWS. This page becomes a file that
  // is forwarded to an accountant and then filed, and every empty case here
  // reads as a fact about the year: "This park", no receipts, nothing
  // excluded, $0 collected. A cash statement that is quietly short is worse
  // than no statement, because nobody goes looking for the missing part.
  const park = mustRead(
    "your park",
    await admin
      .from("parks")
      .select("name, office_recording_lag_days")
      .eq("id", parkId)
      .maybeSingle(),
  );
  const parkName = (park?.name as string) ?? "This park";
  const lagDays = (park?.office_recording_lag_days as number) ?? 0;

  // CASH THAT CAME IN BUT IS NOT RENT RECEIVED (0102). This statement is built
  // by scoping payments through their charges, so a deposit and money on
  // account — both real cash in the bank, neither anchored to a charge — fall
  // out of it entirely. Silently omitting them means this cannot be reconciled
  // against a bank statement, and the first person to notice is an accountant
  // a year later. They stay OUT of the rent-received total, on purpose, and
  // are counted here so the notes can say the amounts out loud.
  //
  // (The old comment here said park_payments has no park_id of its own. It has
  // one now, which is why the query below can exist at all.)
  //
  // REVERSED AND BANK-RETURNED ROWS ARE READ TOO. This used to filter both
  // out, so a bounced quarter-ahead cheque left the file with no row, no note
  // and a hole in the receipt-number sequence — while the same cheque
  // recorded AGAINST a bill was kept and marked "Taken back". The rule is one
  // rule: the row stays, labelled, and counts toward nothing. The figures
  // below are summed over the rows that STILL STAND; the rest are carried
  // into `otherReceipts` with the four taken-back fields filled.
  const offBook = mustRead(
    "the deposits and money on account",
    await admin
      .from("park_payments")
      .select("id, amount, kind, charge_id, received_on, method, reference, fee_amount, renter_id, reversed_at, reversed_reason, returned_at, return_code")
      .eq("park_id", parkId)
      .is("charge_id", null)
      .gte("received_on", period.from)
      .lte("received_on", period.to),
  );
  const stands = (p: { reversed_at?: unknown; returned_at?: unknown }) =>
    p.reversed_at == null && p.returned_at == null;

  // MONEY HANDED BACK ACROSS THE WINDOW IN THIS WINDOW — the fourth way money
  // leaves, and the only one that needs no processor: a deposit returned at
  // move-out (0102), rent on account handed back to a household that has
  // gone (0168). The record is the stamp on the payment row — returned_on,
  // returned_amount, return_note — and it is read by the day it went BACK,
  // never by received_on: a $500 deposit received in December and given back
  // by park cheque in February belongs in February's file, as a negative row,
  // or February's Amount column is off by exactly the cheque the park wrote.
  // Three doors out of the books were rows or sentences here (reversal, bank
  // return, refund) and this one was read by nothing while the note beneath
  // still promised "Any amounts are listed below so this still reconciles to
  // your bank". Off park_payments, not the on-account view: the stamp is the
  // one record for deposits and rent alike, and it is there today.
  const handedBackRows = mustRead(
    "what was handed back across the window",
    await admin
      .from("park_payments")
      .select("id, amount, kind, charge_id, method, renter_id, returned_on, returned_amount, return_note, reversed_at, returned_at")
      .eq("park_id", parkId)
      .gte("returned_on", period.from)
      .lte("returned_on", period.to),
  );
  // In the order they went back, so the note and the file read the same way.
  const handedBackInWindow = (handedBackRows ?? [])
    .filter((p) => p.returned_on != null && Number(p.returned_amount ?? 0) > 0)
    .sort((a, b) => String(a.returned_on).localeCompare(String(b.returned_on)) || String(a.id).localeCompare(String(b.id)));
  const standing = (offBook ?? []).filter(stands);
  const isAcct = (p: { kind?: unknown }) => p.kind !== "deposit" && p.kind !== "amenity";
  const sumCents = (rows: Array<{ amount?: unknown }>) =>
    Math.round(rows.reduce((s2, p) => s2 + Number(p.amount ?? 0), 0) * 100);
  const depositsReceivedCents = sumCents(standing.filter((p) => p.kind === "deposit"));
  // "ON ACCOUNT" MEANS MONEY NOT YET PUT AGAINST A BILL. An amenity payment is
  // not that — it is a boat day, paid in full, and it is never going to reach a
  // rent bill because it is not rent. Bucketing it here (the old `!== deposit`)
  // would have printed the park's first boat money as "received on account",
  // which is the kind of line an accountant queries a year later.
  const onAccountReceivedCents = sumCents(standing.filter(isAcct));
  const amenityReceivedCents = sumCents(standing.filter((p) => p.kind === "amenity"));
  // What arrived in this window as a deposit, on account or for an amenity
  // and then did NOT stay. A separate figure from summary.reversedCents
  // (rent against bills) on purpose: they are different money and the note
  // says so.
  const otherTakenBackCents = sumCents((offBook ?? []).filter((p) => !stands(p)));

  // The branch below turns an empty result into a complete, plausible,
  // ZERO statement. It must only ever be reachable by a park that has genuinely
  // never billed anybody.
  const charges = mustRead(
    "the bills you've raised",
    await admin
      .from("park_charges")
      .select("id, park_lot_id, renter_id, period_month, due_on, amount, status, voided_at, lines")
      .eq("park_id", parkId),
  );
  const chargeById = new Map((charges ?? []).map((c) => [c.id as string, c]));
  const chargeIds = [...chargeById.keys()];

  // THE LABELS — THE HOUSEHOLDS AND THE LOTS — READ BEFORE THE EMPTY BRANCH,
  // because the off-book rows need them too: a park with no bills yet can
  // still hold a signing cheque on account, and that row must name the
  // household. These used to sit below the early return, so on-account and
  // deposit rows printed blank Lot and Payer cells in every window.
  const [lotsRes, rentersRes] = await Promise.all([
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_renters").select("id, display_name").eq("park_id", parkId),
  ]);
  // A statement full of lot "?" with no payer names is one nobody can tie to
  // a bank line — so neither is allowed to fail quietly.
  const lots = mustRead("your lots", lotsRes);
  const renters = mustRead("the households", rentersRes);
  const lotName = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  // WHERE THE MONEY ON ACCOUNT HAS SINCE GONE (0167) — per row, so the file's
  // Bill month cell and the screen's row can name the months. Only rent on
  // account has allocations, and only a row that still stands can have money
  // anywhere: a reversed cheque's allocations survive as the record of where
  // it HAD gone, and are not "gone" anywhere now. A removed allocation (taken
  // back off its bill) is not "gone" anywhere either. Cash basis is
  // untouched: the row is still dated the day it arrived and counted once.
  //
  // THIS IS THE WRITER for OtherReceipt.appliedTo and onAccountAppliedCents.
  // For one round both fields were read by the CSV, the note and the screen
  // and written by nothing, so the file printed "On account (not yet
  // applied)" about a cheque the run had spent on three months. A park with
  // no bills has no allocations to read (they reference bills), so the empty
  // branch below writes `[]` and 0 rather than skipping the fields.
  const acctIds = standing.filter(isAcct).map((p2) => p2.id as string);

  // WHAT IS STILL HELD — the VIEW'S `remaining`, never `received − applied`
  // here. The one definition of what is left on a payment lives in
  // park_payment_remaining (amount − live allocations − refunds); a
  // subtraction in this file would print "$57.47 is still held" in the
  // accountant's file about $57.47 that went back to a card. Read ONCE for
  // the whole park, because the view lists two populations now (0169): rent
  // recorded on account (charge_id null — the rows in `acctIds`), and rent
  // paid straight against a bill that was LATER CANCELLED, released onto the
  // household's account with the row left where it was (charge_id still the
  // void bill; released_from_charge_id names it). The second population is
  // not in `acctIds` — those rows are RECEIPTS, against their cancelled
  // bill, counted once as rent received below — but their remainder and
  // allocations are what the accountant asks about, so they are read here
  // and carried on the Receipt (`released`). A row absent from the view was
  // taken back between the reads and is read as nothing held rather than
  // guessed. mustRead: a failed read must not print "still held" about a
  // figure nobody looked at.
  const viewRows = mustRead(
    "what is still held on account",
    await admin
      .from("park_on_account_payments")
      .select("payment_id, remaining, refunded, released_from_charge_id, handed_back, handed_back_on")
      .eq("park_id", parkId),
  ) ?? [];
  const remainingByPayment = new Map(viewRows.map((h) => [h.payment_id as string, cents(h.remaining)]));
  // THE ON-ACCOUNT FIGURE IS THE ON-ACCOUNT ROWS' ALONE. Released money is
  // not folded in: the note's "$X of the money on account has since been
  // put against bills — and $Y is still held" is about money RECEIVED ON
  // ACCOUNT in this window, and a released $70.00 was received as rent. It
  // gets its own sentence (releasedFromCancelled, below).
  const onAccountHeldCents = acctIds.reduce((s2, id) => s2 + (remainingByPayment.get(id) ?? 0), 0);
  const releasedById = new Map(
    viewRows
      .filter((h) => h.released_from_charge_id != null)
      .map((h) => [h.payment_id as string, h]),
  );
  const releasedIds = [...releasedById.keys()];

  // WHERE THE MONEY HAS SINCE GONE (0167): the live allocations off the
  // on-account rows AND off the released rows, in one read — a released
  // $542.53 is put against the part month exactly as a cheque on account is.
  const allocIds = [...acctIds, ...releasedIds];
  const allocRows = allocIds.length && chargeIds.length
    ? (mustRead(
        "where the money on account went",
        await admin
          .from("park_payment_allocations")
          .select("payment_id, charge_id, amount")
          .eq("park_id", parkId)
          .in("payment_id", allocIds)
          .is("removed_at", null),
      ) ?? [])
    : [];
  const appliedByPayment = new Map<string, Array<{ periodMonth: string; amountCents: number; chargeId: string }>>();
  for (const a of allocRows) {
    const list = appliedByPayment.get(a.payment_id as string) ?? [];
    list.push({
      periodMonth: String(chargeById.get(a.charge_id as string)?.period_month ?? ""),
      amountCents: cents(a.amount),
      chargeId: a.charge_id as string,
    });
    appliedByPayment.set(a.payment_id as string, list);
  }
  // The applied figure is the on-account rows' alone, for the same reason
  // the held figure is: the sentence it feeds is about money received on
  // account. A released row's allocations reach the note through its own
  // sentence and the file through its own cell.
  const acctIdSet = new Set(acctIds);
  const onAccountAppliedCents = allocRows
    .filter((a) => acctIdSet.has(a.payment_id as string))
    .reduce((s2, a) => s2 + cents(a.amount), 0);
  // MONEY THAT WENT BACK OUT TO A CARD (0142), dated the day it went back —
  // lake-local, like every other date in this file. The refund reduces what
  // the bill counts as paid and what the view says is still held, but this
  // statement, its notes and its file never read the table, so $140 that
  // went back to two cards was counted as received and the file the notes
  // promised "still reconciles to your bank" was off by exactly that.
  //
  // Read as a superset by created_at (UTC midnight is before lake midnight)
  // and cut to the window on the lake's calendar in JS. The refunded
  // PAYMENTS are read by id — the payment may have arrived in an earlier
  // window, so neither read above is guaranteed to hold it.
  const refundRows = mustRead(
    "what went back to cards",
    await admin
      .from("park_refunds")
      .select("id, payment_id, amount, fee_amount, processor_ref, created_at")
      .eq("park_id", parkId)
      .gte("created_at", `${period.from}T00:00:00Z`),
  );
  const refundsInWindow = (refundRows ?? [])
    .map((r) => ({ ...r, refundedOn: lakeDateOf(String(r.created_at ?? "")) ?? "" }))
    .filter((r) => r.refundedOn >= period.from && r.refundedOn <= period.to)
    // In the order they went back, so the note and the file read the same way.
    .sort((a, b) => a.refundedOn.localeCompare(b.refundedOn) || String(a.created_at).localeCompare(String(b.created_at)));
  const refundedPaymentIds = [...new Set(refundsInWindow.map((r) => r.payment_id as string))];
  const refundedPayments = refundedPaymentIds.length
    ? (mustRead(
        "the payments that were refunded",
        await admin
          .from("park_payments")
          .select("id, renter_id, charge_id, method")
          .in("id", refundedPaymentIds),
      ) ?? [])
    : [];
  const refundedPaymentById = new Map(refundedPayments.map((p2) => [p2.id as string, p2]));

  /**
   * WHERE A RELEASED RECEIPT'S MONEY IS NOW (0169) — the writer for
   * Receipt.released, read by the statement screen's sentence, the file's
   * Bill status cell and the note. Only for a row the view lists (it still
   * stands and its bill is void); every other receipt carries nothing.
   *
   * WHICH FILE ITS HAND-BACK AND REFUND ROWS ARE IN comes from the windowed
   * reads that build those rows — `handedBackInWindow` and `refundsInWindow`
   * — never from comparing the stamp's date against the window here: the
   * two reads can fail apart, and the sentence must promise a row only the
   * read that writes the row has seen.
   */
  const handedBackIds = new Set(handedBackInWindow.map((p2) => p2.id as string));
  const refundedInWindowIds = new Set(refundedPaymentIds);
  const releasedOf = (paymentId: string): Receipt["released"] | undefined => {
    const row = releasedById.get(paymentId);
    if (!row) return undefined;
    // The month the money was released FROM — the cancelled bill's — so
    // the line against the month raised again for it is named apart.
    const releasedFromMonth = String(chargeById.get(row.released_from_charge_id as string)?.period_month ?? "") || null;
    return {
      allocations: (appliedByPayment.get(paymentId) ?? []).map((a) =>
        withRaisedAgain({ periodMonth: a.periodMonth, amount: a.amountCents / 100 }, releasedFromMonth, chargeById.get(a.chargeId)?.lines)),
      remainingCents: cents(row.remaining),
      handedBackCents: cents(row.handed_back),
      handedBackOn: (row.handed_back_on as string | null) ?? null,
      handedBackInFile: handedBackIds.has(paymentId),
      refundedCents: cents(row.refunded),
      refundedInFile: refundedInWindowIds.has(paymentId),
    };
  };

  // THE LOT EACH HOUSEHOLD IS ON — the roll's own rule (buildRentRoll's
  // `current`, my-data's `stay`): the link covering today, else the next to
  // start, else any live link, else the one they most recently LEFT. Ended
  // links are read on purpose: every on-account, deposit, refund and hand-back
  // row of a household that has gone printed a blank Lot cell in every
  // statement read after they went, and the accountant tying cheque 2101 to
  // a lot ledger in April for a household gone in February got nothing — the
  // ended link's lot was one status away. Deterministic, too: a household
  // holding a current link and a future successor on another lot (a move
  // within the park) got whichever row Postgres returned first.
  //
  // NOT the allocated bills' lot first: a cheque nothing has touched yet
  // would stay anonymous. The bills are the fallback for a household with no
  // link at all, and only then does a row print nothing rather than "?".
  const householdIds = [...new Set([
    ...(offBook ?? []).map((p2) => p2.renter_id as string | null),
    ...refundedPayments.map((p2) => p2.renter_id as string | null),
    ...handedBackInWindow.map((p2) => p2.renter_id as string | null),
  ].filter((id): id is string => !!id))];
  const staysRes = householdIds.length
    ? await admin
        .from("lot_reservations")
        .select("renter_id, park_lot_id, during, status, moved_out_on")
        .in("renter_id", householdIds)
        .in("status", ["approved", "active", "ended"])
    : { data: [], error: null };
  const stays = mustRead("the households' lots", staysRes) ?? [];
  // WHETHER ANYTHING MORE BILLS for the households whose rent on account is
  // in this window — the one rule (lib/tenancy-facts), so the statement's
  // "comes off the next bill raised for that household" stops where every
  // other door's does. mustRead inside: a failed read throws rather than
  // rendering the promise.
  const acctHouseholds = [...new Set(standing.filter(isAcct).map((p2) => p2.renter_id as string | null).filter((id): id is string => !!id))];
  const tenancy = await tenancyFactsFor(admin, acctHouseholds);
  const startOf = (r: { during?: unknown }) => parseDaterange(r.during as string)?.start ?? "";
  const endOf = (r: { during?: unknown; moved_out_on?: unknown }) =>
    (r.moved_out_on as string | null) ?? parseDaterange(r.during as string)?.end ?? "";
  const lotOfHousehold = new Map<string, string>();
  for (const id of householdIds) {
    const mine = stays.filter((st) => st.renter_id === id);
    const live = mine.filter((st) => st.status !== "ended");
    const pick =
      live.find((st) => coversDay(parseDaterange(st.during as string), today))
      ?? live.filter((st) => startOf(st) > today).sort((a, b) => startOf(a).localeCompare(startOf(b)))[0]
      ?? live[0]
      ?? mine.filter((st) => st.status === "ended").sort((a, b) => endOf(b).localeCompare(endOf(a)))[0];
    const lot = pick ? lotName.get(pick.park_lot_id as string) : undefined;
    if (lot) lotOfHousehold.set(id, lot);
  }
  /** The lot of the bills a payment was put against — the fallback when the household holds no link. */
  const lotOfBills = (chargeIdsOfPayment: readonly string[]) => {
    for (const cid of chargeIdsOfPayment) {
      const lot = lotName.get(chargeById.get(cid)?.park_lot_id as string);
      if (lot) return lot;
    }
    return null;
  };
  const household = (renterId: unknown, chargeIdsOfPayment: readonly string[] = []) => ({
    payerName: renterId ? (renterName.get(String(renterId)) ?? null) : null,
    lotNumber: (renterId ? (lotOfHousehold.get(String(renterId)) ?? null) : null) ?? lotOfBills(chargeIdsOfPayment),
  });
  /** Which bills an on-account payment's live allocations touch — for the lot fallback. */
  const billsOf = new Map<string, string[]>();
  for (const a of allocRows) {
    const list = billsOf.get(a.payment_id as string) ?? [];
    list.push(a.charge_id as string);
    billsOf.set(a.payment_id as string, list);
  }

  // THE SAME MONEY, AS ROWS THE ACCOUNTANT CAN TIE TO A BANK LINE.
  //
  // These three figures were reaching the caller only as prose in `notes`, and
  // `receiptsCsv` never receives notes. So the screen said "Also received in
  // this period: $500.00 in deposits taken" and "$250.00 for things you rent
  // out — that IS your income", and the file behind the button labelled
  // "Download N payments for your accountant" contained none of it. The
  // accountant sums the Amount column, ties it to the bank, and is short by
  // exactly that much — of which the amenity money is real, taxable park
  // income appearing in no book anywhere.
  //
  // They stay OUT of the rent total, which is correct and deliberate, and they
  // now appear as their own rows with a Kind saying what each one is. This is
  // the same judgement the "Taken back" column already makes: the row stays and
  // is LABELLED, because a file with a hole in it is a file an auditor has to
  // ask about.
  const otherReceipts: OtherReceipt[] = (offBook ?? []).map((p2) => ({
    paymentId: p2.id as string,
    kind: (p2.kind as string) ?? "other",
    receivedOn: p2.received_on as string,
    amountCents: cents(p2.amount),
    feeCents: cents(p2.fee_amount),
    method: (p2.method as string) ?? "other",
    reference: (p2.reference as string) ?? null,
    ...household(p2.renter_id, billsOf.get(p2.id as string) ?? []),
    ...takenBackOfRow(p2),
    // ALWAYS an array for money on account — `[]` means "read, nothing
    // applied"; `undefined` would mean "nobody looked", and the screen
    // deliberately says nothing in that case. Deposits and amenity money
    // are never applied to anything, so they carry no answer. A row that
    // was taken back has nothing applied and nothing held: `[]`, and no
    // held figure (the view no longer lists it).
    ...(isAcct(p2)
      ? {
          appliedTo: (appliedByPayment.get(p2.id as string) ?? []).map(({ periodMonth, amountCents }) => ({ periodMonth, amountCents })),
          // The view's figure per row, so a screen can say "still held"
          // only about money that is — a refunded row has none. Carried
          // only when the view had the row: a row it lacks was taken back
          // between the two reads, and the screen says nothing about it
          // rather than reading "given back" off a figure nobody wrote.
          ...(remainingByPayment.has(p2.id as string)
            ? { remainingCents: remainingByPayment.get(p2.id as string) }
            : {}),
          // The household's facts, when the row names one: read, never
          // assumed, so a departed household's row does not promise a bill.
          ...(p2.renter_id && tenancy.has(p2.renter_id as string)
            ? {
                nothingMoreBills: nothingMoreBills(tenancy.get(p2.renter_id as string)),
                movedOutOn: tenancy.get(p2.renter_id as string)!.movedOutOn,
              }
            : {}),
        }
      : {}),
  }));
  // EACH REFUND, AS ITS OWN NEGATIVE ROW on the day it went back. The payment
  // row is untouched — money received stays the row it was — and the refund
  // is the correction, as a new row. `paymentId` is the payment it came off,
  // so the accountant can tie the two; `reference` is the processor's own
  // reference for the money going out.
  const refunds: OtherReceipt[] = refundsInWindow.map((r) => {
    const pay = refundedPaymentById.get(r.payment_id as string);
    const charge = pay?.charge_id ? chargeById.get(pay.charge_id as string) : undefined;
    return {
      paymentId: r.payment_id as string,
      kind: "refund",
      receivedOn: r.refundedOn,
      amountCents: negate(cents(r.amount)),
      feeCents: negate(cents(r.fee_amount)),
      method: (pay?.method as string) ?? "card",
      reference: (r.processor_ref as string) ?? null,
      ...household(pay?.renter_id ?? charge?.renter_id ?? null, pay?.charge_id ? [String(pay.charge_id)] : []),
      reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null,
    };
  });
  otherReceipts.push(...refunds);
  const refundNotes = refunds.map((r) => ({
    amountCents: -r.amountCents, feeCents: -r.feeCents, refundedOn: r.receivedOn,
    lotNumber: r.lotNumber, payerName: r.payerName, method: r.method,
  }));
  // EACH HAND-BACK, AS ITS OWN NEGATIVE ROW on the day it went back — the
  // same shape as a refund. The payment row stays as received (money
  // received stays the row it was); the hand-back is the correction, as a
  // new row: no fee (nothing went through a processor), the payment's own
  // rail, the office's reason where the processor's reference would be, and
  // the household. A hand-back can never be reversed afterwards (0168), so
  // these four fields are always null on it.
  const handedBack: OtherReceipt[] = handedBackInWindow.map((p2) => ({
    paymentId: p2.id as string,
    kind: "handed_back",
    receivedOn: String(p2.returned_on),
    amountCents: negate(cents(p2.returned_amount)),
    feeCents: 0,
    method: (p2.method as string) ?? "other",
    reference: (p2.return_note as string) ?? null,
    ...household(p2.renter_id, billsOf.get(p2.id as string) ?? []),
    reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null,
  }));
  otherReceipts.push(...handedBack);
  const handedBackNotes = handedBack.map((h, i) => ({
    amountCents: -h.amountCents, on: h.receivedOn,
    lotNumber: h.lotNumber, payerName: h.payerName,
    kind: String(handedBackInWindow[i].kind ?? "rent"), note: h.reference,
  }));
  // Fees on the off-book rows that still stand, LESS what went back with a
  // refund (negative feeCents on those rows). A hand-back carries no fee.
  // Added to the rent rows' fees below into the one figure the summary card
  // and the note both print.
  const otherFeesCents = otherReceipts
    .filter((o) => !notCollectedAt(o))
    .reduce((s2, o) => s2 + o.feeCents, 0);

  if (chargeIds.length === 0) {
    const empty = summariseReceipts([], period);
    return {
      parkName, period, summary: empty, receipts: [], otherReceipts,
      notes: exclusionLines({
        recordsBeginOn: null, lagDays, unbilledFeeLabels: [], anyMissingPayerName: false,
        depositsReceivedCents, onAccountReceivedCents, amenityReceivedCents,
        onAccountAppliedCents, onAccountHeldCents, otherTakenBackCents,
        refunds: refundNotes, handedBack: handedBackNotes, cardFeesReceivedCents: otherFeesCents,
      }),
      cardFeesReceivedCents: otherFeesCents,
      recordsBeginOn: null, billedInWindowCents: 0,
      today, generatedAt: new Date().toISOString(),
    };
  }

  const [paymentsRes, feesRes] = await Promise.all([
    admin
      .from("park_payments")
      .select("id, charge_id, amount, fee_amount, method, reference, received_on, reversed_at, reversed_reason, returned_at, return_code")
      .in("charge_id", chargeIds),
    admin.from("park_fees").select("label, active").eq("park_id", parkId).eq("active", true),
  ]);
  // The first of these IS the statement. The lots and households above are
  // its labels; the fee list is the note about money that may be missing.
  // None of them is allowed to fail quietly.
  const payments = mustRead("the money received", paymentsRes);
  const fees = mustRead("your park's fees", feesRes);

  let anyMissingPayerName = false;
  const all: Receipt[] = (payments ?? []).map((p) => {
    const c = chargeById.get(p.charge_id as string)!;
    const payer = renterName.get(c.renter_id as string) ?? null;
    if (!payer) anyMissingPayerName = true;
    // A receipt against a CANCELLED bill whose money was released (0169):
    // the row never moved, so it is read here with every other receipt and
    // counted once; where its money is now comes from the view and the
    // allocations read above. Keyed on the view, never on `c.status` alone
    // — a void bill from before 0169, or a released row since taken back,
    // has nothing on account and must not say it has.
    const released = c.status === "void" ? releasedOf(p.id as string) : undefined;
    // The frozen snapshot. Read, never recomputed — re-rating somebody in June
    // must not move what May's bill said it was for.
    const raw = Array.isArray(c.lines) ? (c.lines as Record<string, unknown>[]) : [];
    const chargeLines: ChargeLine[] = raw.map((l) => ({
      label: String(l.label ?? "—"),
      amountCents: cents(l.amount),
    }));
    return {
      paymentId: p.id as string,
      chargeId: p.charge_id as string,
      amountCents: cents(p.amount),
      // The card fee, kept beside the rent rather than folded into it (0109).
      feeCents: cents(p.fee_amount),
      method: (p.method as Method) ?? "other",
      reference: (p.reference as string) ?? null,
      receivedOn: p.received_on as string,
      lotNumber: lotName.get(c.park_lot_id as string) ?? "?",
      payerName: payer,
      periodMonth: c.period_month as string,
      chargeAmountCents: cents(c.amount),
      chargeStatus: c.status as Receipt["chargeStatus"],
      chargeLines,
      reversedAt: (p.reversed_at as string) ?? null,
      reversedReason: (p.reversed_reason as string) ?? null,
      // 0142 forbids REVERSING a card or ACH payment, so every chargeback and
      // every ACH return reaches this statement on these two fields and no
      // others. Without them the file counts a bounced ACH as collected rent.
      bankReturnedAt: (p.returned_at as string) ?? null,
      returnCode: (p.return_code as string) ?? null,
      // Only on a row the view lists as released (0169) — a conditional
      // spread, so a receipt against a live bill carries no `released` key
      // at all rather than an undefined one a reader might test for.
      ...(released ? { released } : {}),
    };
  });

  const summary = summariseReceipts(all, period);
  const inWindow = all
    .filter((r) => r.receivedOn >= period.from && r.receivedOn <= period.to)
    .sort((a, b) =>
      a.receivedOn.localeCompare(b.receivedOn) ||
      a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true }));

  const recordsBeginOn = all.length
    ? all.reduce((min, r) => (r.receivedOn < min ? r.receivedOn : min), all[0].receivedOn)
    : null;

  // A fee that is switched on but has never appeared on a bill is money the
  // accountant may go looking for. Name it rather than let its absence read as
  // "nobody paid it".
  const billedLabels = new Set(
    (charges ?? []).flatMap((c) =>
      (Array.isArray(c.lines) ? (c.lines as Record<string, unknown>[]) : [])
        .map((l) => String(l.label ?? ""))),
  );
  const unbilledFeeLabels = (fees ?? [])
    .map((f) => f.label as string)
    .filter((label) => !billedLabels.has(label));

  // Accrual, for contrast only — "you billed this, you collected that".
  const billedInWindowCents = (charges ?? [])
    .filter((c) => c.status !== "void")
    .filter((c) => (c.due_on as string) >= period.from && (c.due_on as string) <= period.to)
    .reduce((s, c) => s + cents(c.amount), 0);

  // ONE FEE FIGURE. Fees on rent rows (summarised over the SAME window the
  // total is) plus fees on the off-book rows that stand, less fees sent back
  // with a refund. The summary card and the note both read THIS, so the
  // sentence and the number can never disagree — with each other, or with
  // the file's Card fee column.
  const cardFeesReceivedCents = summary.cardFeesCents + otherFeesCents;

  // RENT IN THIS WINDOW PAID ON A BILL SINCE CANCELLED, its money released
  // onto account (0169) — the writer for the note's own sentence. From the
  // receipts the file carries, so the note and the file name the same rows;
  // `released` exists only on a standing row the view lists, so a reversed
  // one names nothing here. The day the bill was cancelled is the bill's
  // own record (voided_at), read with the charges above.
  const releasedFromCancelled = inWindow
    .filter((r): r is Receipt & { released: NonNullable<Receipt["released"]> } => r.released != null)
    .map((r) => ({
      amountCents: r.amountCents,
      billMonth: r.periodMonth,
      releasedOn: (chargeById.get(r.chargeId)?.voided_at as string | null) ?? null,
      lotNumber: r.lotNumber === "?" ? null : r.lotNumber,
      payerName: r.payerName,
      ...r.released,
    }));

  return {
    parkName,
    period,
    summary,
    receipts: inWindow,
    otherReceipts,
    notes: exclusionLines({
      recordsBeginOn, lagDays, unbilledFeeLabels, anyMissingPayerName,
      depositsReceivedCents, onAccountReceivedCents, amenityReceivedCents,
      onAccountAppliedCents, onAccountHeldCents, otherTakenBackCents,
      refunds: refundNotes,
      handedBack: handedBackNotes,
      releasedFromCancelled,
      cardFeesReceivedCents,
    }),
    cardFeesReceivedCents,
    recordsBeginOn,
    billedInWindowCents,
    today,
    generatedAt: new Date().toISOString(),
  };
}
