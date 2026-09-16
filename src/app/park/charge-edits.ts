/**
 * WHAT A TENANCY CHANGE DOES TO THE BILLS ALREADY RAISED.
 *
 * Two doors change a household's dates after a month is billed — the roll's
 * "They signed the new lease" (the holdover is trimmed or cancelled and a
 * successor takes the month) and Move out (the covering link is trimmed to
 * the last day and every later link is withdrawn) — and until now neither
 * looked at `park_charges` at all. A January bill raised on the holdover
 * stood beside a second January bill on the successor ($942.53 for one
 * household); a whole-month bill stood for a household who left on the 27th
 * under a toast promising "their final month bills for the days they were
 * here"; a withdrawn February agreement kept its open February bill and the
 * departed household was chased for it.
 *
 * The primitives those doors needed all existed one import away — the run's
 * own void shape, voidCharge's cost-share release, buildStatement/planRun,
 * settleOnAccount — and no door used them. They live here now, as plain
 * server functions (this is NOT a "use server" module: every export here
 * takes the admin client and is called from inside an action that has
 * already asserted the park), so the two doors read the same rules:
 *
 *   - A bill with money on it is NEVER voided here. 0072 refuses it in the
 *     database; the caller reads `chargeStandings` first and says which
 *     kind of money it is — handed over, or put against it from money on
 *     account — because the way out differs.
 *   - A void carries a reason (0070's constraint) and releases the cost
 *     shares it was carrying (0104), exactly as voidCharge does.
 *   - A month is re-raised through the same buildStatement/planRun path the
 *     run uses, for ONE reservation, and settled from money on account
 *     through the one settlement door (R1) — never a copy of either.
 *
 * Nothing here is one transaction. Each function returns what landed and
 * what did not, and the caller's sentence says it.
 */

import { parseDaterange } from "@/lib/parks";
import type { createServiceClient } from "@/lib/supabase/server";
import { buildStatement, type Statement, type StatementFee } from "./statement-helpers";
import { planRun, dueDayFor, classifyForRun, type RunCandidate, type SkipWhy } from "./ledger-helpers";
import { feesForTenancy } from "./fee-helpers";
import { rentForPeriod, lastDayOfMonth } from "./rerate-helpers";
import { servedRentHistory } from "@/lib/rent-changes";
import { settleOnAccount } from "@/lib/allocations";
import { COST_CATEGORY_LABEL, type CostCategory } from "./cost-helpers";

type Admin = ReturnType<typeof createServiceClient>;

/** A failed READ, named — never rendered as "nothing there". */
export interface ReadProblem { error: unknown; what: string }

// ----------------------------------------------------------- what stands ---

/** One live bill and what money is on it. */
export interface ChargeStanding {
  id: string;
  reservationId: string;
  renterId: string | null;
  /** YYYY-MM. */
  month: string;
  amount: number;
  /** The database's own figure (recompute_charge_paid). */
  paidTotal: number;
  /** Dollars handed over AGAINST this bill by rows that still stand. */
  direct: number;
  /** Money on account put against it, by rows that still stand (0167). */
  allocations: { id: string; paymentId: string; amount: number }[];
  /**
   * How the bill stands:
   *   none        — nothing on it; it can be voided.
   *   on_account  — settled only from money on account; the lines can be
   *                 taken off (unapplyAllocation) and then it can be voided.
   *   direct      — money was taken against it (or paid_total says so and
   *                 no row explains it). Never voided here; the caller says
   *                 the truth instead.
   */
  money: "none" | "on_account" | "direct";
}

/**
 * The live bills on these reservations, from `fromMonth` on, with what money
 * is on each. Read BEFORE any write, so a door can refuse while nothing has
 * changed.
 */
