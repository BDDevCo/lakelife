import { describe, it, expect, vi } from "vitest";
import { receiptBody, receiptRef } from "./receipt-helpers";
import { runSummary, summarise, ledgerHeadline, money } from "./ledger-helpers";
import { amountNote } from "@/components/take-payment-helpers";

/**
 * ============================================================================
 * THE HAVEN, JANUARY 2027 — THE WHOLE MONTH, THROUGH THE DOORS, WITH TEETH.
 * ============================================================================
 *
 * This month was rehearsed twice before it was ever a test: once against the
 * real schema in a rolled-back block on production, once through the product's
 * own server actions. The second rehearsal printed about two hundred sentences
 * the office would read and wrote them to a file. Then somebody ran
 * `grep -c "expect(" ` over it and got ONE — `expect(true).toBe(true)`. Every
 * figure reached the report through a string array, seven internal FLAG()
 * conditions wrote "### DISAGREEMENT:" into a transcript nothing read, and the
 * whole thing could not fail. A rehearsal that cannot fail is a document, not
 * a test.
 *
 * This is the same walk with assertions on it. Same doors, same order, same
 * month:
 *
 *   1 Jan   eighteen households sign the new lease
 *   1 Jan   January is billed — eighteen bills
 *   3 Jan   money at the bill window, twice: exact, and over
 *   5 Jan   money at the OTHER window — on account, no bill named
 *   8 Jan   a cheque bounces
 *   9 Jan   a bill is cancelled and its money released onto account
 *  27 Jan   a household moves out, and $70.00 goes back across the counter
 *  31 Jan   the rent roll and the morning screen at month end
 *   1 Feb   a renewal, fifteen lapsed agreements, and February's run
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THIS FILE HOLDS ITSELF TO
 * ---------------------------------------------------------------------------
 *
 * NOTHING IS ASSERTED AGAINST A VALUE THIS FILE COMPUTED FROM THE EXPRESSION
 * UNDER TEST. `$9,765.54` is written out as a literal. It is true only if the
 * seeded rate card ($400.00, `lot_rates`) and the seeded fee ($142.53,
 * `park_fees`) reach eighteen bills through the real biller. Nowhere does this
 * file multiply eighteen by anything and compare the product to itself.
 *
 * EVERY SCHEMA REFUSAL THE FAKE MODELS IS A REFUSAL THE REAL DATABASE MAKES,
 * and each is named with the migration that defines it — see the block above
 * `class Q`. The fake is the one the ledger and lifecycle suites already ship
 * (ledger-actions.test.ts's, which is the fuller of the two), extended with
 * the tables this walk opens and a clock that moves. There is exactly ONE fake
 * in this file and it is that one; nothing here is a copy of the code under
 * test.
 */

// ---------------------------------------------------------------------------
// THE FAKE
// ---------------------------------------------------------------------------
//
// WHAT IT MODELS, AND WHERE EACH RULE COMES FROM. Every one of these was read
// out of the migration named beside it before it was written here; a fake that
// refuses something production allows makes a green test about nothing.
//
//   assign_receipt_no (0076 § 1, rewritten by 0102 § 3) — max(receipt_no) + 1
//     per PARK, not per charge, and skipped when the row arrives with one.
//   recompute_charge_paid / park_charge_paid_total (0169 § 1, over 0142's
//     net-of-refunds body) — a bill's paid_total is its standing direct
//     payments plus its live allocations, and a VOID bill holds 0.
//   guard_park_charge_void (0169 § 2) — a void is refused BY NAME while a
//     live allocation from a standing payment is on the bill, and the write
//     that voids is the write that zeroes paid_total.
//   park_payment_remaining (0168 § 2) — amount less live allocations, less
//     refunds, less what was handed back.
//   park_on_account_payments (0169 § 3) — kind 'rent', standing, and either
//     no bill or a bill since cancelled; renter_id falls back to the bill's.
//   guard_park_payment_allocation (0169 § 4) — a line from a payment against
//     a LIVE bill is that bill's money and is refused; both ceilings.
//   park_payments_idempotency_idx (0081) — unique where not null, 23505.
//   park_charges_one_live_per_period_idx (0081) — one live bill per
//     (reservation, period_month); a cancelled month is billable again.
//
// WHAT IT DELIBERATELY DOES NOT MODEL is listed at the foot of this file.

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** A live allocation — not taken back off its bill (0167 R3). */
const live = (a: Row) => a.removed_at == null;
/** Standing: neither reversed by the office nor pulled back by the bank. */
const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;

/** park_payment_remaining (0168 § 2). */
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? [])
    .filter((a) => a.payment_id === p.id && live(a))
    .reduce((s, a) => s + cents(a.amount), 0);
  const refunded = (db.park_refunds ?? [])
    .filter((r) => r.payment_id === p.id)
    .reduce((s, r) => s + cents(r.amount), 0);
  return Math.max(0, cents(p.amount) - allocated - refunded - cents(p.returned_amount)) / 100;
}

/** The view (0169 § 3). */
function onAccountView(): Row[] {
  const chargeOf = (p: Row) => (db.park_charges ?? []).find((c) => c.id === p.charge_id) ?? null;
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && stands(p))
    .filter((p) => p.charge_id == null || chargeOf(p)?.status === "void")
    .map((p) => {
      const c = chargeOf(p);
      const allocated = (db.park_payment_allocations ?? [])
        .filter((a) => a.payment_id === p.id && live(a))
        .reduce((s, a) => s + cents(a.amount), 0) / 100;
      const refunded = (db.park_refunds ?? [])
        .filter((r) => r.payment_id === p.id)
        .reduce((s, r) => s + cents(r.amount), 0) / 100;
      return {
        payment_id: p.id, park_id: p.park_id,
        renter_id: p.renter_id ?? c?.renter_id ?? null,
        amount: p.amount, received_on: p.received_on, created_at: p.created_at ?? null,
        method: p.method, reference: p.reference ?? null, receipt_no: p.receipt_no ?? null,
        note: p.note ?? null, idempotency_key: p.idempotency_key ?? null,
        allocated, refunded, remaining: remainingOf(p),
        handed_back: Number(p.returned_amount ?? 0),
        handed_back_on: p.returned_on ?? null, handed_back_note: p.return_note ?? null,
        released_from_charge_id: c?.id ?? null,
        released_from_month: c?.period_month ?? null,
        released_on: c?.voided_at ?? null,
      };
    });
}

