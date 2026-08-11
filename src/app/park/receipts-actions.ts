"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertMyPark } from "./data";
import { todayLakeDate } from "@/lib/booking";
import {
  monthPeriod, quarterPeriod, yearPeriod, customPeriod,
  summariseReceipts, exclusionLines,
  type Receipt, type Period, type ReceiptSummary, type Method, type ChargeLine,
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
  const { data: park } = await admin
    .from("parks")
    .select("name, office_recording_lag_days")
    .eq("id", parkId)
    .maybeSingle();
  const parkName = (park?.name as string) ?? "This park";
  const lagDays = (park?.office_recording_lag_days as number) ?? 0;

  // Charges scope the payments — park_payments has no park_id of its own.
  const { data: charges } = await admin
    .from("park_charges")
    .select("id, park_lot_id, renter_id, period_month, due_on, amount, status, lines")
    .eq("park_id", parkId);

  const chargeIds = (charges ?? []).map((c) => c.id as string);
  if (chargeIds.length === 0) {
    const empty = summariseReceipts([], period);
    return {
      parkName, period, summary: empty, receipts: [],
      notes: exclusionLines({
        recordsBeginOn: null, lagDays, unbilledFeeLabels: [], anyMissingPayerName: false,
      }),
      recordsBeginOn: null, billedInWindowCents: 0,
      today, generatedAt: new Date().toISOString(),
    };
  }

  const [{ data: payments }, { data: lots }, { data: renters }, { data: fees }] = await Promise.all([
    admin
      .from("park_payments")
      .select("id, charge_id, amount, method, reference, received_on")
      .in("charge_id", chargeIds),
    admin.from("park_lots").select("id, lot_number").eq("park_id", parkId),
    admin.from("park_renters").select("id, display_name").eq("park_id", parkId),
    admin.from("park_fees").select("label, active").eq("park_id", parkId).eq("active", true),
  ]);

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
      method: (p.method as Method) ?? "other",
      reference: (p.reference as string) ?? null,
      receivedOn: p.received_on as string,
      lotNumber: lotName.get(c.park_lot_id as string) ?? "?",
      payerName: payer,
      periodMonth: c.period_month as string,
      chargeAmountCents: cents(c.amount),
      chargeStatus: c.status as Receipt["chargeStatus"],
      chargeLines,
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
    notes: exclusionLines({ recordsBeginOn, lagDays, unbilledFeeLabels, anyMissingPayerName }),
    recordsBeginOn,
    billedInWindowCents,
    today,
    generatedAt: new Date().toISOString(),
  };
}