export async function chargeStandings(
  admin: Admin,
  parkId: string,
  reservationIds: readonly string[],
  fromMonth: string | null = null,
): Promise<{ charges: ChargeStanding[] } | ReadProblem> {
  const ids = [...new Set(reservationIds.filter(Boolean))];
  if (ids.length === 0) return { charges: [] };

  let q = admin
    .from("park_charges")
    .select("id, reservation_id, renter_id, period_month, amount, paid_total")
    .eq("park_id", parkId)
    .in("reservation_id", ids)
    .neq("status", "void");
  if (fromMonth) q = q.gte("period_month", fromMonth);
  const chargeRes = await q;
  if (chargeRes.error) return { error: chargeRes.error, what: "the bills already raised for them" };
  const rows = chargeRes.data ?? [];
  if (rows.length === 0) return { charges: [] };
  const chargeIds = rows.map((c) => c.id as string);

  // MONEY HANDED OVER against these bills — rows that still stand. A
  // reversed or bank-returned row is not money on the bill (0167's
  // recompute agrees), and a refund does not un-take the payment: the row
  // stands and so does the fact that money was taken.
  const [directRes, allocRes] = await Promise.all([
    admin
      .from("park_payments")
      .select("id, charge_id, amount")
      .eq("park_id", parkId)
      .in("charge_id", chargeIds)
      .is("reversed_at", null)
      .is("returned_at", null),
    admin
      .from("park_payment_allocations")
      .select("id, payment_id, charge_id, amount")
      .eq("park_id", parkId)
      .in("charge_id", chargeIds)
      .is("removed_at", null),
  ]);
  if (directRes.error) return { error: directRes.error, what: "what's been paid against those bills" };
  if (allocRes.error) return { error: allocRes.error, what: "what's been put against those bills" };

  // An allocation counts only while the payment it came from stands.
  const allocRows = allocRes.data ?? [];
  const standing = new Set<string>();
  if (allocRows.length > 0) {
    const payRes = await admin
      .from("park_payments")
      .select("id, reversed_at, returned_at")
      .in("id", [...new Set(allocRows.map((a) => a.payment_id as string))]);
    if (payRes.error) return { error: payRes.error, what: "the payments behind those bills" };
    for (const p of payRes.data ?? []) {
      if (p.reversed_at == null && p.returned_at == null) standing.add(p.id as string);
    }
  }

  const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
  const charges = rows.map((c) => {
    const id = c.id as string;
    const direct = (directRes.data ?? [])
      .filter((p) => p.charge_id === id)
      .reduce((s, p) => s + cents(p.amount), 0) / 100;
    const allocations = allocRows
      .filter((a) => a.charge_id === id && standing.has(a.payment_id as string))
      .map((a) => ({ id: a.id as string, paymentId: a.payment_id as string, amount: Number(a.amount ?? 0) }));
    const paidTotal = Number(c.paid_total ?? 0);
    const money: ChargeStanding["money"] =
      direct > 0 ? "direct"
      : allocations.length > 0 ? "on_account"
      // paid_total says money is on it and no standing row explains it —
      // the ledger's figure is the one 0072 enforces, so it is not "none".
      : paidTotal > 0 ? "direct"
      : "none";
    return {
      id,
      reservationId: c.reservation_id as string,
      renterId: (c.renter_id as string | null) ?? null,
      month: String(c.period_month ?? ""),
      amount: Number(c.amount ?? 0),
      paidTotal,
      direct,
      allocations,
      money,
    };
  });
  return { charges };
}

// ------------------------------------------------------------- the void ---

export interface VoidOutcome {
  /** Cancelled, with the reason, and their cost shares released. */
  voided: { id: string; reservationId: string; month: string; amount: number }[];
  /** Left standing: money is on them (0072 would refuse the void anyway). */
  skipped: { id: string; reservationId: string; month: string; amount: number; paidTotal: number }[];
  /** The update itself was refused. Said by the caller, never swallowed. */
  failed: { id: string; reservationId: string; month: string; amount: number; message: string }[];
  /** Cost shares released back to "unbilled" by the voids (0104). */
  sharesReleased: number;
}

/**
 * VOID THE UNPAID BILLS on these reservations from `fromMonth` on, with the
 * reason the caller gives — the shape the run's own take-back and voidCharge
 * both write (status, voided_at, void_reason), plus voidCharge's release of
 * the cost shares the bill was carrying, so a share on a cancelled bill does
 * not vanish from every future run.
 *
 * A bill with money on it is SKIPPED, not attempted: the caller has already
 * decided what to say about it. The database would refuse it too (0072).
 */
