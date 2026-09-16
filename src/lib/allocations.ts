/**
 * WHICH DOLLARS PAY WHICH BILL — the pure half of 0167.
 *
 * Money on account (a cheque taken before its bill existed, a quarter paid
 * ahead, the excess over a bill, or money released from a cancelled bill —
 * 0169: a payment against a bill with status void is on account, derived;
 * the view lists it and nothing here needs to know) is put against bills as
 * `park_payment_allocations` rows. The database owns every conservation rule — what is left
 * on a payment, what is left on a bill, whose money it is — and refuses by
 * name. This file owns the two things that are not rules but ARITHMETIC a
 * screen has to show before anything is written:
 *
 *   planAllocations — given the bills a run is about to raise and the money
 *   each household has on account, which payment goes against which bill, for
 *   how much, oldest money first. The preview and the run call the SAME
 *   function, so the number the owner approves ("$1,085.06 of it already on
 *   account") is the number the run then applies.
 *
 *   describeAllocations — the one sentence every receipt, page and signal
 *   uses for where a payment's money went: "$542.53 to January 2027, $542.53
 *   to February 2027, $542.53 on account".
 *
 *   settleOnAccount — the ONE door through which money on account reaches a
 *   bill on its own. Both orderings of the owner's "applied to the months if
 *   there is a prepay": money recorded on account settles the household's
 *   OLDEST open bills the moment it is recorded, and a bill raised for a
 *   household with money on account is settled the moment it is raised. The
 *   run, recordOnAccount, recordPayment (and so confirmClaimCollected) all
 *   call this, so none of them can define "on account" or "oldest" its own
 *   way, and the preview plans with the same pure function it writes from.
 *
 * Integer cents throughout, divided once at the edge. Three months of $542.53
 * summed as floats is not $1,627.59.
 */

import { prettyMonth, money, billWords } from "@/app/park/ledger-helpers";
import type { createServiceClient } from "@/lib/supabase/server";

// The one money formatter, re-exported so a caller that already imports the
// allocation helpers need not reach into ledger-helpers for it.
export { money };

/** One payment on account, as `park_on_account_payments` reports it. */
export interface OnAccountSource {
  paymentId: string;
  renterId: string | null;
  /** Dollars still unapplied — the view's `remaining`, never `amount`. */
  remaining: number;
  /** The day the money arrived. Oldest first, always. */
  receivedOn: string;
  /** Tie-break for two cheques on one day. */
  createdAt?: string | null;
}

/** A bill that still owes something, keyed however the caller likes. */
export interface BillOwing {
  key: string;
  renterId: string | null;
  /** Dollars still owed on it. */
  owing: number;
  /** YYYY-MM of the bill — the sentence names it, and oldest-first sorts on it. */
  periodMonth?: string;
  /** Tie-break inside a month: the due date, then whatever the caller likes. */
  dueOn?: string;
}

