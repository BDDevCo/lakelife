"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import { mustRead } from "@/lib/must-read";
import {
  monthPeriod,
  quarterPeriod,
  yearPeriod,
  customPeriod,
  summariseReceipts,
  exclusionLines,
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

export interface StatementPage {
  parkName: string;
  period: Period;
  summary: ReceiptSummary;
  receipts: Receipt[];
  /**
   * Money that reached the park in this window but is NOT rent against a bill —
   * deposits, money on account, and what a park rents out. Excluded from the
   * rent total on purpose; carried so the FILE can state the same figures the
   * screen does.
   */
  otherReceipts: OtherReceipt[];
  notes: string[];
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
  const offBook = mustRead(
    "the deposits and money on account",
    await admin
      .from("park_payments")
      // WIDENED so this money can be WRITTEN OUT, not merely counted. These
      // rows were summed into three sentences on the screen and then dropped:
      // the file the accountant is actually sent had no row, no total and no
      // sentence for any of it.
      .select("id, amount, kind, charge_id, received_on, method, reference, fee_amount")
      .eq("park_id", parkId)
      .is("charge_id", null)
      .is("reversed_at", null)
      // AND THE BANK ROUTE. These rows become deposit, on-account and amenity
      // lines in the accountant's file, and amenity money is paid by CARD —
      // which 0142 forbids reversing, so `reversed_at` alone could never have
      // excluded a single failed one. A returned deposit counted here is a
      // liability the park does not owe and income it never had.
      .is("returned_at", null)
      .gte("received_on", period.from)
      .lte("received_on", period.to),
  );
  const depositsReceivedCents = Math.round(
    (offBook ?? []).filter((p) => p.kind === "deposit")
      .reduce((s2, p) => s2 + Number(p.amount ?? 0), 0) * 100,
  );
  // "ON ACCOUNT" MEANS MONEY NOT YET PUT AGAINST A BILL. An amenity payment is
  // not that — it is a boat day, paid in full, and it is never going to reach a
  // rent bill because it is not rent. Bucketing it here (the old `!== deposit`)
  // would have printed the park's first boat money as "received on account",
  // which is the kind of line an accountant queries a year later.
  const onAccountReceivedCents = Math.round(
    (offBook ?? []).filter((p) => p.kind !== "deposit" && p.kind !== "amenity")
      .reduce((s2, p) => s2 + Number(p.amount ?? 0), 0) * 100,
  );
  const amenityReceivedCents = Math.round(
    (offBook ?? []).filter((p) => p.kind === "amenity")
      .reduce((s2, p) => s2 + Number(p.amount ?? 0), 0) * 100,
  );

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
  }));

  // The branch below turns an empty result into a complete, plausible,
  // ZERO statement. It must only ever be reachable by a park that has genuinely
  // never billed anybody.
  const charges = mustRead(
    "the bills you've raised",
    await admin
      .from("park_charges")
      .select("id, park_lot_id, renter_id, period_month, due_on, amount, status, lines")
      .eq("park_id", parkId),
  );

  const chargeIds = (charges ?? []).map((c) => c.id as string);
  if (chargeIds.length === 0) {
    const empty = summariseReceipts([], period);
    return {
      parkName, period, summary: empty, receipts: [], otherReceipts,
      notes: exclusionLines({
        recordsBeginOn: null, lagDays, unbilledFeeLabels: [], anyMissingPayerName: false,
        depositsReceivedCents, onAccountReceivedCents, amenityReceivedCents,
      }),
      recordsBeginOn: null, billedInWindowCents: 0,
      today, generatedAt: new Date().toISOString(),
    };
  }

  const [paymentsRes, lotsRes, rentersRes, feesRes] = await Promise.all([
    admin
      .from("park_payments")
      .select("id, charge_id, amount, fee_amount, method, reference, received_on, reversed_at, reversed_reason, returned_at, return_code")
      .in("charge_id", chargeIds),
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_renters").select("id, display_name").eq("park_id", parkId),
    admin.from("park_fees").select("label, active").eq("park_id", parkId).eq("active", true),
  ]);
  // The first of these IS the statement. The other three are its labels, and a
  // statement full of lot "?" with no payer names is one nobody can tie to a
  // bank line — so none of them is allowed to fail quietly either.
  const payments = mustRead("the money received", paymentsRes);
  const lots = mustRead("your lots", lotsRes);
  const renters = mustRead("the households", rentersRes);
  const fees = mustRead("your park's fees", feesRes);

  const chargeById = new Map((charges ?? []).map((c) => [c.id as string, c]));
  const lotName = new Map((lots ?? []).map((l) => [l.id as string, l.lot_number as string]));
  const renterName = new Map((renters ?? []).map((r) => [r.id as string, r.display_name as string]));

  let anyMissingPayerName = false;
  const all: Receipt[] = (payments ?? []).map((p) => {
    const c = chargeById.get(p.charge_id as string)!;
    const payer = renterName.get(c.renter_id as string) ?? null;
    if (!payer) anyMissingPayerName = true;
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

  return {
    parkName,
    period,
    summary,
    receipts: inWindow,
    otherReceipts,
    notes: exclusionLines({
      recordsBeginOn, lagDays, unbilledFeeLabels, anyMissingPayerName,
      depositsReceivedCents, onAccountReceivedCents, amenityReceivedCents,
      // Summarised over the SAME window the total is, so the sentence and the
      // number can never disagree.
      cardFeesReceivedCents: summary.cardFeesCents,
    }),
    recordsBeginOn,
    billedInWindowCents,
    today,
    generatedAt: new Date().toISOString(),
  };
}