export async function voidUnpaidChargesFor(
  admin: Admin,
  reservationIds: readonly string[],
  /** YYYY-MM, inclusive; null means every month on those reservations. */
  fromMonth: string | null,
  reason: string,
): Promise<VoidOutcome | ReadProblem> {
  const out: VoidOutcome = { voided: [], skipped: [], failed: [], sharesReleased: 0 };
  const ids = [...new Set(reservationIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const why = reason.trim();
  if (!why) return { error: new Error("a void needs a reason"), what: "why the bill is cancelled" };

  let q = admin
    .from("park_charges")
    .select("id, reservation_id, period_month, amount, paid_total")
    .in("reservation_id", ids)
    .neq("status", "void");
  if (fromMonth) q = q.gte("period_month", fromMonth);
  const res = await q;
  if (res.error) return { error: res.error, what: "the bills already raised for them" };

  for (const c of res.data ?? []) {
    const row = {
      id: c.id as string,
      reservationId: c.reservation_id as string,
      month: String(c.period_month ?? ""),
      amount: Number(c.amount ?? 0),
    };
    const paidTotal = Number(c.paid_total ?? 0);
    if (paidTotal > 0) { out.skipped.push({ ...row, paidTotal }); continue; }

    const { error } = await admin
      .from("park_charges")
      .update({ status: "void", voided_at: new Date().toISOString(), void_reason: why })
      .eq("id", row.id)
      .neq("status", "void");
    if (error) {
      out.failed.push({ ...row, message: String(error.message ?? "") });
      continue;
    }
    out.voided.push(row);

    // RELEASE THE COST SHARES THIS BILL WAS CARRYING (0104) — voidCharge's
    // rule. The bill is cancelled by now, so a failure here cannot refuse;
    // it is logged, and the count below says what came back.
    const released = await admin
      .from("lot_cost_shares")
      .update({ billed_on_charge_id: null })
      .eq("billed_on_charge_id", row.id)
      .select("id");
    if (released.error) {
      console.error("[read failed] the cost shares on that bill:", released.error);
    } else {
      out.sharesReleased += released.data?.length ?? 0;
    }
  }
  return out;
}

// ------------------------------------------------ the run's two readers ---
//
// THE ONE HOME for what the run reads before it builds a statement — the
// park's fees in the audience it honours, and the cost shares not yet
// billed. They lived as private functions in ledger-actions.ts (a "use
// server" module, where exporting a function that takes the admin client
// would make it an endpoint), so statementFor below carried a second copy
// of each; a change to the audience rule or the share label in one would
// have left the sign door and the move-out re-raising a different bill from
// the run's. ledger-actions.ts imports them from here.

// A FAILED FEE READ IS NOT A PARK WITH NO FEES. Swallowed, it drops the
// monthly fees off every bill the run raises — nineteen households under-billed,
// with nothing on any screen to say so. The error travels back to the caller,
// which is an action and can say it in a sentence.
export async function feesFor(
  admin: Admin,
  parkId: string,
): Promise<{ fees: StatementFee[]; error: unknown }> {
  const { data, error } = await admin
    .from("park_fees")
    .select("label, amount, cadence, applies_to, active")
    .eq("park_id", parkId)
    .eq("active", true);
  if (error) return { fees: [], error };
  return {
    fees: (data ?? [])
      .filter((f) => ["all_lots", "long_term"].includes(f.applies_to as string))
      .map((f) => ({
        label: f.label as string,
        amount: Number(f.amount),
        cadence: f.cadence as string,
      })),
    error: null,
  };
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
export async function unbilledCostShares(
  admin: Admin,
  parkId: string,
  reservationIds: string[],
): Promise<{
  shares: Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>;
  error: unknown;
}> {
  const out = new Map<string, Array<{ id: string; label: string; amount: number; basis: string }>>();
  if (reservationIds.length === 0) return { shares: out, error: null };

  // A FAILED READ HERE IS NOT "NOTHING TO SPLIT". Swallowed, the water the
  // owner has already paid for silently misses this month's bills — the exact
  // failure this reader was written to end. Both reads report back instead.
  const sharesRes = await admin
    .from("lot_cost_shares")
    .select("id, cost_id, reservation_id, amount, basis")
    .in("reservation_id", reservationIds)
    .is("billed_on_charge_id", null);
  if (sharesRes.error) return { shares: out, error: sharesRes.error };
  const shares = sharesRes.data;
  if (!shares?.length) return { shares: out, error: null };

  const costIds = [...new Set(shares.map((s) => s.cost_id as string))];
  const costsRes = await admin
    .from("park_costs")
    .select("id, park_id, category, period_start, period_end")
    .in("id", costIds)
    .eq("park_id", parkId);          // never bill another park's water
  if (costsRes.error) return { shares: out, error: costsRes.error };
  const costById = new Map((costsRes.data ?? []).map((c) => [c.id as string, c]));

  for (const sh of shares) {
    const cost = costById.get(sh.cost_id as string);
    if (!cost) continue;             // a cost from elsewhere, or since removed
    // THE SAME WORDS THE OWNER SEES, from the one label map.
    //
    // This built the label by de-underscoring the raw enum, so a resident's
    // bill read "grounds — your share" while the costs screen called it
    // "Grounds & mowing", and "unit electric — your share" — which means
    // nothing to anybody — against "Electric on a home you own". A bill line
    // is the most-read sentence in the whole product and it was the only one
    // written by a regex.
    const cat = String(cost.category ?? "other") as CostCategory;
    const label = `${COST_CATEGORY_LABEL[cat] ?? "Cost"} — your share`;
    const list = out.get(sh.reservation_id as string) ?? [];
    list.push({
      id: sh.id as string,
      label,
      amount: Number(sh.amount ?? 0),
      basis: cost.period_start && cost.period_end
        ? `for ${cost.period_start} to ${cost.period_end}`
        : "as allocated",
    });
    out.set(sh.reservation_id as string, list);
  }
  return { shares: out, error: null };
}

// ------------------------------------------------------- the statement ---

/** Everything the run would know about one tenancy for one month. */
export interface MonthStatement {
  candidate: RunCandidate;
  statement: Statement | null;
  stay: {
    id: string; parkLotId: string; renterId: string | null; status: string;
    during: string; movedOutOn: string | null; origin: string | null; term: string | null;
  };
  lotNumber: string;
  shareIds: string[];
}

/**
 * WHAT ONE TENANCY BILLS FOR ONE MONTH, by the run's own arithmetic: the
 * rate in force that month (servedRentHistory → rentForPeriod), the fees the
 * biller's rule hands this tenancy (feesFor → feesForTenancy), its own due
 * day (dueDayFor), and the cost shares not yet billed (unbilledCostShares,
 * 0104). The same readers the run calls, narrowed to one reservation —
 * never a copy of buildStatement, and no longer a copy of the assembly
 * around it either.
 */
export async function statementFor(
  admin: Admin,
  parkId: string,
  reservationId: string,
  month: string,
): Promise<MonthStatement | ReadProblem> {
  const stayRes = await admin
    .from("lot_reservations")
    .select("id, park_lot_id, renter_id, during, quoted_amount, status, moved_out_on, due_day, origin, term")
    .eq("id", reservationId)
    .maybeSingle();
  if (stayRes.error) return { error: stayRes.error, what: "that tenancy" };
  const s = stayRes.data;
  if (!s) return { error: new Error("no such reservation"), what: "that tenancy" };

  const [lotRes, parkRes, feeRes, histRes, shareRes] = await Promise.all([
    admin.from("park_lots").select("id, lot_number, rental_mode, park_id").eq("id", s.park_lot_id as string).maybeSingle(),
    admin.from("parks").select("rent_due_day").eq("id", parkId).maybeSingle(),
    feesFor(admin, parkId),
    servedRentHistory([reservationId]),
    unbilledCostShares(admin, parkId, [reservationId]),
  ]);
  if (lotRes.error) return { error: lotRes.error, what: "that lot" };
  if (parkRes.error) return { error: parkRes.error, what: "your park's billing settings" };
  if (feeRes.error) return { error: feeRes.error, what: "your park's fees" };
  if (histRes.error) return { error: histRes.error, what: "the rent history for that lot" };
  if (shareRes.error) return { error: shareRes.error, what: "the costs you've split" };
  const lot = lotRes.data;
  if (!lot || lot.park_id !== parkId) return { error: new Error("lot is not in this park"), what: "that lot" };

  const costShares = shareRes.shares.get(reservationId) ?? [];

  const range = parseDaterange(s.during as string);
  const dueDay = (parkRes.data?.rent_due_day as number) ?? 1;
  const statement = range
    ? buildStatement({
        month,
        stay: range,
        rent: rentForPeriod(
          histRes.byRes.get(reservationId) ?? [],
          lastDayOfMonth(month),
          s.quoted_amount == null ? null : Number(s.quoted_amount),
        ),
        fees: feesForTenancy(feeRes.fees, lot, s),
        dueDay: dueDayFor(s.due_day, dueDay),
        costShares,
      })
    : null;

  return {
    candidate: {
      reservationId,
      lotNumber: (lot.lot_number as string) ?? "?",
      amount: statement == null ? null : statement.total,
      range,
      term: (s.term as string | null) ?? null,
      status: (s.status as string | null) ?? null,
    },
    statement,
    stay: {
      id: reservationId,
      parkLotId: s.park_lot_id as string,
      renterId: (s.renter_id as string | null) ?? null,
      status: s.status as string,
      during: s.during as string,
      movedOutOn: (s.moved_out_on as string | null) ?? null,
      origin: (s.origin as string | null) ?? null,
      term: (s.term as string | null) ?? null,
    },
    lotNumber: (lot.lot_number as string) ?? "?",
    shareIds: costShares.map((c) => c.id),
  };
}

/** "27 of 31 days" — the basis the statement's lines carry, or "for the month". */
export function basisOf(st: Statement | null): string {
  return st?.lines[0]?.basis ?? (st?.prorated ? `${st.daysBilled} of ${st.daysInMonth} days` : "for the month");
}

// ---------------------------------------------------------- the re-raise ---

export interface ReraiseOutcome {
  /** The bill that landed, or null with `why` when the run would not have raised one. */
  raised: { id: string; month: string; amount: number; dueOn: string; basis: string } | null;
  why: SkipWhy | null;
  /** Dollars of the household's money on account put against it the moment it landed (R1). */
  fromOnAccount: number;
  /** A settlement read or row that failed — the bill stands, the money stays on account. */
  settleProblem: string | null;
  /**
   * Cost shares stamped onto the new bill (0104). A void releases the
   * shares its bill carried; a caller that voided and then could not
   * re-raise on the same tenancy compares this with `sharesReleased` and
   * says what is stranded — a share keyed to a cancelled or trimmed-off
   * tenancy never reaches a bill again, silently.
   */
  sharesStamped: number;
}

/**
 * RE-RAISE ONE MONTH FOR ONE TENANCY, the way the run would: the same
 * statement, the same classification (classifyForRun via planRun — a
 * cancelled row, a window that no longer covers the month, a rent nobody
 * set, all refuse here for the same reasons), the same row shape, the same
 * share stamp, and the same settlement from money on account. An existing
 * live bill for the month means nothing is raised — the caller voids first.
 *
 * An `ended` row is billed only when it carries a move-out date (0101's
 * rule in the run: an ended row with no date was closed by the old one-click
 * path and its range was never trimmed).
 */
export async function reraiseMonth(
  admin: Admin,
  parkId: string,
  reservationId: string,
  month: string,
): Promise<ReraiseOutcome | ReadProblem> {
  const ms = await statementFor(admin, parkId, reservationId, month);
  if ("error" in ms) return ms;

  // The run's own set: approved, active, or ended with a move-out date.
  const billableStatus =
    ms.stay.status === "approved" || ms.stay.status === "active" ||
    (ms.stay.status === "ended" && ms.stay.movedOutOn != null);
  if (!billableStatus) {
    return { raised: null, why: ms.stay.status === "ended" ? "movedOut" : "expired", fromOnAccount: 0, settleProblem: null, sharesStamped: 0 };
  }

  const existingRes = await admin
    .from("park_charges")
    .select("id")
    .eq("reservation_id", reservationId)
    .eq("period_month", month)
    .neq("status", "void");
  if (existingRes.error) return { error: existingRes.error, what: "the bills already raised for that month" };
  const already = new Set((existingRes.data ?? []).map(() => reservationId));

  const plan = planRun([ms.candidate], already, month);
  if (plan.toBill.length === 0) {
    const why = classifyForRun(ms.candidate, month, already);
    return { raised: null, why: why === "bill" ? "noRent" : why, fromOnAccount: 0, settleProblem: null, sharesStamped: 0 };
  }
  const st = ms.statement!;

  const { data: raised, error } = await admin
    .from("park_charges")
    .insert([{
      park_id: parkId,
      park_lot_id: ms.stay.parkLotId,
      reservation_id: reservationId,
      renter_id: ms.stay.renterId,
      period_month: month,
      due_on: st.dueOn,
      lines: st.lines,
      amount: plan.toBill[0].amount,
    }])
    .select("id, reservation_id");
  if (error) return { error, what: "the bill for that month" };
  const chargeId = (raised?.[0]?.id as string) ?? "";

  // STAMP THE SHARES (0104) — the run's invariant: a charge exists only if
  // its shares are stamped. A failed stamp takes the bill back, as the run
  // does, so the water is not billed twice next month.
  if (ms.shareIds.length > 0 && chargeId) {
    const { error: stampErr } = await admin
      .from("lot_cost_shares")
      .update({ billed_on_charge_id: chargeId })
      .in("id", ms.shareIds)
      .is("billed_on_charge_id", null);
    if (stampErr) {
      console.error(`[reraiseMonth] couldn't stamp ${ms.shareIds.length} cost share(s) onto charge ${chargeId}:`, stampErr);
      const { error: voidErr } = await admin
        .from("park_charges")
        .update({
          status: "void",
          voided_at: new Date().toISOString(),
          void_reason:
            "Taken back automatically: the allocated costs on this bill could not be marked as spent, " +
            "and leaving it would have billed those costs again next month.",
        })
        .eq("id", chargeId);
      if (voidErr) console.error(`[reraiseMonth] and couldn't void charge ${chargeId} either:`, voidErr);
      return { error: stampErr, what: "the costs you've split, so the bill was taken back" };
    }
  }

  // MONEY ON ACCOUNT COMES OFF THE BILL THE MOMENT IT EXISTS (0167, R1),
  // through the one door — oldest open bill first, which may be an older
  // month than this one.
  let fromOnAccount = 0;
  let settleProblem: string | null = null;
  if (ms.stay.renterId) {
    const settled = await settleOnAccount(admin, parkId, [ms.stay.renterId], "office", null);
    if ("error" in settled) {
      console.error(`[reraiseMonth] couldn't read ${settled.what}:`, settled.error);
      settleProblem = `we couldn't read ${settled.what}, so no money on account was put against it — apply it from "Money not against a bill"`;
    } else {
      fromOnAccount = settled.applied.get(chargeId) ?? 0;
      if (settled.failed.some((f) => f.key === chargeId)) {
        settleProblem = "money on account couldn't be put against it — the bill stands and the money stays on account";
      }
    }
  }

  return {
    raised: { id: chargeId, month, amount: plan.toBill[0].amount, dueOn: st.dueOn, basis: basisOf(st) },
    why: null,
    fromOnAccount,
    settleProblem,
    sharesStamped: chargeId ? ms.shareIds.length : 0,
  };
}

/**
 * "2 cost shares that were on that bill are back on the arrangement they
 * had and won't bill from there — remove that bill on the costs screen and
 * split it again." — for shares a void released that no re-raise took up.
 * Nothing when none are stranded, so a caller can print nothing.
 */
export function strandedSharesSentence(released: number, stamped: number, where: string): string {
  const n = released - stamped;
  if (n <= 0) return "";
  return (
    `${n} cost ${n === 1 ? "share" : "shares"} that ${n === 1 ? "was" : "were"} on that bill ${n === 1 ? "is" : "are"} back on ${where} ` +
    `and won't bill from there — remove that bill on the costs screen and split it again.`
  );
}