/** recompute_charge_paid, through park_charge_paid_total (0169 § 1). */
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  if (c.status === "void") { c.paid_total = 0; return; }
  const direct = (db.park_payments ?? [])
    .filter((p) => p.charge_id === chargeId && stands(p))
    .reduce((s, p) => s + cents(p.amount)
      - (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0), 0);
  const applied = (db.park_payment_allocations ?? [])
    .filter((a) => a.charge_id === chargeId && live(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  c.status = paid >= Number(c.amount) ? "paid" : "open";
}

/** guard_park_charge_void (0169 § 2) — refused by name, with the amount. */
function guardVoid(c: Row, patch: Row): { code: string; message: string } | null {
  if (patch.status !== "void" || c.status === "void") return null;
  const held = (db.park_payment_allocations ?? [])
    .filter((a) => a.charge_id === c.id && live(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  if (held <= 0) return null;
  return {
    code: "P0001",
    message: `park_charges: ${(held / 100).toFixed(2)} of money on account is against this bill — take it off the bill first (with a reason), then cancel it`,
  };
}

/** guard_park_payment_allocation (0169 § 4) — the branches this walk can reach. */
function guardAllocation(row: Row): { code: string; message: string } | null {
  const pay = (db.park_payments ?? []).find((p) => p.id === row.payment_id);
  if (!pay) return { code: "P0001", message: "park_payment_allocations: no such payment" };
  if (pay.charge_id != null) {
    const src = (db.park_charges ?? []).find((c) => c.id === pay.charge_id);
    if (src?.status !== "void") {
      return { code: "P0001", message: "park_payment_allocations: that payment is against a live bill — it is that bill's money" };
    }
  }
  if (!stands(pay)) {
    return { code: "P0001", message: "park_payment_allocations: that payment was reversed — there is nothing to apply" };
  }
  const bill = (db.park_charges ?? []).find((c) => c.id === row.charge_id);
  if (!bill) return { code: "P0001", message: "park_payment_allocations: no such bill" };
  if (bill.status === "void") {
    return { code: "P0001", message: "park_payment_allocations: that bill was cancelled — put the money against a live one" };
  }
  const leftOnPayment = remainingOf(pay);
  if (cents(row.amount) > cents(leftOnPayment)) {
    return { code: "P0001", message: `park_payment_allocations: only ${leftOnPayment} is left on that payment, and this would apply ${row.amount}` };
  }
  const leftOnBill = (cents(bill.amount) - cents(bill.paid_total)) / 100;
  if (cents(row.amount) > cents(leftOnBill)) {
    return { code: "P0001", message: `park_payment_allocations: that bill only has ${leftOnBill} left on it, and this would apply ${row.amount}` };
  }
  return null;
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private sel = "";
  private cap: number | null = null;
  private pending: Row[] | null = null;
  private patch: Row | null = null;
  private failed: { code: string; message: string } | null = null;
  private sort: { c: string; asc: boolean } | null = null;
  constructor(private t: string) {}
  select(cols?: string) { this.sel = cols ?? ""; return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: unknown) { this.fs.push((r) => String(r[c]) >= String(v)); return this; }
  lt(c: string, v: unknown) { this.fs.push((r) => String(r[c]) < String(v)); return this; }
  lte(c: string, v: unknown) { this.fs.push((r) => String(r[c]) <= String(v)); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => !(v === null ? r[c] == null : r[c] === v)); return this; }
  /** PostgREST's `or=(a.gte.x,b.gte.y)`: the row passes if ANY clause does. */
  or(expr: string) {
    const clauses = expr.split(",").map((c) => c.split("."));
    this.fs.push((r) => clauses.some(([col, op, val]) => {
      if (op === "gte") return String(r[col] ?? "") >= val;
      if (op === "lte") return String(r[col] ?? "") <= val;
      if (op === "eq") return String(r[col] ?? "") === val;
      if (op === "is") return val === "null" ? r[col] == null : r[col] === val;
      throw new Error(`the fake does not model .or(${op})`);
    }));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.sort = { c, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.cap = n; return this; }

  private rows(): Row[] {
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    let out = source.filter((r) => this.fs.every((f) => f(r)));
    if (this.sort) {
      const { c, asc } = this.sort;
      out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.cap != null) out = out.slice(0, this.cap);
    // `park_lots(park_id, rental_mode)` — PostgREST embeds a many-to-one as an
    // OBJECT. Three doors re-derive the park from the lot this way rather than
    // trusting the browser.
    if (this.t === "lot_reservations" && this.sel.includes("park_lots(")) {
      out = out.map((s) => ({ ...s, park_lots: (db.park_lots ?? []).find((l) => l.id === s.park_lot_id) ?? null }));
    }
    // `park_payments!inner(...)` on an allocation: an INNER join drops rows
    // with no match, and the two void/receipt doors read the payment's
    // standing through it.
    if (this.t === "park_payment_allocations" && this.sel.includes("park_payments!inner(")) {
      out = out
        .map((a) => ({ ...a, park_payments: (db.park_payments ?? []).find((p) => p.id === a.payment_id) ?? null }))
        .filter((a) => a.park_payments != null);
    }
    // THE SELECT IS HONOURED on a plain column list: a column the code did not
    // ask for reads `undefined`, exactly as PostgREST hands it back. A guard
    // widened without its select compiles, reads undefined and refuses nobody
    // — the fake must not paper over that.
    if (this.sel && /^[\w\s,]+$/.test(this.sel) && !this.patch && !this.pending) {
      const keep = this.sel.split(",").map((c) => c.trim()).filter(Boolean);
      out = out.map((r) => {
        const o: Row = {};
        for (const k of keep) o[k] = r[k];
        return o;
      });
    }
    return out;
  }

  insert(row: Row | Row[]) {
    const rows = Array.isArray(row) ? row : [row];
    const written: Row[] = [];
    for (const r of rows) {
      const w: Row = { id: `${this.t}-${((db[this.t] ??= []).length + 1)}-${Math.random().toString(36).slice(2, 7)}`, ...r };
      if (this.t === "park_payments") {
        // 0081's unique index on idempotency_key, where not null.
        if (w.idempotency_key != null
            && (db.park_payments ?? []).some((p) => p.idempotency_key === w.idempotency_key)) {
          this.failed = { code: "23505", message: "duplicate key value violates unique constraint \"park_payments_idempotency_idx\"" };
          return this;
        }
        // assign_receipt_no (0076, rewritten 0102): max + 1 in the PARK.
        if (w.receipt_no == null) {
          w.receipt_no = (db.park_payments ?? [])
            .filter((p) => p.park_id === w.park_id)
            .reduce((n, p) => Math.max(n, Number(p.receipt_no ?? 0)), 0) + 1;
        }
        if (w.fee_amount === undefined) w.fee_amount = null;
        if (w.reversed_at === undefined) w.reversed_at = null;
        if (w.returned_at === undefined) w.returned_at = null;
        if (w.returned_on === undefined) w.returned_on = null;
        if (w.returned_amount === undefined) w.returned_amount = null;
        if (w.created_at === undefined) w.created_at = `${String(w.received_on)}T12:00:00Z`;
      }
      if (this.t === "park_charges") {
        // 0081's park_charges_one_live_per_period_idx: one LIVE bill per
        // (reservation, month) — a cancelled month is billable again.
        if ((db.park_charges ?? []).some((c) => c.reservation_id === w.reservation_id
            && c.period_month === w.period_month && c.status !== "void")) {
          this.failed = { code: "23505", message: "duplicate key value violates unique constraint \"park_charges_one_live_per_period_idx\"" };
          return this;
        }
        if (w.paid_total === undefined) w.paid_total = 0;
        if (w.status === undefined) w.status = "open";
      }
      if (this.t === "park_payment_allocations") {
        const refused = guardAllocation(w);
        if (refused) { this.failed = refused; return this; }
        if (w.removed_at === undefined) w.removed_at = null;
      }
      (db[this.t] ??= []).push(w);
      written.push(w);
      if (this.t === "park_payments" && w.charge_id) recompute(w.charge_id as string);
      if (this.t === "park_payment_allocations") recompute(w.charge_id as string);
    }
    this.pending = written;
    return this;
  }

  update(patch: Row) { this.patch = patch; return this; }
  single() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }

  private resolve(): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> {
    if (this.failed) return Promise.resolve({ data: null, error: this.failed });
    if (this.pending) return Promise.resolve({ data: this.pending, error: null });
    if (this.patch) {
      const hit = this.rows();
      if (this.t === "park_charges") {
        for (const r of hit) {
          const refused = guardVoid(r, this.patch);
          if (refused) return Promise.resolve({ data: null, error: refused });
        }
      }
      for (const r of hit) Object.assign(r, this.patch);
      // guard_park_charge_void's second half: a void bill holds nothing, on
      // the same write.
      if (this.t === "park_charges") for (const r of hit) if (r.status === "void") r.paid_total = 0;
      // sync_charge_paid, widened by 0167 § 7: a reversal drops the payment
      // out of its own bill AND out of every bill it had been allocated to.
      if (this.t === "park_payments") {
        for (const r of hit) {
          if (r.charge_id) recompute(r.charge_id as string);
          for (const a of (db.park_payment_allocations ?? []).filter((x) => x.payment_id === r.id)) {
            recompute(a.charge_id as string);
          }
        }
      }
      if (this.t === "park_payment_allocations") for (const r of hit) recompute(r.charge_id as string);
      return Promise.resolve({ data: hit, error: null });
    }
    return Promise.resolve({ data: this.rows(), error: null });
  }

  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

// THE LAKES' CLOCK, AND IT MOVES. The walk is a month long: both billing doors
// refuse a month that has not started, `received_on` is judged against this,
// and every "is it running out" answer on the morning screen is a subtraction
// from it. Hoisted so the mock factory can close over it.
const clock = vi.hoisted(() => ({ today: "2027-01-01" }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => clock.today,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
// No rent increases were served in this month — every household signed at the
// same figure on the 1st. The engine is mocked out so the run's rate for each
// month is the tenancy's own, which is what the seeded rate card set.
vi.mock("@/lib/rent-changes", () => ({
  applyDueRentChangesFor: async () => ({ applied: 0, skipped: [] as string[] }),
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
// LAKELIFE_PAYMENTS_LIVE is false everywhere but production, and nothing in
// this month touches a processor: The Haven is a cash-and-cheque park.
vi.mock("@/lib/charge-gate", () => ({
  paymentsAreLive: () => false,
  giveRefund: async () => ({ ok: false, error: "No payment processor is connected yet, so nothing was refunded." }),
}));

const { recordSigning } = await import("./sign-actions");
const { previewChargeRun, runCharges, recordPayment, reversePayment, voidCharge, getLedger } =
  await import("./ledger-actions");
const { recordOnAccount, handBackOnAccount, getHeldMoney } = await import("./money-actions");
const { endTenancy } = await import("./actions");
const { renewAgreement } = await import("./renew-actions");
const { getToday } = await import("./today-actions");

// ---------------------------------------------------------------------------
// THE PARK, AS IT STANDS ON CLOSING DAY
// ---------------------------------------------------------------------------

const PARK = "park-haven";
/** The seeded rate card. Every figure below has to come back to this and FEE. */
const RATE = 400;
/** The seeded Grounds fee — one row, monthly, long-term lots. */
const FEE = 142.53;

// THE HAVEN'S LOTS ARE NOT 1-21. A sequential roll imports nothing; these are
// the numbers on the ground. Lot 11 is the park-owned home — no household, no
// lease — and 26 and 28 are empty, which is how eighteen households sign.
const LOT_NUMBERS = ["1", "2", "6", "7", "9", "10", "11", "14", "15", "16", "17",
  "18", "19", "20", "21", "22", "23", "24", "26", "27", "28"];
const VACANT = ["26", "28"];
const PARK_OWNED = "11";
const LEASED = LOT_NUMBERS.filter((n) => n !== PARK_OWNED && !VACANT.includes(n));
/** Three households sign for three months; the other fifteen sign for one. */
const THREE_MONTH = ["1", "2", "6"];

const lotId = (n: string) => `lot-${n}`;
const renterId = (n: string) => `file-${n}`;
const holdoverId = (n: string) => `hold-${n}`;

function seed() {
  for (const t of Object.keys(db)) delete db[t];
  db.park_members = [{ park_id: PARK, user_id: "user-owner", role: "owner" }];
  db.parks = [{
    id: PARK, name: "The Haven", rent_due_day: 1, office_recording_lag_days: 3,
    cutover_date: "2027-01-01", max_agreement_months: 6, default_agreement_months: 1,
    active: true, lake_id: "lake-1", lat: 41.6, lng: -85.3,
    // Nothing goes out until he says so — held, and fails closed.
    notices_held_at: "2026-12-15T00:00:00Z", accepts_online_rent: false,
    address: "9085 E 500 S, LaGrange, IN",
  }];
  db.park_lots = LOT_NUMBERS.map((n) => ({
    id: lotId(n), park_id: PARK, lot_number: n,
    rental_mode: "long_term", lifecycle: "live", active: true,
  }));
  // THE RATE CARD — $400.00 a month on every lot. The headline this file pins
  // has to trace back to here.
  db.lot_rates = LOT_NUMBERS.map((n) => ({ park_lot_id: lotId(n), term: "monthly", amount: RATE }));
  // ONE FEE ROW. Monthly, long-term, active — the filter the biller applies.
  db.park_fees = [{
    id: "fee-grounds", park_id: PARK, label: "Grounds", amount: FEE,
    cadence: "monthly", applies_to: "long_term", active: true,
  }];
  db.park_renters = LEASED.map((n) => ({
    id: renterId(n), park_id: PARK, display_name: `Household ${n}`,
    email: null, phone_on_file_with_park: null, contact_pref: "email",
    invite_sent_at: null, claim_code_issued_at: null,
  }));
  // WHAT THE SELLER LEFT: eighteen households living here on his arrangement,
  // nobody signed onto anything of ours. `origin: 'grandfathered'` is the
  // whole fact — the signing door refuses any other kind of prior row.
  db.lot_reservations = LEASED.map((n) => ({
    id: holdoverId(n), park_lot_id: lotId(n), renter_id: renterId(n), renter_unit_id: null,
    during: "[2026-06-01,2027-06-01)", status: "active", term: "monthly",
    quoted_amount: RATE, origin: "grandfathered", moved_out_on: null, due_day: null,
    agreement_chain_id: `chain-${n}`, agreement_seq: 1, notice_given_on: null,
    expected_move_out: null, tenancy_began_on: "2021-04-01",
    amount_source: "prior_roll", amount_source_at: "2026-12-01T00:00:00Z",
  }));
  for (const t of ["park_charges", "park_payments", "park_payment_allocations", "park_refunds",
    "park_payment_claims", "lot_cost_shares", "park_costs", "lot_rent_changes",
    "park_task_states", "park_notes", "park_site_visits", "park_cost_schedules",
    "park_machine_runs", "park_renter_units"]) db[t] = [];
}
seed();

/** The bills raised for a month, in lot order — read straight off the fake. */
const billsFor = (month: string) => (db.park_charges ?? [])
  .filter((c) => c.period_month === month)
  .sort((a, b) => String(a.park_lot_id).localeCompare(String(b.park_lot_id)));
const billOn = (lot: string, month: string) =>
  (db.park_charges ?? []).find((c) => c.park_lot_id === lotId(lot) && c.period_month === month && c.status !== "void");
const leaseOn = (lot: string) => (db.lot_reservations ?? [])
  .filter((r) => r.park_lot_id === lotId(lot) && r.origin === "office")
  .sort((a, b) => Number(b.agreement_seq) - Number(a.agreement_seq))[0];

// ===========================================================================
// 1 JANUARY — EIGHTEEN HOUSEHOLDS SIGN
// ===========================================================================

describe("1 January 2027 — eighteen households sign the new lease", () => {
  it("the first signing says the day, the length and what January bills — from the rate card and the fee, not from the form", async () => {
    clock.today = "2027-01-01";
    const res = await recordSigning(PARK, holdoverId("1"), {
      signedOn: "2027-01-01", rent: String(RATE),
      email: "h1@example.com", mobile: "+15745550101", agreementMonths: 3,
    });
    expect(res.ok, res.error).toBe(true);
    // $542.53 is NOT written here as a sum this file worked out: $400.00 is
    // the seeded rate card read back through the form, $142.53 is the one fee
    // row, and the sentence's own arithmetic is what is being pinned.
    expect(res.signal).toBe(
      "On the new 3-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).",
    );
  });

  it("a one-month lease says one-month, and the holdover is trimmed rather than rewritten", async () => {
    const res = await recordSigning(PARK, holdoverId("9"), {
      signedOn: "2027-01-01", rent: String(RATE),
      email: "h9@example.com", mobile: "+15745550109", agreementMonths: 1,
    });
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "On the new one-month lease from January 1, 2027 — January 2027 bills $542.53 ($400.00 rent + $142.53 fees).",
    );
    // The seller's arrangement is not deleted and not restated — it is closed
    // on the day the lease begins, and the new row is its own record.
    expect(db.lot_reservations.find((r) => r.id === holdoverId("9"))).toMatchObject({
      during: "[2026-06-01,2027-01-01)", origin: "grandfathered",
    });
    expect(leaseOn("9")).toMatchObject({
      during: "[2027-01-01,2027-02-01)", status: "active", term: "monthly",
      quoted_amount: RATE, origin: "office", agreement_seq: 2,
      // A signed lease's rent is never the seller's roll — it is on paper the
      // owner holds.
      amount_source: "owner_knowledge",
    });
  });

  it("the other sixteen sign, and every lease is at the rate card", async () => {
    for (const n of LEASED) {
      if (n === "1" || n === "9") continue;
      const res = await recordSigning(PARK, holdoverId(n), {
        signedOn: "2027-01-01", rent: String(RATE),
        email: `h${n}@example.com`, mobile: `+1574555${n.padStart(4, "0")}`,
        agreementMonths: THREE_MONTH.includes(n) ? 3 : 1,
      });
      expect(res.ok, `lot ${n}: ${res.error}`).toBe(true);
    }
    const signed = db.lot_reservations.filter((r) => r.origin === "office");
    expect(signed).toHaveLength(18);
    expect(new Set(signed.map((r) => Number(r.quoted_amount)))).toEqual(new Set([RATE]));
    // Fifteen run to 1 February; three run to 1 April. That split is what
    // February's morning is made of.
    expect(signed.filter((r) => r.during === "[2027-01-01,2027-02-01)")).toHaveLength(15);
    expect(signed.filter((r) => r.during === "[2027-01-01,2027-04-01)")).toHaveLength(3);
    // Nobody signed the park's own home, and nobody signed an empty lot.
    expect(signed.some((r) => r.park_lot_id === lotId(PARK_OWNED))).toBe(false);
    expect(signed.some((r) => VACANT.includes(String(r.park_lot_id).replace("lot-", "")))).toBe(false);
  });
});

// ===========================================================================
// 1 JANUARY — THE RUN
// ===========================================================================

describe("1 January 2027 — January is billed", () => {
  it("the preview and the run say the same figure, and it is the rate card plus the fee eighteen times over", async () => {
    const pre = await previewChargeRun(PARK, "2027-01");
    expect(pre.ok, pre.error).toBe(true);
    expect(pre.plan!.toBill).toHaveLength(18);
    // runSummary is the sentence under the button. Nothing skipped on this
    // morning, so there are no clauses after the figure.
    expect(runSummary(pre.plan!, "2027-01")).toBe("Bill 18 households for January 2027 — $9,765.54");

    const run = await runCharges(PARK, "2027-01");
    expect(run.ok, run.error).toBe(true);
    expect(run.raised).toBe(18);
    expect(run.signal).toBe("18 bills raised for January 2027 — $9,765.54. Nobody has been told.");
  });

  it("every bill is the rate card plus the one fee, due on the park's day", () => {
    const jan = billsFor("2027-01");
    expect(jan).toHaveLength(18);
    for (const c of jan) {
      expect(Number(c.amount)).toBe(542.53);
      expect(c.due_on).toBe("2027-01-01");
      expect(c.period_month).toBe("2027-01");
    }
    // The bill's frozen lines name the fee by its own label — the fee is not
    // folded into the rent, here or on the paper.
    expect(jan[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Grounds", amount: FEE }),
    ]));
  });

  it("a second run the same morning raises nothing, and says why rather than 'try again'", async () => {
    const again = await runCharges(PARK, "2027-01");
    expect(again.ok).toBe(false);
    expect(again.error).toBe("Nothing to bill for January 2027 — 18 bills are already raised.");
    expect(billsFor("2027-01")).toHaveLength(18);
  });
});

// ===========================================================================
// 3 JANUARY — THE BILL WINDOW
// ===========================================================================

describe("3 January 2027 — money at the bill window", () => {
  it("$542.53 in cash against Lot 1's January bill settles it, and the paper carries the reference the office will be asked for", async () => {
    clock.today = "2027-01-03";
    const bill = billOn("1", "2027-01")!;
    const res = await recordPayment(
      PARK, bill.id as string, 542.53, "cash", "", "2027-01-03", undefined, "key-lot1-jan",
    );
    expect(res.ok, res.error).toBe(true);
    expect(res.against).toBe(542.53);
    expect(res.onAccount).toBe(0);
    expect(res.signal).toBe("Recorded — that one's settled.");
    // THE HOUSEHOLD'S OWN REFERENCE. Not "101" — the paper says TH-2027-0001,
    // and the reversal sentence two windows later has to say the same string.
    expect(receiptRef("The Haven", res.receipt!.receiptNo, "2027-01-03")).toBe("TH-2027-0001");
    expect(res.receipt!.balanceAfter).toBe(0);
    const paper = receiptBody(res.receipt!);
    expect(paper).toContain("The Haven — receipt TH-2027-0001");
    expect(paper).toContain("Received from   Household 1");
    expect(paper).toContain("Balance         nothing further owing on this one");
    // The bill agrees with the paper.
    expect(Number(billOn("1", "2027-01")!.paid_total)).toBe(542.53);
    expect(billOn("1", "2027-01")!.status).toBe("paid");
  });

  it("the ⊕ window's note names no month for the excess — the window knows the bill, not the paperwork", () => {
    // THE DEFECT THIS PINS. The note used to say "comes off February 2027",
    // the month after the bill in front of it. Lot 14's lease ends on
    // 1 February, so February's run raises them nothing, and the household
    // was told at the counter that their $542.53 would come off a bill that
    // was never going to exist. The window cannot see the agreement; it now
    // says the thing that is true either way.
    // The bill in front of the window is the one the biller raised, read back
    // out of the ledger — so the $542.53 in this sentence is the rate card
    // plus the fee, not a figure typed into a fixture.
    const bill = billOn("14", "2027-01")!;
    const facts = {
      oldestOpen: { chargeId: bill.id as string, month: "2027-01", balance: Number(bill.amount), disputed: false },
      openCount: 1, onAccount: 0, nothingMoreBills: false as boolean | null, olderOpen: [],
    };
    expect(amountNote("1085.06", facts)).toBe(
      "$542.53 settles January 2027; the other $542.53 goes on account and comes off the next bill you raise for them.",
    );
    expect(amountNote("1085.06", facts)).not.toContain("February 2027");
    // Collapsed the other way: a household nothing more bills for is told the
    // money is theirs, and still no month is named.
    expect(amountNote("1085.06", { ...facts, nothingMoreBills: true })).toBe(
      "$542.53 settles January 2027; the other $542.53 goes on account — nothing more bills for them, "
      + "so it's theirs to have back from \"Money not against a bill\" on the Rent screen.",
    );
    // And with the fact unread, no promise at all — the sentence stops there.
    expect(amountNote("1085.06", { ...facts, nothingMoreBills: null })).toBe(
      "$542.53 settles January 2027; the other $542.53 goes on account.",
    );
  });

  it("Lot 14 hands over $1,085.06 on a lease that ends 1 February — and is promised no month", async () => {
    const bill = billOn("14", "2027-01")!;
    const res = await recordPayment(
      PARK, bill.id as string, 1085.06, "check", "4417", "2027-01-03", undefined, "key-lot14-jan",
    );
    expect(res.ok, res.error).toBe(true);
    expect(res.against).toBe(542.53);
    expect(res.onAccount).toBe(542.53);
    // NO MONTH. Lot 14's agreement is [2027-01-01,2027-02-01) — February is
    // not inside it, so nothing may name February.
    expect(res.signal).toBe(
      "$1,085.06 received — $542.53 against January 2027, $542.53 on account "
      + "and comes off the next bill you raise for them.",
    );
    expect(res.signal).not.toContain("February 2027");
    // ONE CHEQUE, TWO ROWS, ONE INSERT — the bill's share and the excess,
    // under the one key and its :onaccount sibling.
    const rows = db.park_payments.filter((p) => String(p.idempotency_key ?? "").startsWith("key-lot14-jan"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.charge_id == null)).toEqual([false, true]);
  });

  it("the same money for a household whose lease reaches February DOES name the month — the branch, collapsed the other way", async () => {
    // Lot 2 signed for three months, so February is inside their agreement
    // and the promise can name it. Same door, same amount, same day: the only
    // thing that differs is the paperwork, which is exactly the fact the fix
    // made the sentence key on.
    const bill = billOn("2", "2027-01")!;
    const res = await recordPayment(
      PARK, bill.id as string, 1085.06, "check", "4418", "2027-01-03", undefined, "key-lot2-jan",
    );
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "$1,085.06 received — $542.53 against January 2027, $542.53 on account "
      + "and comes off February 2027 when you raise it.",
    );
  });

  it("a double-tapped submit is not a second payment", async () => {
    const bill = billOn("2", "2027-01")!;
    const twice = await recordPayment(
      PARK, bill.id as string, 1085.06, "check", "4418", "2027-01-03", undefined, "key-lot2-jan",
    );
    expect(twice.ok).toBe(false);
    expect(twice.error).toBe("That payment is already recorded — check the ledger before entering it again.");
  });
});

// ===========================================================================
// 5 JANUARY — THE OTHER WINDOW
// ===========================================================================

describe("5 January 2027 — money at the other window, with no bill named", () => {
  it("$200.00 on account settles the oldest open bill of theirs the moment it is recorded", async () => {
    clock.today = "2027-01-05";
    const res = await recordOnAccount(
      PARK, renterId("15"), 200, "cash", "", "2027-01-05", undefined, "key-lot15-acct",
    );
    expect(res.ok, res.error).toBe(true);
    // R1: it does not sit there waiting for a run. January is open and it is
    // the oldest, so it goes on January now and the sentence says so.
    expect(res.signal).toBe(
      "$200.00 recorded for Household 15. $200.00 went against January 2027 — nothing stays on account.",
    );
    expect(Number(billOn("15", "2027-01")!.paid_total)).toBe(200);
    expect(billOn("15", "2027-01")!.status).toBe("open");
  });

  it("the rest of it, handed over three days later, settles the same bill and says what was already on it", async () => {
    clock.today = "2027-01-08";
    const bill = billOn("15", "2027-01")!;
    const res = await recordPayment(
      PARK, bill.id as string, 342.53, "cash", "", "2027-01-08", undefined, "key-lot15-rest",
    );
    expect(res.ok, res.error).toBe(true);
    // The paper must reconcile: $342.53 handed over on a $542.53 bill with
    // nothing further owing is a receipt the household cannot read without
    // the line saying where the other $200.00 came from.
    expect(res.receipt!.fromOnAccount).toBe(200);
    expect(res.receipt!.balanceAfter).toBe(0);
    expect(receiptBody(res.receipt!)).toContain("$200.00");
    expect(res.signal).toBe("Recorded — that one's settled.");
  });
});

// ===========================================================================
// 8 JANUARY — A CHEQUE BOUNCES
// ===========================================================================

describe("8 January 2027 — Lot 14's cheque bounces", () => {
  it("both halves go back, the bill reopens, and the sentence names the receipt the household is holding", async () => {
    clock.today = "2027-01-08";
    const billHalf = db.park_payments.find((p) => p.idempotency_key === "key-lot14-jan")!;
    const res = await reversePayment(PARK, billHalf.id as string, "Returned by the bank — insufficient funds");
    expect(res.ok, res.error).toBe(true);
    // THE REFERENCE THE PAPER CARRIES, not the raw number behind it. This
    // sentence used to read "(receipt 103)" while the household's copy said
    // "TH-2027-0003", and the office looking one up was looking for a
    // different string.
    expect(res.signal).toBe(
      "$1,085.06 taken back (receipt TH-2027-0002) — both halves of it, the $542.53 against January 2027 "
      + "and the $542.53 on account. The January 2027 bill is outstanding again. The record shows why.",
    );
    expect(res.signal).toMatch(/receipt TH-\d{4}-\d{4}/);
    expect(res.signal).not.toMatch(/receipt \d+\)/);
    // One cheque: a bounce takes both rows, or the next run puts money that
    // never arrived against February.
    const halves = db.park_payments.filter((p) => String(p.idempotency_key ?? "").startsWith("key-lot14-jan"));
    expect(halves.every((p) => p.reversed_at != null)).toBe(true);
    expect(Number(billOn("14", "2027-01")!.paid_total)).toBe(0);
    expect(billOn("14", "2027-01")!.status).toBe("open");
  });

  it("and it cannot be taken back twice", async () => {
    const billHalf = db.park_payments.find((p) => p.idempotency_key === "key-lot14-jan")!;
    const twice = await reversePayment(PARK, billHalf.id as string, "keyed again by mistake");
    expect(twice.ok).toBe(false);
    expect(twice.error).toBe("That one's already been taken back.");
  });
});

// ===========================================================================
// 9 JANUARY — A BILL IS CANCELLED, AND ITS MONEY RELEASED
// ===========================================================================

describe("9 January 2027 — Lot 17's bill is cancelled and its money released", () => {
  it("money taken at the window goes onto their account, and the sentence names the figure, the promise and the door", async () => {
    clock.today = "2027-01-09";
    const bill = billOn("17", "2027-01")!;
    const paid = await recordPayment(
      PARK, bill.id as string, 542.53, "check", "8801", "2027-01-06", undefined, "key-lot17-jan",
    );
    expect(paid.ok, paid.error).toBe(true);

    const res = await voidCharge(PARK, bill.id as string, "Raised against the wrong lot");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Cancelled. The $542.53 taken against it is on account for Household 17 now — "
      + "it comes off January 2027 when you bill it again, or hand it back from "
      + "\"Money not against a bill\" on the Rent screen.",
    );
    // 0169's model: the ROW DOES NOT MOVE. Its charge_id still names the
    // cancelled bill; what changed is the bill's status.
    const row = db.park_payments.find((p) => p.idempotency_key === "key-lot17-jan")!;
    expect(row.charge_id).toBe(bill.id);
    expect(Number(bill.paid_total)).toBe(0);
    // And the held panel — the door that sentence names — actually lists it.
    const held = await getHeldMoney(PARK);
    const theirs = held.onAccount.find((r) => r.renterId === renterId("17"))!;
    expect(theirs.remaining).toBe(542.53);
    expect(theirs.releasedFrom).toMatchObject({ month: "2027-01" });
  });

  it("a cancelled bill owes NOTHING in the rent roll's money column, and the column agrees with the card above it", async () => {
    // THE DEFECT THIS PINS. 0169 forces a void bill's paid_total to zero, so
    // `amount − paid_total` handed the roll the whole $542.53 back as a
    // balance — printed in the bold right-hand column that means "still
    // owing" on every other row — while `summarise`, which skips void
    // charges, left it out of the outstanding figure above. The column summed
    // more than the card. They now agree by construction.
    const page = (await getLedger(PARK, "2027-01"))!;
    const cancelled = page.rows.find((r) => r.state === "void")!;
    expect(cancelled.lotNumber).toBe("17");
    expect(cancelled.balance).toBe(0);
    const columnTotal = page.rows.reduce((s, r) => s + Math.round(r.balance * 100), 0);
    expect(columnTotal).toBe(Math.round(page.summary.outstanding * 100));
  });
});

// ===========================================================================
// 27 JANUARY — A MOVE-OUT, AND $70.00 BACK ACROSS THE COUNTER
// ===========================================================================

describe("27 January 2027 — Lot 9 moves out, and the drawer goes down", () => {
  it("their January is cancelled and raised again for the days they were here, settled from the money they had paid", async () => {
    clock.today = "2027-01-27";
    const bill = billOn("9", "2027-01")!;
    const paid = await recordPayment(
      PARK, bill.id as string, 542.53, "check", "9901", "2027-01-05", undefined, "key-lot9-jan",
    );
    expect(paid.ok, paid.error).toBe(true);

    const res = await endTenancy(leaseOn("9").id as string, "ended", "2027-01-27");
    expect(res.ok, res.error).toBe(true);
    // 27 of 31 days of $542.53 is $472.53 — the figure the household will be
    // asked about, and the one $70.00 is the remainder of.
    expect(res.signal).toBe(
      "Closed out — last day January 27, 2027. "
      + "January 2027's $542.53 bill for the whole month was cancelled — the $542.53 paid on it is on account — "
      + "and raised again for the 27 of 31 days they were here — $472.53, all of it settled from that money. "
      + "They still hold $70.00 on account with you.",
    );
    const partMonth = billOn("9", "2027-01")!;
    expect(Number(partMonth.amount)).toBe(472.53);
    expect(Number(partMonth.paid_total)).toBe(472.53);
    expect(partMonth.status).toBe("paid");
  });

  it("$70.00 is handed back, and the record says what is left", async () => {
    const row = db.park_payments.find((p) => p.idempotency_key === "key-lot9-jan")!;
    const res = await handBackOnAccount(
      PARK, row.id as string, 70, "2027-01-27", "Moved out on the 27th — the month billed for 27 days",
    );
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "$70.00 handed back on January 27, 2027 — the record shows why. Nothing of theirs is on account any more.",
    );
    // MONEY RECEIVED STAYS THE ROW IT WAS: the hand-back is a stamp on the
    // payment, not an edit of its amount and not a deletion.
    expect(Number(row.amount)).toBe(542.53);
    expect(row.returned_amount).toBe(70);
    expect(row.returned_on).toBe("2027-01-27");
  });

  it("a hand-back is recorded once", async () => {
    const row = db.park_payments.find((p) => p.idempotency_key === "key-lot9-jan")!;
    const twice = await handBackOnAccount(PARK, row.id as string, 10, "2027-01-27", "again");
    expect(twice.ok).toBe(false);
    expect(twice.error).toBe(
      "Money from that payment was already handed back on January 27, 2027 — a hand-back is recorded once.",
    );
  });

  it("and the morning screen knows the drawer went down — the net across the counter, on the day it happened", async () => {
    // THE DEFECT THIS PINS. A hand-back leaves `reversed_at` and `returned_at`
    // both null — it is neither a bounce nor a bank return — so every figure
    // on this screen counted the money as still in the drawer. On the morning
    // the office recorded "$70.00 handed back on January 27, 2027" Today read
    // "$50.00 came in today" and nothing anywhere said the counter was down.
    const today = (await getToday(PARK))!;
    expect(today.money.headline).toMatch(/^\$[\d,]+\.\d\d in so far this month\. \$70\.00 has been handed back\.$/);
    expect(today.money.todayLine).toBe("$70.00 went back out today, and nothing came in.");
  });
});

// ===========================================================================
// 31 JANUARY — MONTH END
// ===========================================================================

describe("31 January 2027 — the month, closed", () => {
  it("the rent screen's own headline is the figure the bills add up to", async () => {
    clock.today = "2027-01-31";
    const page = (await getLedger(PARK, "2027-01"))!;
    // Void rows are not bills. Seventeen live ones: eighteen raised, Lot 17's
    // cancelled, and Lot 9's re-raised part month back in its place.
    expect(page.rows.filter((r) => r.state !== "void")).toHaveLength(17);
    expect(ledgerHeadline(page.summary, page.lagDays)).toBe(ledgerHeadline(summarise(page.rows), page.lagDays));
    // The one figure the office reads as "go and get this".
    expect(money(page.summary.outstanding)).toBe("$7,052.89");
  });

  it("what the park is holding, and the one screen that still disagrees about it", async () => {
    const held = await getHeldMoney(PARK);
    // Two rows are still held: Lot 2's excess, keyed on account on the 3rd,
    // and Lot 17's $542.53, released when their bill was cancelled on the 9th.
    // Lot 14's bounced, Lot 15's was spent on their own bill, and Lot 9's went
    // back across the counter.
    expect(held.onAccountTotal).toBe(1085.06);
    expect(held.onAccount.filter((r) => r.remaining > 0).map((r) => r.remaining).sort())
      .toEqual([542.53, 542.53]);

    const today = (await getToday(PARK))!;
    // ⚠️ STILL OPEN — PINNED HONEST, NOT PINNED RIGHT.
    //
    // This line's FIGURE was fixed: it used to count what ARRIVED, so a
    // cheque already spent on a bill was counted here and in the rent line
    // at once, and the sentence whose whole job is to explain the gap
    // between the headline and the rent line was $542.53 wrong about it. It
    // now reads the view's `remaining`, and its words say so.
    //
    // Its POPULATION was not. today-actions builds `offBook` as the payments
    // with `charge_id == null`, and a row released by a cancelled bill (0169)
    // keeps its charge_id for ever — the row does not move. So Lot 17's
    // $542.53 is money on account by the view's own definition, is counted by
    // the held panel above and by the resident's own page, and is invisible
    // here. The sentence reads "what's still held of what came in this month"
    // over a figure that is $542.53 short of exactly that.
    //
    // WHAT MUST CHANGE: `offBook` in today-actions.ts has to be the view's
    // membership, not `charge_id == null` — the same read the held panel
    // makes. When it is, this pin goes red and the two figures below become
    // one. today-actions.ts is not this file's to edit.
    expect(today.money.offBookLine).toBe(
      "$542.53 of that is money on account — what's still held of what came in this month. "
      + "The rent line below counts this month's bills only.",
    );
    // The disagreement itself, stated, so nobody reads the pin above as a
    // blessing: one definition, two answers, on one morning.
    expect(money(held.onAccountTotal)).not.toBe("$542.53");
  });
});

// ===========================================================================
// 1 FEBRUARY — A RENEWAL, FIFTEEN LAPSES, AND THE RUN
// ===========================================================================

describe("1 February 2027 — a renewal, the lapsed, and February's run", () => {
  it("one household renews, and the toast says the span and the rent", async () => {
    clock.today = "2027-02-01";
    const res = await renewAgreement(PARK, leaseOn("15").id as string, { months: 1 });
    expect(res.ok, res.error).toBe(true);
    expect(res.newEnd).toBe("2027-03-01");
    expect(res.signal).toBe(
      "Lot 15 renewed for 1 month, February 1, 2027 to March 1, 2027 at $400.00 a month. Consecutive with the last one.",
    );
  });

  it("the preview and the run say the SAME thing about who was left out", async () => {
    // THE DEFECT THIS PINS. The preview's line carried the skip clauses and
    // the run's toast, one tap later, carried none: "3 bills raised for
    // February 2027 — $1,627.59. Nobody has been told." Thirteen households
    // stopped being billed between those two sentences and only the first one
    // mentioned it.
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.ok, pre.error).toBe(true);
    expect(runSummary(pre.plan!, "2027-02")).toBe(
      "Bill 4 households for February 2027 — $2,170.12, $542.53 of it already on account · 13 agreements have run out",
    );

    const run = await runCharges(PARK, "2027-02");
    expect(run.ok, run.error).toBe(true);
    expect(run.raised).toBe(4);
    expect(run.signal).toBe(
      "4 bills raised for February 2027 — $2,170.12, $542.53 of it settled from money on account. "
      + "13 agreements have run out. Nobody has been told.",
    );
    // The two sentences are about one morning, so the same count appears in
    // both. A household who LEFT did not lapse, and is in neither figure.
    expect(run.signal).toContain("13 agreements have run out");
    expect(pre.plan!.expired).not.toContain("9");
  });

  it("an agreement that ran out this morning is overdue, not 'running out' — and the money stuck behind it is named", async () => {
    // THE DEFECT THIS PINS. `endsOn` is a half-open range's EXCLUSIVE end, so
    // on the morning an agreement expires the day count is 0, not negative.
    // The card read "[soon] 14 agreements are running out — the first ends
    // February 1, 2027", dismissible, on the same morning the run skipped all
    // of them.
    const today = (await getToday(PARK))!;
    const card = today.tasks.find((t) => t.key.startsWith("agreements_ending:"))!;
    expect(card.urgency).toBe("overdue");
    expect(card.canDismiss).toBe(false);
    expect(card.title).toBe("13 agreements have lapsed");
    expect(card.detail).toBe(
      "13 have lapsed — the first on February 1, 2027; nothing billed since. "
      + "$542.53 of theirs is on account with no bill to come off.",
    );
  });
});

// ---------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT PIN, AND WHY
// ---------------------------------------------------------------------------
//
//   THE PROCESSOR RAILS. The Haven takes cash and cheques; card and ACH are
//   refused before any read (handKeyedRefusal), and refunds are covered where
//   they live, in refund-path.test.ts and ledger-actions.test.ts.
//
//   THE STATEMENTS SCREEN's part-period sentence. It is a rendered component
//   and is pinned, with the same date read two ways on one card, in
//   ParkStatements.on-account.test.tsx.
//
//   0173's freezes (an amount edited in place, a payment or a bill deleted, a
//   reversal rubbed out). The fake models the refusals this walk can REACH; no
//   door in the walk attempts an edit of a recorded amount, so modelling those
//   here would be a rule with no caller. They are pinned against the migration
//   in ledger-is-the-row-it-was.test.ts.
//
//   THE NIGHTLY MACHINE, notices and SMS. Nothing goes out until he says so
//   (parks.notices_held_at, seeded held above); the run's own sentence ends
//   "Nobody has been told", which IS pinned.