export interface PlannedAllocation {
  key: string;
  paymentId: string;
  /** Dollars. */
  amount: number;
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;

/**
 * OLDEST MONEY FIRST, until the bill is settled or the household's money is
 * gone. A bill with no household, or a household with nothing on account,
 * gets nothing — the run raises it exactly as before.
 *
 * Each source is drawn down as it is used, so two bills for one household in
 * the same run (a final part-month and a renewal, say) share the pool rather
 * than each being offered the whole of it.
 */
export function planAllocations(
  bills: readonly BillOwing[],
  sources: readonly OnAccountSource[],
): PlannedAllocation[] {
  const pools = new Map<string, Array<{ paymentId: string; left: number }>>();
  const ordered = [...sources]
    .filter((s) => s.renterId && cents(s.remaining) > 0)
    .sort(
      (a, b) =>
        a.receivedOn.localeCompare(b.receivedOn) ||
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        a.paymentId.localeCompare(b.paymentId),
    );
  for (const s of ordered) {
    const list = pools.get(s.renterId as string) ?? [];
    list.push({ paymentId: s.paymentId, left: cents(s.remaining) });
    pools.set(s.renterId as string, list);
  }

  const out: PlannedAllocation[] = [];
  for (const b of bills) {
    if (!b.renterId) continue;
    let owing = cents(b.owing);
    if (owing <= 0) continue;
    for (const src of pools.get(b.renterId) ?? []) {
      if (owing <= 0) break;
      if (src.left <= 0) continue;
      const take = Math.min(owing, src.left);
      out.push({ key: b.key, paymentId: src.paymentId, amount: dollars(take) });
      src.left -= take;
      owing -= take;
    }
  }
  return out;
}

/**
 * WHICH OF THE APPLIED DOLLARS ARE THE NEW BILLS' AND WHICH ARE OLDER BILLS'
 * — one partition for the preview and the run, so the two cannot disagree
 * about what "older" means. `applied` is dollars by bill key (the run keys
 * on charge ids; the preview keys a bill it is about to raise on its
 * reservation id and an older one on its charge id); `newKeys` are the bills
 * being raised; `monthOf` names an older bill's month for the sentence.
 *
 * NOT `total − fromOnAccount`: a second copy of a subtraction is the shape
 * this codebase keeps finding as a bug. Each dollar is sorted once.
 */
export function splitApplied(
  applied: ReadonlyMap<string, number>,
  newKeys: ReadonlySet<string>,
  monthOf: (key: string) => string | undefined,
): { fromOnAccount: number; toOlderBills: { key: string; periodMonth: string; amount: number }[] } {
  let fromOnAccount = 0;
  const toOlderBills: { key: string; periodMonth: string; amount: number }[] = [];
  for (const [key, amount] of applied) {
    if (cents(amount) <= 0) continue;
    if (newKeys.has(key)) fromOnAccount += cents(amount);
    else toOlderBills.push({ key, periodMonth: monthOf(key) ?? "", amount });
  }
  toOlderBills.sort((a, b) => a.periodMonth.localeCompare(b.periodMonth) || a.key.localeCompare(b.key));
  return { fromOnAccount: dollars(fromOnAccount), toOlderBills };
}

/** Dollars planned per bill key, and the total — for a preview's sentence. */
export function plannedByKey(plan: readonly PlannedAllocation[]): { byKey: Map<string, number>; total: number } {
  const byKey = new Map<string, number>();
  let total = 0;
  for (const a of plan) {
    const c = cents(a.amount);
    byKey.set(a.key, (byKey.get(a.key) ?? 0) + c);
    total += c;
  }
  return {
    byKey: new Map([...byKey].map(([k, c]) => [k, dollars(c)])),
    total: dollars(total),
  };
}

/**
 * OLDEST BILL FIRST. The owner's "applied to the months if there is a
 * prepay" read both ways (R1): a household in arrears for January with a
 * cheque on account has January settled before February is touched — the
 * run must never settle the bill it is raising while an older one reads
 * late and is the one chased. Pure, so the preview and every door sort the
 * same way: period month, then due date, then key, so two bills for one
 * month (a final part-month and a renewal) are stable.
 */
export function oldestFirst<T extends BillOwing>(bills: readonly T[]): T[] {
  return [...bills].sort(
    (a, b) =>
      String(a.periodMonth ?? "").localeCompare(String(b.periodMonth ?? "")) ||
      String(a.dueOn ?? "").localeCompare(String(b.dueOn ?? "")) ||
      a.key.localeCompare(b.key),
  );
}

/** planAllocations over the bills in oldest-first order — the one plan every door writes from. */
export function planSettlement(
  bills: readonly BillOwing[],
  sources: readonly OnAccountSource[],
): PlannedAllocation[] {
  return planAllocations(oldestFirst(bills), sources);
}

// ----------------------------------------------------------- the DB door ---

type Admin = ReturnType<typeof createServiceClient>;

/**
 * MONEY ON ACCOUNT, per household, as the database counts it (0167).
 *
 * `park_on_account_payments.remaining` is what has not yet been put against
 * a bill or sent back — never `amount`. Oldest first, so a quarter paid ahead
 * in December is spent before a cheque taken in February. One reader for the
 * preview, the run and every payment door, so none of them can define "on
 * account" its own way — and MEMBERSHIP IN THE VIEW is that definition:
 * money released from a cancelled bill (0169 — a payment against a bill
 * with status void, the row never moved) joins the sources by itself,
 * oldest first like any other, with no test of its own here.
 *
 * A FAILED READ IS NOT "NOTHING ON ACCOUNT". The preview would then promise
 * the owner the full figure is owed, the run would raise the bills and apply
 * nothing, and Lot 7 — whose quarter is in the drawer — would be chased.
 */
export async function onAccountSources(
  admin: Admin,
  parkId: string,
  renterIds: readonly string[],
): Promise<{ sources: OnAccountSource[]; error: unknown }> {
  const ids = [...new Set(renterIds.filter(Boolean))];
  if (ids.length === 0) return { sources: [], error: null };
  const { data, error } = await admin
    .from("park_on_account_payments")
    .select("payment_id, renter_id, remaining, received_on, created_at")
    .eq("park_id", parkId)
    .in("renter_id", ids)
    .gt("remaining", 0)
    .order("received_on", { ascending: true });
  if (error) return { sources: [], error };
  return {
    sources: (data ?? []).map((r) => ({
      paymentId: r.payment_id as string,
      renterId: (r.renter_id as string) ?? null,
      remaining: Number(r.remaining ?? 0),
      receivedOn: (r.received_on as string) ?? "",
      createdAt: (r.created_at as string) ?? null,
    })),
    error: null,
  };
}

/**
 * WHAT THE PARK IS STILL HOLDING OF ONE HOUSEHOLD'S — money on account
 * (the view's `remaining`, summed) and deposits not yet given back. The
 * hand-back door reads it after the stamp so its sentence names what else
 * of theirs is still held (a second cheque, the deposit); the close-out
 * door wants the same figure after a move-out, and the held panel and Today
 * read the same view for the same money.
 *
 * A FAILED READ IS NOT "NOTHING HELD". `{ error }` travels back so the
 * caller says it could not check, never "closed out" over a cheque it did
 * not look for.
 */
export async function heldOnAccountFor(
  admin: Admin,
  parkId: string,
  renterId: string,
): Promise<{ remaining: number; depositsHeld: number; error: null } | { remaining: 0; depositsHeld: 0; error: unknown }> {
  const [acctRes, depRes] = await Promise.all([
    admin.from("park_on_account_payments").select("remaining")
      .eq("park_id", parkId).eq("renter_id", renterId).gt("remaining", 0),
    admin.from("park_payments").select("amount")
      .eq("park_id", parkId).eq("renter_id", renterId).eq("kind", "deposit")
      .is("reversed_at", null).is("returned_at", null).is("returned_on", null),
  ]);
  if (acctRes.error) return { remaining: 0, depositsHeld: 0, error: acctRes.error };
  if (depRes.error) return { remaining: 0, depositsHeld: 0, error: depRes.error };
  return {
    remaining: dollars((acctRes.data ?? []).reduce((s, r) => s + cents(Number(r.remaining ?? 0)), 0)),
    depositsHeld: dollars((depRes.data ?? []).reduce((s, r) => s + cents(Number(r.amount ?? 0)), 0)),
    error: null,
  };
}

/** A bill still owing, as `openBillsFor` reads it: keyed on the charge id. */
export interface OpenBill extends BillOwing {
  periodMonth: string;
  dueOn: string;
}

/**
 * THE HOUSEHOLD'S OPEN BILLS, with what each still owes — `amount −
 * paid_total`, the database's own figure (recompute_charge_paid keeps it),
 * never re-derived from payments here. Open only: a cancelled bill takes
 * nothing (the guard refuses it too) and a paid one owes nothing.
 */
export async function openBillsFor(
  admin: Admin,
  parkId: string,
  renterIds: readonly string[],
): Promise<{ bills: OpenBill[]; error: unknown }> {
  const ids = [...new Set(renterIds.filter(Boolean))];
  if (ids.length === 0) return { bills: [], error: null };
  const { data, error } = await admin
    .from("park_charges")
    .select("id, renter_id, period_month, due_on, amount, paid_total, status")
    .eq("park_id", parkId)
    .in("renter_id", ids)
    .eq("status", "open");
  if (error) return { bills: [], error };
  return {
    bills: (data ?? []).map((c) => ({
      key: c.id as string,
      renterId: (c.renter_id as string) ?? null,
      owing: Math.max(0, Math.round((Number(c.amount ?? 0) - Number(c.paid_total ?? 0)) * 100)) / 100,
      periodMonth: String(c.period_month ?? ""),
      dueOn: String(c.due_on ?? ""),
    })),
    error: null,
  };
}

/**
 * WRITE THE ALLOCATIONS A PLAN CALLS FOR, one row each, and say which failed.
 *
 * Each insert runs 0167's guard, which re-checks what is left on the payment
 * and on the bill under a row lock — so a plan built a moment ago against a
 * bill somebody just paid at the window is refused for that bill, not
 * silently applied twice. A refusal is named in the caller's sentence; the
 * bill stands and the money stays on account.
 */
export async function writeAllocations(
  admin: Admin,
  parkId: string,
  plan: ReadonlyArray<PlannedAllocation>,
  via: "run" | "office",
  appliedBy: string | null,
): Promise<{
  applied: Map<string, number>;
  /** The rows that landed, as planned — which payment paid which bill. */
  lines: PlannedAllocation[];
  failed: Array<{ key: string; amount: number; why: string }>;
}> {
  const applied = new Map<string, number>();
  const lines: PlannedAllocation[] = [];
  const failed: Array<{ key: string; amount: number; why: string }> = [];
  for (const a of plan) {
    const { error } = await admin.from("park_payment_allocations").insert({
      park_id: parkId,
      payment_id: a.paymentId,
      charge_id: a.key,
      amount: a.amount,
      applied_via: via,
      applied_by: appliedBy,
    });
    if (error) {
      console.error(`[allocations] couldn't put ${money(a.amount)} of ${a.paymentId} against ${a.key}:`, error);
      failed.push({ key: a.key, amount: a.amount, why: String(error.message ?? "") });
      continue;
    }
    applied.set(a.key, dollars(cents(applied.get(a.key) ?? 0) + cents(a.amount)));
    lines.push(a);
  }
  return { applied, lines, failed };
}

export interface Settlement {
  /** Dollars applied, by charge id. Only bills something landed on. */
  applied: Map<string, number>;
  /** Each row that landed: which payment paid which bill, how much. */
  lines: PlannedAllocation[];
  /** The open bills that were read, oldest first — so a caller can name months. */
  bills: OpenBill[];
  /** What was planned but refused by the database, by charge id. */
  failed: Array<{ key: string; amount: number; why: string }>;
  /** Dollars applied in total. */
  total: number;
}

/**
 * SETTLE A HOUSEHOLD'S OLDEST OPEN BILLS FROM ITS MONEY ON ACCOUNT — the one
 * door (R1). Reads what is on account (oldest money first) and what is open
 * (oldest bill first), plans with the same pure function the preview uses,
 * writes one allocation row per (payment, bill) until either side is
 * exhausted. Nothing is refused here: the caller has already recorded the
 * money or raised the bill, so a failed read or a refused row goes in its
 * sentence, and the office can apply by hand from "Money not against a bill".
 *
 * `{ error }` is a failed READ — nothing was written and the caller must say
 * so rather than render it as "nothing on account".
 */
export async function settleOnAccount(
  admin: Admin,
  parkId: string,
  renterIds: readonly string[],
  via: "run" | "office",
  appliedBy: string | null,
): Promise<Settlement | { error: unknown; what: string }> {
  const srcRes = await onAccountSources(admin, parkId, renterIds);
  if (srcRes.error) return { error: srcRes.error, what: "the money households have on account" };
  if (srcRes.sources.length === 0) return { applied: new Map(), lines: [], bills: [], failed: [], total: 0 };
  const billRes = await openBillsFor(admin, parkId, renterIds);
  if (billRes.error) return { error: billRes.error, what: "the bills still open" };
  // The ORDER lives in planSettlement alone — one copy of "oldest first".
  const bills = billRes.bills;
  const planned = planSettlement(bills, srcRes.sources);
  if (planned.length === 0) return { applied: new Map(), lines: [], bills, failed: [], total: 0 };
  const done = await writeAllocations(admin, parkId, planned, via, appliedBy);
  return {
    applied: done.applied,
    lines: done.lines,
    bills,
    failed: done.failed,
    total: dollars([...done.applied.values()].reduce((s, n) => s + cents(n), 0)),
  };
}

/**
 * "$57.47 went against December 2026 and $542.53 against January 2027" —
 * what a settlement did, for a toast. Months in order; nothing when nothing
 * landed, so a caller can print nothing rather than "went against". `keep`
 * narrows it — to one payment's lines, or to every bill but one — so a
 * sentence about the excess just recorded never counts an older cheque's.
 */
export function describeSettlement(
  s: Pick<Settlement, "lines" | "bills">,
  keep: (line: PlannedAllocation) => boolean = () => true,
): string {
  const monthOf = new Map(s.bills.map((b) => [b.key, b.periodMonth]));
  const byMonth = new Map<string, number>();
  for (const l of s.lines) {
    if (!keep(l) || cents(l.amount) <= 0) continue;
    const m = monthOf.get(l.key) ?? "";
    byMonth.set(m, (byMonth.get(m) ?? 0) + cents(l.amount));
  }
  const parts = [...byMonth]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, c], i) => `${money(dollars(c))}${i === 0 ? " went" : ""} against ${prettyMonth(m)}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// -------------------------------------------------------- the sentences ---

/** One allocation as a receipt or page prints it. */
export interface AllocationLine {
  /** YYYY-MM of the bill it went against. */
  periodMonth: string;
  amount: number;
  /**
   * THE BILL RAISED AGAIN FOR THAT MONTH (0169). A move-out cancels the
   * whole-month bill and raises the month again for the days they were
   * here — same reservation, same period_month (0081's unique allows the
   * two while one is void) — so "$472.53 to January 2027" read right after
   * "their January 2027 bill was cancelled" is two different January bills
   * in one word, and the office cannot tell which. Set by a loader ONLY on
   * the colliding line — an allocation whose month equals the month of the
   * cancelled bill the money was released from — and printed only when set,
   * so every ordinary line keeps its shape. `basis` is the re-raised bill's
   * own frozen basis ("27 of 31 days"); null when the re-raise was a whole
   * month (a new rent) or the bill carries no snapshot.
   */
  raisedAgain?: { basis: string | null };
  /**
   * The re-raised bill's own amount, when the loader read it — printed
   * before "bill raised again" (billWords) so "$472.53 to the $472.53 bill
   * raised again for January 2027 (27 of 31 days)" names the part month as
   * a bill of its own. Set beside `raisedAgain` only; an ordinary line
   * never carries it.
   */
  billAmount?: number | null;
}

/**
 * "27 of 31 days" off a bill's frozen lines (park_charges.lines[].basis —
 * the same field charge-edits' basisOf reads off a statement), or null for
 * a whole-month bill or one with no snapshot. The days basis is the only
 * one worth printing: "raised again for January 2027 (for the month)" says
 * nothing a person needs.
 */
export function proratedBasisOf(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  const basis = String((lines[0] as { basis?: unknown } | undefined)?.basis ?? "").trim();
  return basis && basis !== "for the month" ? basis : null;
}

/**
 * The line with the re-raise marked when its month is the cancelled bill's
 * — the one place that decides which line collides, so a loader passes the
 * released-from month and the re-raised bill's lines and never compares
 * months itself.
 */
export function withRaisedAgain(
  line: AllocationLine,
  releasedFromMonth: string | null | undefined,
  billLines: unknown,
): AllocationLine {
  if (!releasedFromMonth || line.periodMonth !== releasedFromMonth) return line;
  return { ...line, raisedAgain: { basis: proratedBasisOf(billLines) } };
}

/**
 * "$472.53 to January 2027" — or, for the colliding line, "$472.53 to the
 * bill raised again for January 2027 (27 of 31 days)". One copy: the
 * receipt, the statement's note and screen all print a line through this,
 * and the reversal's sentence names the bill through the same `billWords`.
 */
export function allocationWords(l: AllocationLine): string {
  return `${money(l.amount)} to ${billWords(l)}`;
}

/**
 * "$542.53 to January 2027, $542.53 to February 2027, $542.53 on account".
 *
 * Bills in month order; what is still unapplied last, and only when there is
 * any. Nothing applied and nothing left reads as an empty string, so a caller
 * can print nothing rather than "on account" about money that has all gone
 * back.
 */
export function describeAllocations(lines: readonly AllocationLine[], remaining: number): string {
  const parts = [...lines]
    .filter((l) => cents(l.amount) > 0)
    .sort((a, b) => a.periodMonth.localeCompare(b.periodMonth))
    .map(allocationWords);
  if (cents(remaining) > 0) parts.push(`${money(remaining)} on account`);
  return parts.join(", ");
}

/** Sum of the lines, in dollars, exact to the cent. */
export function allocatedTotal(lines: readonly AllocationLine[]): number {
  return dollars(lines.reduce((s, l) => s + cents(l.amount), 0));
}
