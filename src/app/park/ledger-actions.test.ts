import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptBody } from "./receipt-helpers";
import { runSummary, prettyMonth } from "./ledger-helpers";

/**
 * THE MONEY DOORS, CALLED WITH THE PAYLOADS THE SCREENS SEND.
 *
 * Four defects on one ledger, all of the same house shape — a rule enforced in
 * one doorway and not the others:
 *
 *   - the office form offered "Card" and "Bank transfer" = `ach`, and the
 *     database treats those as processor money it will never let him correct;
 *   - $600 for a $542.53 bill landed as one row and became "In credit" — a
 *     credit that nothing ever applied to February;
 *   - "Email it to them" blamed the address for the hold he set himself;
 *   - the run's four-way skip sort lived in `runCharges` alone, so the preview
 *     said "no rent set" on the morning every agreement lapsed.
 *
 * These call the REAL actions against a small fake of the tables they touch.
 * The fake is deliberately dumb: filters, one bulk insert, the two triggers
 * that matter (receipt numbers; a charge's paid_total). Nothing here is a
 * copy of the code under test.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Every row handed to `.insert`, with the table it went to. */
const inserted: Row[] = [];
/** Every `.update` payload, with its table. */
const updated: Array<{ table: string; patch: Row }> = [];
/** One entry per `.insert` CALL, so a split can be proved atomic (one call). */
const insertCalls: number[] = [];
/** Set to make the next park_payments insert fail. */
let nextInsertError: { code: string; message: string } | null = null;
/** Set to make the next `.update` on that table fail. */
let nextUpdateError: { table: string; error: { code: string; message: string } } | null = null;
/** Runs once, just before the next `.update` on that table lands — somebody else acting between a door's read and its write. */
let beforeUpdate: { table: string; act: () => void } | null = null;
let receiptNo = 100;
/** Fail the Nth (0-based) park_payment_allocations insert with this error. */
let nextAllocationError: { after: number; error: { code: string; message: string } } | null = null;
/** Fail the next plain read on that table — or, with `column`, the next read on it that filters on that column, so the SIBLING read can fail while the row's own succeeds. */
let nextReadError: { table: string; column?: string; error: { code: string; message: string } } | null = null;
/** Every table a door opened, in order — so "read once" is counted, not assumed. */
const opened: string[] = [];

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** A live allocation — not taken back off its bill (0167 R3). Removed rows count toward nothing. */
const live = (a: Row) => a.removed_at == null;
/** What the payment still has unapplied — park_payment_remaining, modelled. */
function remainingOf(p: Row): number {
  const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && live(a)).reduce((s, a) => s + cents(a.amount), 0);
  const refunded = (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((s, r) => s + cents(r.amount), 0);
  return Math.max(0, cents(p.amount) - allocated - refunded) / 100;
}
/** The view (0167, widened by 0169): rent, standing, and no bill OR a bill since cancelled — released money, with the bill's month beside it. */
function onAccountView(): Row[] {
  const chargeOf = (p: Row) => (db.park_charges ?? []).find((c) => c.id === p.charge_id) ?? null;
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.reversed_at == null && p.returned_at == null && (p.charge_id == null || chargeOf(p)?.status === "void"))
    .map((p) => {
      const c = chargeOf(p);
      return {
        payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id ?? c?.renter_id ?? null, amount: p.amount, received_on: p.received_on,
        created_at: p.created_at ?? null, method: p.method, reference: p.reference ?? null, receipt_no: p.receipt_no ?? null,
        note: p.note ?? null, idempotency_key: p.idempotency_key ?? null,
        allocated: (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && live(a)).reduce((s, a) => s + Number(a.amount), 0),
        refunded: (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((s, r) => s + Number(r.amount), 0),
        remaining: remainingOf(p),
        released_from_charge_id: c?.id ?? null, released_from_month: c?.period_month ?? null, released_on: c?.voided_at ?? null,
      };
    });
}
/** guard_park_charge_void (0169): refused by name while a live line from a standing payment is on it. */
function guardVoid(c: Row, patch: Row): { code: string; message: string } | null {
  if (patch.status !== "void" || c.status === "void") return null;
  const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
  const held = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === c.id && live(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  if (held > 0) return { code: "P0001", message: `park_charges: ${(held / 100).toFixed(2)} of money on account is against this bill — take it off the bill first (with a reason), then cancel it` };
  return null;
}
/** recompute_charge_paid (0167): direct payments less refunds, plus allocations from payments that still stand; a void bill holds 0 (0169). */
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  if (c.status === "void") { c.paid_total = 0; return; }
  const stands = (p: Row | undefined) => !!p && p.reversed_at == null && p.returned_at == null;
  const direct = (db.park_payments ?? []).filter((p) => p.charge_id === chargeId && stands(p))
    .reduce((s, p) => s + cents(p.amount) - (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0), 0);
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && live(a))
    .filter((a) => stands((db.park_payments ?? []).find((p) => p.id === a.payment_id)))
    .reduce((s, a) => s + cents(a.amount), 0);
  const paid = (direct + applied) / 100;
  c.paid_total = paid;
  if (c.status !== "void") c.status = paid >= Number(c.amount) ? "paid" : "open";
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  /** The columns filtered on, for a column-aware read failure. */
  private cols: string[] = [];
  /** What `.select()` asked for — the embed is modelled from it. */
  private sel = "";
  private cap: number | null = null;
  private pending: Row[] | null = null;
  private patch: Row | null = null;
  private failed: { code: string; message: string } | null = null;
  constructor(private t: string) {}
  select(cols?: string) { this.sel = cols ?? ""; return this; }
  eq(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => r[c] !== v); return this; }
  gt(c: string, v: number) { this.cols.push(c); this.fs.push((r) => Number(r[c]) > v); return this; }
  in(c: string, vs: unknown[]) { this.cols.push(c); this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.cols.push(c); this.fs.push((r) => !(v === null ? r[c] == null : r[c] === v)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sort = { c, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.cap = n; return this; }
  private sort: { c: string; asc: boolean } | null = null;
  private rows(): Row[] {
    // THE VIEW 0167 BUILT, modelled: money on account (rent, no charge, still
    // standing) with what has been put against bills and what is left.
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    let out = source.filter((r) => this.fs.every((f) => f(r)));
    if (this.sort) {
      const { c, asc } = this.sort;
      out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.cap != null) out = out.slice(0, this.cap);
    // `park_payments!inner(...)` on an allocation: PostgREST embeds the
    // many-to-one as an OBJECT and an inner join drops rows with no match.
    if (this.t === "park_payment_allocations" && this.sel.includes("park_payments!inner(")) {
      out = out
        .map((a) => ({ ...a, park_payments: (db.park_payments ?? []).find((p) => p.id === a.payment_id) ?? null }))
        .filter((a) => a.park_payments != null);
    }
    // THE SELECT IS HONOURED on a plain column list: a column the code did
    // not ask for reads `undefined`, exactly as PostgREST hands it back. A
    // condition widened without its select compiles, reads undefined, and
    // refuses nobody — the mock must not paper over that.
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
    insertCalls.push(rows.length);
    if (this.t === "park_payments" && nextInsertError) {
      this.failed = nextInsertError; nextInsertError = null; return this;
    }
    if (this.t === "park_payment_allocations" && nextAllocationError) {
      const e = nextAllocationError;
      if (--e.after < 0) { this.failed = e.error; nextAllocationError = null; return this; }
    }
    const written = rows.map((r) => {
      const w: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, ...r };
      if (this.t === "park_payments") {
        // assign_receipt_no — the trigger whose number the action reads back.
        w.receipt_no = ++receiptNo;
        if (w.fee_amount === undefined) w.fee_amount = null;
        if (w.reversed_at === undefined) w.reversed_at = null;
        if (w.returned_at === undefined) w.returned_at = null;
      }
      if (this.t === "park_charges") {
        if (w.paid_total === undefined) w.paid_total = 0;
        if (w.status === undefined) w.status = "open";
      }
      if (this.t === "park_payment_allocations") {
        // 0167's guard: the unique line per payment and bill.
        if ((db[this.t] ?? []).some((a) => a.payment_id === w.payment_id && a.charge_id === w.charge_id)) {
          this.failed = { code: "23505", message: "duplicate key value violates unique constraint park_payment_allocations_payment_id_charge_id_key" };
          return w;
        }
      }
      (db[this.t] ??= []).push(w);
      inserted.push({ ...w, __table: this.t });
      // sync_charge_paid / sync_charge_paid_from_allocation: the bill follows.
      if (this.t === "park_payments" && w.charge_id) recompute(w.charge_id as string);
      if (this.t === "park_payment_allocations") recompute(w.charge_id as string);
      return w;
    });
    if (this.failed) return this;
    this.pending = written;
    return this;
  }
  update(patch: Row) {
    if (nextUpdateError && nextUpdateError.table === this.t) {
      this.failed = nextUpdateError.error; nextUpdateError = null; return this;
    }
    if (beforeUpdate && beforeUpdate.table === this.t) {
      const act = beforeUpdate.act; beforeUpdate = null; act();
    }
    this.patch = patch; return this;
  }
  single() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  private resolve(): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> {
    if (this.failed) return Promise.resolve({ data: null, error: this.failed });
    if (this.pending) return Promise.resolve({ data: this.pending, error: null });
    if (nextReadError && nextReadError.table === this.t && !this.patch
        && (!nextReadError.column || this.cols.includes(nextReadError.column))) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    if (this.patch) {
      const hit = this.rows();
      if (this.t === "park_charges") {
        for (const r of hit) { const refused = guardVoid(r, this.patch); if (refused) return Promise.resolve({ data: null, error: refused }); }
      }
      for (const r of hit) Object.assign(r, this.patch);
      if (this.t === "park_charges") for (const r of hit) if (r.status === "void") r.paid_total = 0;
      updated.push({ table: this.t, patch: this.patch });
      // A reversed payment drops out of every bill it touched (0167's
      // widened sync_charge_paid) — its own charge and every allocated one.
      if (this.t === "park_payments") {
        for (const r of hit) {
          if (r.charge_id) recompute(r.charge_id as string);
          for (const a of (db.park_payment_allocations ?? []).filter((a) => a.payment_id === r.id)) recompute(a.charge_id as string);
        }
      }
      // sync_charge_paid_from_allocation fires on UPDATE too — a removal gives the bill its owing back.
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

let emailResult: { ok: boolean; error?: string } = { ok: true };
const emails: Array<{ to: string; subject: string }> = [];
let refundResult: { ok: boolean; ref?: string; error?: string } = { ok: false, error: "No payment processor is connected yet, so nothing was refunded." };
/** How many times the processor was asked — the money-moving fact a refund test has to pin. */
let refundAsks = 0;

// THE CLOCK IS PINNED. Both billing doors refuse a month that has not
// started (notYetBillableRefusal), and this suite bills January–April 2027
// throughout; on the real clock every one of those would be refused and
// every assertion below it would be about nothing. 15 April 2027 is on or
// after the latest month billed here. recordPayment's received_on window is
// measured from the same clock, so TODAY is what the doors are handed.
const CLOCK = "2027-04-15";
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => CLOCK,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => { opened.push(t); return new Q(t); } }),
}));
vi.mock("@/lib/rent-changes", () => ({
  applyDueRentChangesFor: async () => ({ applied: 0, skipped: [] }),
  servedRentHistory: async () => ({ byRes: new Map(), error: null }),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: async (o: { to: string; subject: string }) => { emails.push(o); return emailResult; },
}));
vi.mock("@/lib/charge-gate", () => ({
  paymentsAreLive: () => false,
  giveRefund: async () => { refundAsks += 1; return refundResult; },
}));

const {
  recordPayment, confirmClaimCollected, reversePayment, emailReceipt, refundParkPayment,
  previewChargeRun, runCharges, voidCharge, getLedger,
} = await import("./ledger-actions");

const PARK = "park-haven";
const TODAY = CLOCK;
/** The Haven's real lots — no lot 3, no lot 8. */
const HAVEN = ["1", "2", "6", "7", "9", "10", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "26"];

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  inserted.length = 0; updated.length = 0; insertCalls.length = 0; emails.length = 0; opened.length = 0;
  nextInsertError = null; nextUpdateError = null; nextAllocationError = null; nextReadError = null; beforeUpdate = null; receiptNo = 100;
  emailResult = { ok: true }; refundAsks = 0;
  db.parks = [{ id: PARK, name: "The Haven", address: "9085 E 500 S", rent_due_day: 1, cutover_date: "2027-01-01" }];
  db.park_fees = [{ park_id: PARK, label: "Grounds", amount: 142.53, cadence: "monthly", applies_to: "long_term", active: true }];
  db.park_lots = HAVEN.map((n) => ({ id: `lot-${n}`, park_id: PARK, lot_number: n, rental_mode: "long_term", lifecycle: "live" }));
  db.park_renters = HAVEN.map((n) => ({ id: `renter-${n}`, park_id: PARK, display_name: `Household ${n}`, email: `lot${n}@example.com`, contact_pref: "email" }));
  db.lot_reservations = [];
  db.park_charges = [];
  db.park_payments = [];
  db.park_payment_claims = [];
  db.park_refunds = [];
  db.lot_cost_shares = [];
  db.park_costs = [];
  db.park_payment_allocations = [];
}

/** Money on account for one lot — the row recordOnAccount writes, standing. */
function onAccount(lot: string, amount: number, receivedOn: string, over: Partial<Row> = {}): Row {
  const p: Row = {
    id: `acct-${lot}-${receivedOn}`, park_id: PARK, renter_id: `renter-${lot}`, charge_id: null, kind: "rent",
    amount, method: "check", reference: null, received_on: receivedOn, created_at: `${receivedOn}T12:00:00Z`,
    receipt_no: ++receiptNo, reversed_at: null, returned_at: null, ...over,
  };
  db.park_payments.push(p);
  return p;
}

/** A January 2027 bill for one lot, as runCharges raises it. */
function janBill(lot: string, over: Partial<Row> = {}): Row {
  const c: Row = {
    id: `charge-${lot}`, park_id: PARK, park_lot_id: `lot-${lot}`, renter_id: `renter-${lot}`,
    reservation_id: `jan-${lot}`, period_month: "2027-01", due_on: "2027-01-01",
    amount: 542.53, paid_total: 0, status: "open", ...over,
  };
  db.park_charges.push(c);
  return c;
}

const stay = (lot: string, id: string, during: string, over: Partial<Row> = {}): Row => ({
  id, park_lot_id: `lot-${lot}`, renter_id: `renter-${lot}`, during,
  quoted_amount: 400, status: "active", moved_out_on: null, due_day: null,
  origin: "application", term: "monthly", ...over,
});

beforeEach(reset);

// ---------------------------------------------------------------------------

describe("the office cannot key processor money by hand", () => {
  it("refuses `ach` BEFORE the insert, with a sentence that says what to do", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 542.53, "ach" as never, "", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only the processor writes one/);
    expect(res.error).toMatch(/record it as a bank transfer/);
    expect(res.error).not.toMatch(/try again/i);
    expect(inserted).toHaveLength(0);
  });

  it("refuses `card` the same way", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 542.53, "card" as never, "old terminal", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("and anything that is not a way money arrives", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 542.53, "zelle" as never, "", TODAY, "", "k1");
    expect(res.error).toBe("That isn't a way money arrives.");
    expect(inserted).toHaveLength(0);
  });

  it("records a bank push as `transfer` — the reversible, reference-free row", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 542.53, "transfer", "", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    expect(inserted[0].method).toBe("transfer");
    expect(inserted[0].reference).toBeNull();
    expect(res.signal).toBe("Recorded — that one's settled.");
  });

  it("names the constraint's field when the database still says no", async () => {
    // A CHECK will refuse the same row tomorrow, so "try again" is the retry
    // that can never work.
    janBill("9");
    nextInsertError = { code: "23514", message: 'new row violates check constraint "park_payments_received_on_is_sane"' };
    const res = await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/date/);
    expect(res.error).not.toMatch(/try again/i);
    nextInsertError = { code: "23514", message: 'violates check constraint "park_payments_online_has_a_reference"' };
    const r2 = await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "k2");
    expect(r2.error).toMatch(/only the processor writes one/);
  });

  it("a claim naming card or ACH is refused without pointing at a form option that no longer exists", async () => {
    janBill("9");
    db.park_payment_claims.push({
      id: "claim-1", charge_id: "charge-9", method: "ach", reference: null, resolved_at: null,
      park_charges: { park_id: PARK },
    });
    const res = await confirmClaimCollected(PARK, "claim-1", 542.53, TODAY, "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only the processor can record/);
    expect(res.error).not.toMatch(/with its reference/);
    expect(inserted).toHaveLength(0);
  });

  it("reversePayment names the rail it refuses — a bank transfer is not a card", async () => {
    db.park_payments.push({ id: "pay-ach", park_id: PARK, amount: 542.53, method: "ach", reversed_at: null, kind: "rent", charge_id: "charge-9", receipt_no: 7 });
    db.park_payments.push({ id: "pay-card", park_id: PARK, amount: 542.53, method: "card", reversed_at: null, kind: "rent", charge_id: "charge-9", receipt_no: 8 });
    const ach = await reversePayment(PARK, "pay-ach", "typo");
    expect(ach.ok).toBe(false);
    expect(ach.error).toMatch(/bank transfer/);
    expect(ach.error).not.toMatch(/paid by card/);
    expect(ach.error).toMatch(/Refund it instead/);
    const card = await reversePayment(PARK, "pay-card", "typo");
    expect(card.error).toMatch(/paid by card/);
    expect(updated).toHaveLength(0);
  });

  it("the processor's refusal is relayed with one full stop, not two", async () => {
    db.park_payments.push({ id: "pay-ach", park_id: PARK, amount: 542.53, fee_amount: null, method: "ach", reference: "ch_1", reversed_at: null, returned_at: null, kind: "rent", charge_id: "charge-9" });
    refundResult = { ok: false, error: "No payment processor is connected yet, so nothing was refunded." };
    const res = await refundParkPayment(PARK, "pay-ach", { amount: 100, feeAmount: 0, reason: "charged twice", idempotencyKey: "rk" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "The processor wouldn't return that — No payment processor is connected yet, so nothing was refunded. " +
      "Nothing has moved and nothing has been recorded.",
    );
    expect(res.error).not.toMatch(/\.\./);
  });
});

// ---------------------------------------------------------------------------

describe("more than the bill is split, not credited and not refused", () => {
  it("$600 on a $542.53 bill: the balance against the bill, the rest on account, ONE insert", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "TH-00041", "form-key");
    expect(res.ok).toBe(true);
    expect(insertCalls).toEqual([2]);          // one call, two rows — both or neither
    const bill = inserted.find((r) => r.charge_id === "charge-9")!;
    const acct = inserted.find((r) => r.charge_id === null)!;
    expect(bill.amount).toBe(542.53);
    expect(bill.idempotency_key).toBe("form-key");
    expect(bill.drop_slip_no).toBe("TH-00041");
    // The exact row recordOnAccount writes: no charge, the household, kind rent.
    expect(acct).toMatchObject({
      park_id: PARK, renter_id: "renter-9", kind: "rent", amount: 57.47,
      method: "check", reference: "1042", received_on: TODAY, idempotency_key: "form-key:onaccount",
    });
    expect(acct.confirm_token).not.toBe(bill.confirm_token);
    // The bill is settled — not "in credit".
    expect(db.park_charges[0].paid_total).toBe(542.53);
    expect(res.against).toBe(542.53);
    expect(res.onAccount).toBe(57.47);
  });

  it("says both lines, and where the second one is", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    // THE RUN APPLIES IT NOW (0167), so the sentence may say it comes off
    // February — and still names the by-hand door for a bill that already
    // exists. The promise is the shared clause (onAccountPromise), word for
    // word what the ⊕ window's note said before the tap.
    expect(res.signal).toBe(
      "$600.00 received — $542.53 against January 2027, $57.47 on account" +
      " and comes off February 2027 when you raise it — or put it against an open bill now from \"Money not against a bill\".",
    );
    expect(res.signal).not.toMatch(/credit/);
  });

  it("the receipt carries both parts, with the second receipt number", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.receipt?.amount).toBe(600);
    expect(res.receipt?.onAccount).toEqual({ amount: 57.47, receiptNo: 102 });
    expect(res.receipt?.receiptNo).toBe(101);
    expect(res.receipt?.balanceAfter).toBe(0);
    const body = receiptBody(res.receipt!);
    expect(body).toMatch(/Amount\s+\$600\.00/);
    expect(body).toMatch(/to this bill\s+\$542\.53/);
    expect(body).toMatch(/on account\s+\$57\.47/);
    expect(body).toMatch(/nothing further owing on this one/);
    // A promise the software now keeps (0167): the run applies it.
    expect(body).toMatch(/held by the office and comes off your next/);
    expect(body).toMatch(/TH-\d{4}-0102/);
    expect(body).not.toMatch(/In credit/);
    expect(body).not.toMatch(/hasn't been put/);
  });

  it("an exact payment is one row and one receipt, as before", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "form-key");
    expect(insertCalls).toEqual([1]);
    expect(res.receipt?.onAccount).toBeNull();
    expect(receiptBody(res.receipt!)).not.toMatch(/on account/);
  });

  it("a part payment is one row against the bill", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(insertCalls).toEqual([1]);
    expect(res.signal).toBe("Recorded. $342.53 still outstanding.");
  });

  it("a twin submit collides on both rows and is reported as already recorded", async () => {
    janBill("9");
    nextInsertError = { code: "23505", message: "duplicate key value violates unique constraint park_payments_idempotency_idx" };
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.error).toMatch(/already recorded/);
  });

  it("with no household on the bill the excess has nowhere to sit — say where each part goes", async () => {
    janBill("9", { renter_id: null });
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\$542\.53 against it/);
    expect(res.error).toMatch(/Money not against a bill/);
    expect(inserted).toHaveLength(0);
  });

  it("covers the claim door for free — a confirmed $600 claim is split the same way", async () => {
    janBill("9");
    db.park_payment_claims.push({
      id: "claim-1", charge_id: "charge-9", method: "transfer", reference: "Zelle", resolved_at: null,
      park_charges: { park_id: PARK },
    });
    const res = await confirmClaimCollected(PARK, "claim-1", 600, TODAY, "claim-key");
    expect(res.ok).toBe(true);
    expect(insertCalls).toEqual([2]);
    expect(inserted.find((r) => r.charge_id === null)).toMatchObject({ amount: 57.47, method: "transfer", idempotency_key: "claim-key:onaccount" });
    // Landed against the charge, so 0074's trigger answers the claim; nothing
    // here has to.
    expect(updated.filter((u) => u.table === "park_payment_claims")).toHaveLength(0);
  });

  it("a claim confirmed on a bill already settled lands on account AND is still answered", async () => {
    // The trigger keys on the charge the row was recorded against; this one
    // was recorded against none. Without this the claim stays open forever on
    // a settled bill, and the only two answers left are both wrong.
    janBill("9", { paid_total: 542.53, status: "paid" });
    db.park_payment_claims.push({
      id: "claim-1", charge_id: "charge-9", method: "cash", reference: null, resolved_at: null,
      park_charges: { park_id: PARK },
    });
    const res = await confirmClaimCollected(PARK, "claim-1", 57.47, TODAY, "claim-key");
    expect(res.ok).toBe(true);
    expect(insertCalls).toEqual([1]);
    expect(inserted[0]).toMatchObject({ charge_id: null, kind: "rent", amount: 57.47 });
    const closed = updated.find((u) => u.table === "park_payment_claims");
    expect(closed?.patch).toMatchObject({ resolution: "matched" });
    expect(String(closed?.patch.resolution_note)).toMatch(/already settled/);
    // The on-account row says which shape this is, not "the bill took $0.00".
    expect(String(inserted[0].note)).toBe("The January 2027 bill was already settled, so all $57.47 is on account.");
    expect(String(inserted[0].note)).not.toMatch(/\$0\.00/);
    expect(res.signal).not.toMatch(/claim/);
  });

  it("a claim the money could not close is named in the sentence, never swallowed", async () => {
    // The money is recorded either way — telling the office it failed is how
    // the same cash gets keyed twice. But the claim is still open, the bill
    // still reads disputed and nothing chases it, and "received… on account"
    // alone renders that failed write as success.
    janBill("9", { paid_total: 542.53, status: "paid" });
    db.park_payment_claims.push({
      id: "claim-1", charge_id: "charge-9", method: "cash", reference: null, resolved_at: null,
      park_charges: { park_id: PARK },
    });
    nextUpdateError = { table: "park_payment_claims", error: { code: "57P01", message: "terminating connection" } };
    const res = await confirmClaimCollected(PARK, "claim-1", 57.47, TODAY, "claim-key");
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(db.park_payment_claims[0].resolved_at).toBeNull();
    expect(res.signal).toMatch(/\$57\.47 received — January 2027 was already settled, so all of it is on account and comes off February 2027 when you raise it — or put it against an open bill now from "Money not against a bill"\./);
    expect(res.signal).toMatch(/The claim it answers is still open — we couldn't close it; answer it from the ledger\.$/);
  });

  it("the slip serial rides on the only row there is", async () => {
    // On a settled bill the on-account row is the only row, and the serial
    // off the drop slip was written to a bill row that did not exist.
    janBill("9", { paid_total: 542.53, status: "paid" });
    const res = await recordPayment(PARK, "charge-9", 57.47, "check", "1042", TODAY, "TH-00041", "form-key");
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ charge_id: null, drop_slip_no: "TH-00041" });
    // And on a split it stays on the bill's row, once.
    reset(); janBill("9");
    await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "TH-00042", "form-key");
    expect(inserted.find((r) => r.charge_id === "charge-9")!.drop_slip_no).toBe("TH-00042");
    expect(inserted.find((r) => r.charge_id === null)!.drop_slip_no).toBeUndefined();
  });

  it("a figure that rounds to no cents is refused, not 'Recorded' about nothing", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 0.004, "cash", "", TODAY, "", "form-key");
    expect(res.ok).toBe(false);
    // 0.004 IS a number; the first sentence here said it wasn't.
    expect(res.error).toBe("That payment amount is less than a cent.");
    expect(insertCalls).toEqual([]);
  });

  it("each bad amount is told what is wrong with IT", async () => {
    janBill("9");
    const cases: Array<[number, string]> = [
      [Number.NaN, "That payment amount isn't a number."],
      [-5, "That payment amount needs to be more than zero."],
      [0, "That payment amount needs to be more than zero."],
    ];
    for (const [bad, sentence] of cases) {
      const res = await recordPayment(PARK, "charge-9", bad, "cash", "", TODAY, "", "form-key");
      expect(res.ok).toBe(false);
      expect(res.error, String(bad)).toBe(sentence);
    }
    expect(insertCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("emailing a receipt says why it didn't go", () => {
  const receipt = {
    parkName: "The Haven", officeLine: "Questions? Ask at the office.", receiptNo: 101, lotNumber: "7",
    payerName: "Household 7", amount: 542.53, method: "check", reference: "1042", receivedOn: TODAY,
    periodMonth: "2027-01", billAmount: 542.53, balanceAfter: 0,
  };

  it("passes the hold he set through, word for word", async () => {
    emailResult = { ok: false, error: "Notices are on hold for this park — Held on setup — lift it when the roll is loaded and the leases are executed." };
    const res = await emailReceipt(PARK, "lot7@example.com", receipt);
    expect(res.ok).toBe(false);
    expect(res.error).toBe(emailResult.error);
    expect(res.error).not.toMatch(/check the address/i);
  });

  it("says when we could not tell, which is not the same as the address being wrong", async () => {
    emailResult = { ok: false, error: "We couldn't check whether this park is holding notices, so nothing was sent. Try again in a minute." };
    const res = await emailReceipt(PARK, "lot7@example.com", receipt);
    expect(res.error).toMatch(/^We couldn't check whether/);
  });

  it("labels a transport failure as the technical thing it is", async () => {
    emailResult = { ok: false, error: "Resend 503: upstream unavailable" };
    const res = await emailReceipt(PARK, "lot7@example.com", receipt);
    expect(res.error).toBe("The email didn't go — Resend 503: upstream unavailable");
  });

  it("still sends when nothing refuses", async () => {
    const res = await emailReceipt(PARK, "lot7@example.com", receipt);
    expect(res.ok).toBe(true);
    expect(emails[0].subject).toBe("The Haven — receipt for $542.53");
  });
});

// ---------------------------------------------------------------------------

describe("both billing doors sort their skips the same way", () => {
  const JAN = "[2027-01-01,2027-02-01)";
  const FEB = "[2027-02-01,2027-03-01)";

  it("none renewed on 1 February: the preview names the cause and has nothing to raise", async () => {
    db.lot_reservations = HAVEN.map((n) => stay(n, `jan-${n}`, JAN));
    const res = await previewChargeRun(PARK, "2027-02");
    expect(res.ok).toBe(true);
    expect(res.plan!.toBill).toHaveLength(0);
    expect(res.plan!.expired).toEqual(HAVEN);
    expect(res.plan!.noRent).toEqual([]);
    expect(runSummary(res.plan!, "2027-02")).toMatch(/18 agreements have run out \(lot 1, lot 2, lot 6 and 15 more\)/);
  });

  it("…and the run refuses with the same sentence", async () => {
    db.lot_reservations = HAVEN.map((n) => stay(n, `jan-${n}`, JAN));
    const res = await runCharges(PARK, "2027-02");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "Nothing to bill for February 2027 — 18 agreements have run out (lot 1, lot 2, lot 6 and 15 more). " +
      "Nobody moved out; the paperwork ended. Renew them and run this again.",
    );
    expect(db.park_charges).toHaveLength(0);
  });

  it("ten renewed: both doors bill ten and name the eight that ran out", async () => {
    db.lot_reservations = [
      ...HAVEN.map((n) => stay(n, `jan-${n}`, JAN)),
      ...HAVEN.slice(0, 10).map((n) => stay(n, `feb-${n}`, FEB)),
    ];
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.plan!.toBill).toHaveLength(10);
    expect(pre.plan!.expired).toEqual(HAVEN.slice(10));
    expect(runSummary(pre.plan!, "2027-02")).toBe("Bill 10 households for February 2027 — $5,425.30 · 8 agreements have run out");

    const run = await runCharges(PARK, "2027-02");
    expect(run.ok).toBe(true);
    expect(run.raised).toBe(10);
    expect(db.park_charges.map((c) => c.reservation_id)).toEqual(HAVEN.slice(0, 10).map((n) => `feb-${n}`));
    expect(db.park_charges.every((c) => c.amount === 542.53)).toBe(true);
  });

  it("all renewed: no skip anywhere, and the second run finds nothing to do", async () => {
    db.lot_reservations = [
      ...HAVEN.map((n) => stay(n, `jan-${n}`, JAN)),
      ...HAVEN.map((n) => stay(n, `feb-${n}`, FEB)),
    ];
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(runSummary(pre.plan!, "2027-02")).toBe("Bill 18 households for February 2027 — $9,765.54");
    const run = await runCharges(PARK, "2027-02");
    expect(run.raised).toBe(18);
    // The January rows are still active — renewals never end them — and must
    // not be "run out" now that February is billed.
    const again = await previewChargeRun(PARK, "2027-02");
    expect(again.plan!.expired).toEqual([]);
    expect(runSummary(again.plan!, "2027-02")).toBe("Nothing to bill for February 2027 — 18 bills are already raised.");
  });

  it("a tenancy filed as paid yearly is never billed its yearly figure as a month", async () => {
    db.lot_reservations = [
      stay("1", "feb-1", FEB),
      stay("9", "feb-9", FEB, { term: "annual", quoted_amount: 3600 }),
    ];
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.plan!.toBill.map((b) => b.lotNumber)).toEqual(["1"]);
    expect(pre.plan!.notMonthly).toEqual([{ lotNumber: "9", term: "annual" }]);
    expect(pre.plan!.total).toBe(542.53);

    const run = await runCharges(PARK, "2027-02");
    expect(run.raised).toBe(1);
    expect(db.park_charges.map((c) => c.park_lot_id)).toEqual(["lot-1"]);
  });

  it("…and alone it is the whole reason the run refuses, named by lot", async () => {
    db.lot_reservations = [stay("9", "feb-9", FEB, { term: "annual", quoted_amount: 3600 })];
    const run = await runCharges(PARK, "2027-02");
    expect(run.ok).toBe(false);
    expect(run.error).toBe(
      "Nothing to bill for February 2027 — Lot 9 is filed as paid yearly — the run bills months only — " +
      "change how it's paid to monthly from Edit on the roll and type the monthly rent.",
    );
  });
});

// ---------------------------------------------------------------------------
// A MONTH THAT HAS NOT STARTED IS NOT BILLED EARLY. The rent screen stops
// its forward link at the current month on purpose; a typed `?month=`
// reached both actions with no rule behind it and raised February on 28
// January. Pinned both ways: the clock is 15 April 2027, so May refuses and
// April (and every month back to go-live) still raises.
// ---------------------------------------------------------------------------
describe("both billing doors refuse a month that has not started", () => {
  const MAY = "[2027-05-01,2027-06-01)";
  const APR = "[2027-04-01,2027-05-01)";

  it("the preview refuses May on 15 April with the one sentence, and reads nothing else", async () => {
    db.lot_reservations = [stay("9", "may-9", MAY)];
    const res = await previewChargeRun(PARK, "2027-05");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("May 2027 hasn't started — bill it on the 1st.");
    expect(res.plan).toBeUndefined();
  });

  it("the run refuses it too, and writes nothing", async () => {
    db.lot_reservations = [stay("9", "may-9", MAY)];
    const res = await runCharges(PARK, "2027-05");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("May 2027 hasn't started — bill it on the 1st.");
    expect(db.park_charges).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("a month neither door can read is refused with a sentence, and the insert is never reached", async () => {
    // `2027-4` passed the go-live string compare and reached the insert,
    // where 0070's CHECK on period_month refused it as a raw constraint
    // error — the only refusal it had.
    db.lot_reservations = [stay("9", "apr-9", APR)];
    const pre = await previewChargeRun(PARK, "2027-4");
    expect(pre.ok).toBe(false);
    expect(pre.error).toBe("That isn't a month — use the month links to pick one.");
    const run = await runCharges(PARK, "2027-4");
    expect(run.ok).toBe(false);
    expect(run.error).toBe("That isn't a month — use the month links to pick one.");
    expect(inserted).toHaveLength(0);
  });

  it("the current month still raises — collapsed the other way", async () => {
    db.lot_reservations = [stay("9", "apr-9", APR)];
    const pre = await previewChargeRun(PARK, "2027-04");
    expect(pre.ok).toBe(true);
    expect(pre.plan!.toBill).toHaveLength(1);
    const run = await runCharges(PARK, "2027-04");
    expect(run.ok).toBe(true);
    expect(run.raised).toBe(1);
  });

  it("is the same helper in both doors, beside the go-live refusal", () => {
    const src = readFileSync(join(process.cwd(), "src/app/park/ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const calls = src.match(/notYetBillableRefusal\(month, todayLakeDate\(\), prettyMonth\)/g) ?? [];
    expect(calls).toHaveLength(2);
    const preview = src.slice(src.indexOf("export async function previewChargeRun"), src.indexOf("export async function runCharges"));
    const run = src.slice(src.indexOf("export async function runCharges"), src.indexOf("function paymentRefusedSentence"));
    for (const fn of [preview, run]) {
      expect(fn.indexOf("preCutoverRefusal(")).toBeGreaterThan(0);
      expect(fn.indexOf("notYetBillableRefusal(")).toBeGreaterThan(fn.indexOf("preCutoverRefusal("));
      expect(fn.indexOf("notYetBillableRefusal(")).toBeLessThan(fn.indexOf('.from("park_lots")'));
    }
  });
});

// ---------------------------------------------------------------------------
// MONEY ON ACCOUNT COMES OFF THE NEXT BILLS (0167) — decision three, verbatim:
// "need it applied to the months if there is a prepay."
//
// The real preview and run against the fake, which models the allocations
// table, the on-account view and the recompute trigger. Nothing here copies
// planAllocations; the numbers are checked against the owner's own example.
// ---------------------------------------------------------------------------
describe("the run puts money on account against the bills it raises", () => {
  const JAN = "[2027-01-01,2027-02-01)";
  const FEB = "[2027-02-01,2027-03-01)";
  const MAR = "[2027-03-01,2027-04-01)";
  const APR = "[2027-04-01,2027-05-01)";
  const allocs = () => db.park_payment_allocations;

  it("a quarter paid ahead settles January, February and March exactly, and April gets nothing", async () => {
    db.lot_reservations = [stay("7", "q-7", "[2027-01-01,2027-05-01)")];
    onAccount("7", 1627.59, "2026-12-28");
    for (const m of ["2027-01", "2027-02", "2027-03"]) {
      const res = await runCharges(PARK, m);
      expect(res.ok, m).toBe(true);
      expect(res.signal).toContain(`1 bill raised for ${prettyMonth(m)} — $542.53, $542.53 of it settled from money on account.`);
      const bill = db.park_charges.find((c) => c.period_month === m)!;
      expect(bill.paid_total).toBe(542.53);
      expect(bill.status).toBe("paid");
    }
    expect(allocs()).toHaveLength(3);
    expect(allocs().every((a) => a.applied_via === "run" && a.applied_by === null && a.payment_id === "acct-7-2026-12-28")).toBe(true);
    // Spent. April is a real bill, owed in full, and the sentence does not
    // claim otherwise.
    const apr = await runCharges(PARK, "2027-04");
    expect(apr.signal).toBe("1 bill raised for April 2027 — $542.53. Nobody has been told.");
    expect(db.park_charges.find((c) => c.period_month === "2027-04")!.paid_total).toBe(0);
    expect(allocs()).toHaveLength(3);
  });

  it("the preview says what will come off, per household and in total, from the same plan the run applies", async () => {
    db.lot_reservations = HAVEN.map((n) => stay(n, `feb-${n}`, FEB));
    onAccount("7", 1085.06, "2026-12-28");
    onAccount("9", 200, "2027-01-15");
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.ok).toBe(true);
    expect(pre.plan!.fromOnAccount).toBe(742.53);
    expect(pre.plan!.toBill.find((b) => b.lotNumber === "7")!.fromOnAccount).toBe(542.53);
    expect(pre.plan!.toBill.find((b) => b.lotNumber === "9")!.fromOnAccount).toBe(200);
    expect(pre.plan!.toBill.find((b) => b.lotNumber === "1")!.fromOnAccount).toBe(0);
    expect(runSummary(pre.plan!, "2027-02")).toBe("Bill 18 households for February 2027 — $9,765.54, $742.53 of it already on account");
    expect(db.park_payment_allocations, "a preview writes nothing").toHaveLength(0);

    const run = await runCharges(PARK, "2027-02");
    expect(run.signal).toContain("18 bills raised for February 2027 — $9,765.54, $742.53 of it settled from money on account.");
    expect(allocs().map((a) => [a.charge_id, a.amount])).toEqual([
      [db.park_charges.find((c) => c.park_lot_id === "lot-7")!.id, 542.53],
      [db.park_charges.find((c) => c.park_lot_id === "lot-9")!.id, 200],
    ]);
    expect(db.park_charges.find((c) => c.park_lot_id === "lot-7")!.status).toBe("paid");
    const nine = db.park_charges.find((c) => c.park_lot_id === "lot-9")!;
    expect(nine.paid_total).toBe(200);
    expect(nine.status).toBe("open");
  });

  it("oldest money first, and the household's pool is shared across the run", async () => {
    db.lot_reservations = [stay("7", "feb-7", FEB)];
    onAccount("7", 100, "2027-01-20");
    onAccount("7", 500, "2026-12-28");
    await runCharges(PARK, "2027-02");
    expect(allocs().map((a) => [a.payment_id, a.amount])).toEqual([
      ["acct-7-2026-12-28", 500],
      ["acct-7-2027-01-20", 42.53],
    ]);
  });

  it("a refused allocation is named by lot; the bill stands and the money stays on account", async () => {
    db.lot_reservations = [stay("7", "feb-7", FEB), stay("9", "feb-9", FEB)];
    onAccount("7", 542.53, "2026-12-28");
    onAccount("9", 542.53, "2026-12-28");
    nextAllocationError = { after: 1, error: { code: "P0001", message: "park_payment_allocations: that bill only has 0.00 left on it, and this would apply 542.53" } };
    const run = await runCharges(PARK, "2027-02");
    expect(run.ok).toBe(true);
    expect(run.raised).toBe(2);
    expect(run.signal).toContain("2 bills raised for February 2027 — $1,085.06, $542.53 of it settled from money on account.");
    expect(run.signal).toContain("⚠️ $542.53 of Lot 9's money on account couldn't be put against its bill — the bill stands and the money stays on account; apply it from \"Money not against a bill\".");
    expect(db.park_charges.find((c) => c.park_lot_id === "lot-9")!.status).toBe("open");
    expect(allocs()).toHaveLength(1);
  });

  it("a failed read of the money on account is said, not rendered as 'nothing on account'", async () => {
    db.lot_reservations = [stay("7", "feb-7", FEB)];
    onAccount("7", 542.53, "2026-12-28");
    // The preview refuses outright rather than promising the full figure…
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.ok).toBe(false);
    expect(pre.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError, "the on-account read never happened").toBeNull();
    // …and the run, which has already raised the bills by then, says so.
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    const run = await runCharges(PARK, "2027-02");
    expect(run.ok).toBe(true);
    expect(run.signal).toContain("⚠️ We couldn't read the money households have on account, so no money on account was put against these bills");
    expect(run.signal).not.toContain("settled from money on account");
    expect(allocs()).toHaveLength(0);
    expect(db.park_charges).toHaveLength(1);
  });

  it("a household with nothing on account is billed exactly as before", async () => {
    db.lot_reservations = [stay("1", "feb-1", FEB), stay("9", "feb-9", FEB)];
    const run = await runCharges(PARK, "2027-02");
    expect(run.signal).toBe("2 bills raised for February 2027 — $1,085.06. Nobody has been told.");
    expect(allocs()).toHaveLength(0);
  });

  it("the excess over January goes against February on February's run, not on January's", async () => {
    db.lot_reservations = [stay("9", "y-9", "[2027-01-01,2027-04-01)"), stay("1", "y-1", JAN), stay("2", "y-2", MAR), stay("6", "y-6", APR)];
    await runCharges(PARK, "2027-01");
    const jan = db.park_charges.find((c) => c.park_lot_id === "lot-9")!;
    await recordPayment(PARK, jan.id as string, 600, "check", "1042", TODAY, "", "form-key");
    expect(allocs(), "the $57.47 is not put against the bill it came in over").toHaveLength(0);
    const feb = await runCharges(PARK, "2027-02");
    expect(feb.signal).toContain("$57.47 of it settled from money on account");
    const febBill = db.park_charges.find((c) => c.park_lot_id === "lot-9" && c.period_month === "2027-02")!;
    expect(febBill.paid_total).toBe(57.47);
  });
});

describe("a household with money on account who pays again", () => {
  it("recordPayment puts their money on account against the rest, and says so on the paper", async () => {
    janBill("9");
    onAccount("9", 342.53, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations).toEqual([
      expect.objectContaining({ payment_id: "acct-9-2026-12-28", charge_id: "charge-9", amount: 342.53, applied_via: "office", applied_by: "owner-1" }),
    ]);
    expect(db.park_charges[0].paid_total).toBe(542.53);
    expect(db.park_charges[0].status).toBe("paid");
    expect(res.signal).toBe("Recorded, and $342.53 they had on account went against it too — that one's settled.");
    expect(res.receipt?.fromOnAccount).toBe(342.53);
    expect(res.receipt?.balanceAfter).toBe(0);
    const body = receiptBody(res.receipt!);
    expect(body).toMatch(/Amount\s+\$200\.00/);
    expect(body).toMatch(/From on account \$342\.53/);
    expect(body).toContain("$342.53 you already had on account with the office went against this");
    expect(body).toMatch(/nothing further owing on this one/);
  });

  it("a bill part-paid from money on account on an EARLIER day: the paper still names it", async () => {
    // $200 of money on account went against January on the 3rd; on the 6th
    // the household hands over $342.53. Nothing is applied inside this call
    // (paid_total already held the $200), so the receipt read "Amount $342.53
    // / Against January rent — $542.53 / nothing further owing" with no line
    // explaining the difference — on the only copy a paper household keeps.
    janBill("9", { paid_total: 200 });
    const early = onAccount("9", 200, "2026-12-28");
    db.park_payment_allocations.push({ id: "al-early", park_id: PARK, payment_id: early.id, charge_id: "charge-9", amount: 200, applied_via: "office", applied_at: "2027-01-03T15:00:00Z", removed_at: null });
    const res = await recordPayment(PARK, "charge-9", 342.53, "cash", "", TODAY, "", "form-key");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations, "nothing new applied — the $200 was already on it").toHaveLength(1);
    // The toast is about THIS act, and this act applied nothing.
    expect(res.signal).toBe("Recorded — that one's settled.");
    // The paper is about the bill, and the bill has $200 of their money on it.
    expect(res.receipt?.fromOnAccount).toBe(200);
    expect(res.receipt?.balanceAfter).toBe(0);
    const body = receiptBody(res.receipt!);
    expect(body).toMatch(/From on account \$200\.00/);
    expect(body).toContain("$200.00 you already had on account with the office went against this");
    expect(body).toMatch(/nothing further owing on this one/);
    // A line the office took back off the bill, and a line from a bounced
    // cheque, are not money on the bill.
    db.park_payment_allocations[0].removed_at = "2027-01-04T00:00:00Z";
    const res2 = await recordPayment(PARK, "charge-9", 0.01, "cash", "", TODAY, "", "form-key-2");
    expect(res2.receipt?.fromOnAccount).toBeNull();
  });

  it("the same-day case reads the same: what settleOnAccount just applied is on the bill too", async () => {
    janBill("9");
    onAccount("9", 342.53, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(res.receipt?.fromOnAccount).toBe(342.53);
    // And a failed read of the bill's lines degrades to the same-call figure — the money is recorded.
    janBill("14");
    onAccount("14", 100, "2026-12-28");
    nextReadError = { table: "park_payment_allocations", column: "charge_id", error: { code: "57P01", message: "terminating connection" } };
    const res2 = await recordPayment(PARK, "charge-14", 200, "cash", "", TODAY, "", "form-key-14");
    expect(res2.ok).toBe(true);
    expect(res2.receipt?.fromOnAccount).toBe(100);
  });

  it("only as much as the bill still needs; the rest stays on account", async () => {
    janBill("9");
    onAccount("9", 1000, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(db.park_payment_allocations[0].amount).toBe(342.53);
    expect(res.signal).toBe("Recorded, and $342.53 they had on account went against it too — that one's settled.");
  });

  it("when even that leaves some owing, the sentence says how much", async () => {
    janBill("9");
    onAccount("9", 100, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(res.signal).toBe("Recorded, and $100.00 they had on account went against it too — $242.53 still outstanding.");
  });

  it("a payment that settles the bill on its own touches nothing on account", async () => {
    janBill("9");
    onAccount("9", 500, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "form-key");
    expect(db.park_payment_allocations).toHaveLength(0);
    expect(res.signal).toBe("Recorded — that one's settled.");
    expect(res.receipt?.fromOnAccount).toBeNull();
  });

  it("the excess of a split is never put against the very bill it came in over", async () => {
    janBill("9");
    await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(db.park_payment_allocations).toHaveLength(0);
  });

  it("a confirmed claim goes through the same door", async () => {
    janBill("9");
    onAccount("9", 342.53, "2026-12-28");
    db.park_payment_claims.push({ id: "claim-1", charge_id: "charge-9", method: "cash", reference: null, resolved_at: null, park_charges: { park_id: PARK } });
    const res = await confirmClaimCollected(PARK, "claim-1", 200, TODAY, "claim-key");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations).toHaveLength(1);
    expect(db.park_charges[0].status).toBe("paid");
  });

  it("a refused allocation is named — the money is recorded, the sentence is not 'settled'", async () => {
    janBill("9");
    onAccount("9", 342.53, "2026-12-28");
    nextAllocationError = { after: 0, error: { code: "P0001", message: "park_payment_allocations: only 0.00 is left on that payment, and this would apply 342.53" } };
    const res = await recordPayment(PARK, "charge-9", 200, "cash", "", TODAY, "", "form-key");
    expect(res.ok).toBe(true);
    expect(inserted.filter((r) => r.__table === "park_payments")).toHaveLength(1);
    expect(res.signal).toBe("Recorded. $342.53 still outstanding. ⚠️ $342.53 of their money on account couldn't be put against a bill — it stays on account.");
  });
});

/**
 * THE POST-TAP SENTENCE AGREES WITH THE PRE-TAP NOTE. The ⊕ window's note
 * keys "comes off their next bill" on lib/tenancy-facts; this door's toast
 * said it to everybody — so a household who had moved out with their final
 * month billed read "theirs to have back" on the note and "comes off
 * February 2027 when you raise it" on the toast, about the same $57.47, in
 * the same minute. Three shapes on both branches of the toast (the excess
 * untouched; some of it gone onto an older bill), the fact read ONCE and
 * only when there is excess to promise about, and a failed read making no
 * promise at all.
 */
describe("recordPayment's promise about the excess is decided on the tenancy", () => {
  const DOOR = "\"Money not against a bill\"";
  /** Moved out 15 January, the January part month billed and paid: nothing more bills for them. */
  const departed = () => {
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-01-16)", { status: "ended", moved_out_on: "2027-01-15" })];
    db.park_charges.push({ id: "charge-jan-part", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2027-01", due_on: "2027-01-01", amount: 262.51, paid_total: 262.51, status: "paid" });
  };
  /** The bill the cheque is keyed against — December, raised by hand, still open. */
  const decBill = (over: Partial<Row> = {}) => janBill("9", { id: "charge-dec", period_month: "2026-12", due_on: "2026-12-01", reservation_id: "jan-9", ...over });
  const reads = (table: string) => opened.filter((t) => t === table).length;

  it("departed, final month billed: theirs to have back — never 'comes off', on both branches", async () => {
    departed();
    decBill();
    const res = await recordPayment(PARK, "charge-dec", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      `$600.00 received — $542.53 against December 2026, $57.47 on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`,
    );
    expect(res.signal).not.toMatch(/comes off|when you raise it/);
    expect(reads("lot_reservations"), "the fact is read once").toBe(1);

    // The other branch: an older bill still open takes $40 of the excess,
    // and what is left is theirs to have back.
    reset(); departed();
    decBill();
    db.park_charges.push({ id: "charge-nov", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2026-11", due_on: "2026-11-01", amount: 40, paid_total: 0, status: "open" });
    const older = await recordPayment(PARK, "charge-dec", 600, "check", "1042", TODAY, "", "form-key");
    expect(older.ok, older.error).toBe(true);
    expect(older.signal).toBe(
      `$600.00 received — $542.53 against December 2026, $57.47 on account. Of that, $40.00 went against November 2026 — $17.47 stays on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`,
    );
    expect(older.signal).not.toMatch(/comes off|when you raise it/);
  });

  it("still here: it comes off the month after this bill — the same words the window's note said before the tap", async () => {
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-06-01)")];
    decBill();
    const res = await recordPayment(PARK, "charge-dec", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      `$600.00 received — $542.53 against December 2026, $57.47 on account and comes off January 2027 when you raise it — or put it against an open bill now from ${DOOR}.`,
    );
    expect(res.signal).not.toMatch(/theirs to have back|nothing more bills/);
    expect(reads("lot_reservations")).toBe(1);
  });

  it("the tenancy could not be read: the money is on account and NO promise is made either way", async () => {
    departed();
    decBill();
    nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
    const res = await recordPayment(PARK, "charge-dec", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok, "the money is recorded; a failed read of the fact cannot refuse it").toBe(true);
    expect(nextReadError, "the tenancy read happened").toBeNull();
    expect(res.signal).toBe("$600.00 received — $542.53 against December 2026, $57.47 on account.");
    expect(res.signal).not.toMatch(/comes off|theirs to have back|nothing more bills|Money not against a bill/);
    expect(inserted.filter((r) => r.__table === "park_payments")).toHaveLength(2);

    // The older-bill branch, unread: the figure, and where it went, and nothing promised.
    reset(); departed();
    decBill();
    db.park_charges.push({ id: "charge-nov", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2026-11", due_on: "2026-11-01", amount: 40, paid_total: 0, status: "open" });
    nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
    const older = await recordPayment(PARK, "charge-dec", 600, "check", "1042", TODAY, "", "form-key");
    expect(older.signal).toBe("$600.00 received — $542.53 against December 2026, $57.47 on account. Of that, $40.00 went against November 2026 — $17.47 stays on account.");
  });

  it("an exact or part payment has no excess to promise about, and does not read the tenancy at all", async () => {
    departed();
    decBill();
    await recordPayment(PARK, "charge-dec", 542.53, "check", "1042", TODAY, "", "form-key");
    expect(reads("lot_reservations")).toBe(0);
    reset(); departed(); decBill();
    const part = await recordPayment(PARK, "charge-dec", 200, "cash", "", TODAY, "", "form-key");
    expect(part.signal).toBe("Recorded. $342.53 still outstanding.");
    expect(reads("lot_reservations")).toBe(0);
  });

  it("is the shared clause, from the one helper — no private copy of the promise in this door", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("export async function recordPayment(");
    expect(at, "recordPayment is gone — this scan measures nothing").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport async function ", at + 1));
    expect(body.length).toBeGreaterThan(2000);
    expect(body).toMatch(/nothingMoreBills\(\(await tenancyFactsFor\(admin, \[renterId\]\)\)\.get\(renterId\)\)/);
    expect(body.match(/onAccountPromise\(nothingMore/g)).toHaveLength(2);
    expect(body).not.toMatch(/comes off \$\{nextLabel\}|when you raise it|theirs to have back/);
    expect(src).toMatch(/onAccountPromise,?\s/);
  });
});

/**
 * THE LEDGER ROWS CARRY WHAT THE RECORD-PAYMENT FORM HAS TO KNOW, from the
 * ⊕ window's own readers — never heldOnAccountFor, whose figure carries
 * deposits. A failed read of the money on account throws the way every
 * read in this loader does; a failed read of the tenancy leaves the page
 * standing with no promise for anybody.
 */
describe("getLedger carries each household's money facts on its rows", () => {
  const facts = (rows: Awaited<ReturnType<typeof getLedger>>, id: string) => {
    const r = rows!.rows.find((x) => x.id === id)!;
    return { onAccount: r.onAccount, openCount: r.openCount, nothingMoreBills: r.nothingMoreBills };
  };

  it("money on account is the view's remaining, summed per household — deposits never count", async () => {
    janBill("9"); janBill("14");
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-06-01)"), stay("14", "jan-14", "[2026-06-01,2027-06-01)")];
    onAccount("9", 200, "2026-12-28");
    onAccount("9", 342.53, "2027-01-03");
    // A deposit sits on the same household and must not read as rent money.
    db.park_payments.push({ id: "dep-9", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    const page = await getLedger(PARK, "2027-01");
    expect(facts(page, "charge-9")).toEqual({ onAccount: 542.53, openCount: 1, nothingMoreBills: false });
    expect(facts(page, "charge-14")).toEqual({ onAccount: 0, openCount: 1, nothingMoreBills: false });
  });

  it("open bills are counted across every month, not the ledger's one — the older bill decides where an over-payment goes", async () => {
    janBill("9");
    db.park_charges.push({ id: "charge-dec", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2026-12", due_on: "2026-12-01", amount: 542.53, paid_total: 0, status: "open" });
    db.park_charges.push({ id: "charge-nov", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2026-11", due_on: "2026-11-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-06-01)")];
    const page = await getLedger(PARK, "2027-01");
    expect(page!.rows.map((r) => r.id)).toEqual(["charge-9"]);
    expect(facts(page, "charge-9").openCount).toBe(2);
  });

  it("whether anything more bills is the shared fact, both ways", async () => {
    janBill("9", { reservation_id: "jan-9" });
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-01-16)", { status: "ended", moved_out_on: "2027-01-15" })];
    expect(facts(await getLedger(PARK, "2027-01"), "charge-9").nothingMoreBills).toBe(true);
    // The same household with a February link still to come: a next bill is coming.
    db.lot_reservations.push(stay("9", "feb-9", "[2027-02-01,2027-08-01)", { status: "approved" }));
    expect(facts(await getLedger(PARK, "2027-01"), "charge-9").nothingMoreBills).toBe(false);
  });

  it("a failed read of the tenancy leaves the page standing with NO promise on any row; a failed read of the money on account throws", async () => {
    janBill("9"); janBill("14");
    db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-06-01)")];
    onAccount("9", 200, "2026-12-28");
    nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
    const page = await getLedger(PARK, "2027-01");
    expect(nextReadError).toBeNull();
    expect(page!.rows.map((r) => r.nothingMoreBills)).toEqual([null, null]);
    // What is owed and held is still right.
    expect(facts(page, "charge-9").onAccount).toBe(200);

    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    await expect(getLedger(PARK, "2027-01")).rejects.toThrow(/the money households have on account/);
    nextReadError = { table: "park_charges", column: "status", error: { code: "57P01", message: "terminating connection" } };
    await expect(getLedger(PARK, "2027-01")).rejects.toThrow(/the bills still open/);
  });

  it("reads the window's readers, never heldOnAccountFor", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf("export async function getLedger(");
    expect(at, "getLedger is gone — this scan measures nothing").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport ", at + 1));
    expect(body.length).toBeGreaterThan(1500);
    expect(body).toMatch(/await onAccountSources\(admin, parkId, renterIds\)/);
    expect(body).toMatch(/await openBillsFor\(admin, parkId, renterIds\)/);
    expect(body).toMatch(/await tenancyFactsFor\(admin, renterIds, today\)/);
    expect(body).toMatch(/toRows\(charges, today, lagDays, claimed, householdMoney\)/);
    expect(body).not.toMatch(/heldOnAccountFor/);
  });
});

describe("taking back money that had been put against bills", () => {
  it("reversing a quarter-ahead cheque reopens all three months and names them", async () => {
    db.lot_reservations = [stay("7", "q-7", "[2027-01-01,2027-05-01)")];
    const ahead = onAccount("7", 1627.59, "2026-12-28");
    for (const m of ["2027-01", "2027-02", "2027-03"]) await runCharges(PARK, m);
    expect(db.park_charges.every((c) => c.status === "paid")).toBe(true);
    const res = await reversePayment(PARK, ahead.id as string, "the cheque bounced");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe(
      `$1,627.59 taken back (receipt ${ahead.receipt_no}). It had been put against January 2027, February 2027 and March 2027 — those bills are outstanding again, and the record shows why.`,
    );
    expect(db.park_charges.map((c) => [c.period_month, c.paid_total, c.status])).toEqual([
      ["2027-01", 0, "open"], ["2027-02", 0, "open"], ["2027-03", 0, "open"],
    ]);
    // The allocations are the record of where it had gone; they are not deleted.
    expect(db.park_payment_allocations).toHaveLength(3);
  });

  it("one month reads in the singular; money never applied keeps the old sentence", async () => {
    db.lot_reservations = [stay("7", "feb-7", "[2027-02-01,2027-03-01)")];
    const ahead = onAccount("7", 542.53, "2026-12-28");
    await runCharges(PARK, "2027-02");
    const res = await reversePayment(PARK, ahead.id as string, "typo");
    expect(res.signal).toMatch(/It had been put against February 2027 — that bill is outstanding again/);
    const idle = onAccount("9", 50, "2027-01-02");
    const res2 = await reversePayment(PARK, idle.id as string, "typo");
    expect(res2.signal).toMatch(/It's off the household's account, and the record shows why\.$/);
  });

  it("refuses to reverse on a failed read of where the money had gone, before writing anything", async () => {
    const ahead = onAccount("7", 542.53, "2026-12-28");
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    const res = await reversePayment(PARK, ahead.id as string, "typo");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError, "the allocations read never happened").toBeNull();
    expect(db.park_payments.find((p) => p.id === ahead.id)!.reversed_at).toBeNull();
    expect(updated).toHaveLength(0);
  });

  it("a plain payment against a bill names the month that reopened", async () => {
    janBill("9");
    await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "form-9");
    const bill = db.park_payments.find((p) => p.charge_id === "charge-9")!;
    const res = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(res.signal).toBe(`$542.53 taken back (receipt ${bill.receipt_no}). The January 2027 bill is outstanding again, and the record shows why.`);
    expect(db.park_charges[0].status).toBe("open");
    expect(updated).toHaveLength(1);
  });
});

/**
 * ONE CHEQUE, TWO ROWS. recordPayment writes $600 on a $542.53 bill as the
 * bill's share and $57.47 on account, in one insert, under one key and key +
 * ":onaccount". reversePayment reversed ONE row by id: after a bounced
 * cheque the office took the bill row back from Statements, the $57.47
 * stayed standing under "Money not against a bill", and the next run put
 * money that never arrived against February — automatically. The sentence
 * never named the other half. Both halves go together now, in one update,
 * from whichever screen the office tapped.
 */
describe("taking back a split cheque takes back both halves", () => {
  /** $600 on the January bill, then the run puts the $57.47 against February. */
  async function splitThenFebruary() {
    janBill("9");
    db.lot_reservations = [stay("9", "feb-9", "[2027-02-01,2027-03-01)")];
    const rec = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(rec.ok).toBe(true);
    await runCharges(PARK, "2027-02");
    const bill = db.park_payments.find((p) => p.charge_id === "charge-9")!;
    const acct = db.park_payments.find((p) => p.idempotency_key === "form-key:onaccount")!;
    const feb = db.park_charges.find((c) => c.period_month === "2027-02")!;
    expect(feb.paid_total, "the run spent the on-account half on February").toBe(57.47);
    return { bill, acct, feb };
  }

  it("from the bill row: the on-account half goes too, in ONE update with the same reason, and February is named", async () => {
    const { bill, acct, feb } = await splitThenFebruary();
    const res = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe(
      `$600.00 taken back (receipt ${bill.receipt_no}) — both halves of it, the $542.53 against January 2027 and the $57.47 on account. ` +
      "The January 2027 bill is outstanding again, and $57.47 of the on-account half had been put against February 2027 — that bill is outstanding again too. The record shows why.",
    );
    // Both rows, one update, one reason, one timestamp.
    expect(updated.filter((u) => u.table === "park_payments")).toHaveLength(1);
    expect(bill.reversed_at).toBeTruthy();
    expect(acct.reversed_at).toBe(bill.reversed_at);
    expect(acct.reversed_reason).toBe("the cheque bounced");
    expect(bill.reversed_reason).toBe("the cheque bounced");
    // Every month reopened — and the sibling is no longer money on account.
    expect(db.park_charges.find((c) => c.id === "charge-9")!.status).toBe("open");
    expect(feb.paid_total).toBe(0);
    expect(feb.status).toBe("open");
    expect(onAccountView().find((v) => v.payment_id === acct.id)).toBeUndefined();
    // The allocation stays as the record of where it had gone.
    expect(db.park_payment_allocations.filter((a) => a.payment_id === acct.id)).toHaveLength(1);
  });

  it("from the on-account row: the bill half goes too, and the sentence names both", async () => {
    const { bill, acct } = await splitThenFebruary();
    const res = await reversePayment(PARK, acct.id as string, "keyed twice");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe(
      `$600.00 taken back (receipt ${acct.receipt_no}) — both halves of it, the $542.53 against January 2027 and the $57.47 on account. ` +
      "The January 2027 bill is outstanding again, and $57.47 of the on-account half had been put against February 2027 — that bill is outstanding again too. The record shows why.",
    );
    expect(bill.reversed_at).toBe(acct.reversed_at);
    expect(bill.reversed_reason).toBe("keyed twice");
    expect(db.park_charges.find((c) => c.id === "charge-9")!.status).toBe("open");
    expect(updated.filter((u) => u.table === "park_payments")).toHaveLength(1);
  });

  it("a split whose on-account half was never applied still names both halves, and no month for it", async () => {
    janBill("9");
    await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    const bill = db.park_payments.find((p) => p.charge_id === "charge-9")!;
    const res = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(res.signal).toBe(
      `$600.00 taken back (receipt ${bill.receipt_no}) — both halves of it, the $542.53 against January 2027 and the $57.47 on account. ` +
      "The January 2027 bill is outstanding again. The record shows why.",
    );
    expect(db.park_payments.filter((p) => p.reversed_at != null)).toHaveLength(2);
  });

  it("a failed read of the other half refuses, before anything is written", async () => {
    const { bill, acct } = await splitThenFebruary();
    nextReadError = { table: "park_payments", column: "idempotency_key", error: { code: "57P01", message: "terminating connection" } };
    const res = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError, "the sibling read never happened").toBeNull();
    expect(bill.reversed_at).toBeNull();
    expect(acct.reversed_at).toBeNull();
    expect(updated).toHaveLength(0);
  });

  it("a cheque keyed on account through its own door has no other half — its form key is never read as somebody's ':onaccount'", async () => {
    const own = onAccount("9", 542.53, "2026-12-28", { idempotency_key: "form-own" });
    // A bill row whose key happens to be the same stem must not be found.
    janBill("9");
    db.park_payments.push({ id: "other", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 542.53, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null, idempotency_key: "form-own" });
    const res = await reversePayment(PARK, own.id as string, "typo");
    expect(res.signal).toMatch(/^\$542\.53 taken back \(receipt \d+\)\. It's off the household's account, and the record shows why\.$/);
    expect(db.park_payments.find((p) => p.id === "other")!.reversed_at).toBeNull();
  });

  it("somebody else takes a half back between the read and the write: the row itself → refused; the sibling → this row alone, and no month the earlier act reopened", async () => {
    // The row itself: nothing here was reversed by this act, so "taken
    // back" would be said about nothing.
    const first = await splitThenFebruary();
    beforeUpdate = { table: "park_payments", act: () => { first.bill.reversed_at = "2027-01-20T10:00:00Z"; first.bill.reversed_reason = "elsewhere"; } };
    const refused = await reversePayment(PARK, first.bill.id as string, "the cheque bounced");
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("That one was just taken back by somebody else.");
    expect(first.bill.reversed_reason).toBe("elsewhere");
    expect(first.acct.reversed_at, "the sibling was reached by the write — it is one cheque").toBeTruthy();

    // The sibling: its February went back to owing when IT was taken back,
    // not now — the sentence names this row alone.
    reset();
    const second = await splitThenFebruary();
    beforeUpdate = { table: "park_payments", act: () => { second.acct.reversed_at = "2027-01-20T10:00:00Z"; second.acct.reversed_reason = "elsewhere"; } };
    const alone = await reversePayment(PARK, second.bill.id as string, "the cheque bounced");
    expect(alone.ok).toBe(true);
    expect(alone.signal).toBe(`$542.53 taken back (receipt ${second.bill.receipt_no}). The January 2027 bill is outstanding again, and the record shows why.`);
    expect(alone.signal).not.toMatch(/both halves|February/);
    expect(second.acct.reversed_reason).toBe("elsewhere");
  });

  it("a half already taken back on its own is left alone: only this row goes, and the sentence is the plain one", async () => {
    const { bill, acct } = await splitThenFebruary();
    acct.reversed_at = "2027-01-20T10:00:00Z"; acct.reversed_reason = "typo";
    const res = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(res.signal).toBe(`$542.53 taken back (receipt ${bill.receipt_no}). The January 2027 bill is outstanding again, and the record shows why.`);
    expect(acct.reversed_reason).toBe("typo");
  });

  // MONEY HANDED BACK CANNOT BE UNSAID (0168). A reversal says the cheque
  // never arrived; the record says $57.47 of it went back across the window.
  // The database refuses the update by name; the door says it in a sentence
  // first, whichever half is tapped — and "try again" would never come true.
  it("a handed-back on-account row refuses the reversal, from either half", async () => {
    const { bill, acct } = await splitThenFebruary();
    acct.returned_on = "2027-02-05"; acct.returned_amount = 57.47; acct.return_note = "moved out";
    const fromAcct = await reversePayment(PARK, acct.id as string, "the cheque bounced");
    expect(fromAcct.ok).toBe(false);
    // The day it went back is named, the dead end is said (a hand-back has
    // no un-record yet), and no method word: a $600 cash split writes the
    // same two rows, and "the cheque" about cash was the lie.
    expect(fromAcct.error).toBe("The record shows $57.47 of that handed back to them on February 5, 2027 — reversing it would contradict the record, and there's no way yet to undo a hand-back.");
    const fromBill = await reversePayment(PARK, bill.id as string, "the cheque bounced");
    expect(fromBill.ok).toBe(false);
    expect(fromBill.error).toBe("The record shows $57.47 of the on-account half of that payment handed back to them on February 5, 2027 — reversing the payment would contradict the record, and there's no way yet to undo a hand-back.");
    for (const e of [fromAcct.error, fromBill.error]) {
      expect(e).not.toMatch(/cheque|try again|2027-02-05/);
    }
    expect(updated).toHaveLength(0);
    expect(bill.reversed_at).toBeNull();
    expect(acct.reversed_at).toBeNull();
  });

  it("a returned deposit keeps its own sentence, read off the same row", async () => {
    db.park_payments.push({ id: "dep", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2027-01-02", reversed_at: null, returned_at: null, returned_on: "2027-03-01", returned_amount: 500, receipt_no: 77 });
    const res = await reversePayment(PARK, "dep", "typo");
    expect(res.error).toBe("That deposit was already returned — reversing it would contradict the record.");
    expect(updated).toHaveLength(0);
  });

  it("the other half is looked up park-scoped, through the one spelling of the key, and written in one update over both ids", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const fn = src.match(/export async function reversePayment[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn.length, "reversePayment not found — this scan is measuring nothing").toBeGreaterThan(500);
    expect(fn).toMatch(/splitSiblingKey\(/);
    expect(fn, "the sibling key is spelled once, in ledger-helpers").not.toMatch(/onaccount/);
    expect(fn).toMatch(/\.eq\("idempotency_key", sibKey\)\s*\.eq\("park_id", parkId\)\s*\.is\("reversed_at", null\)/);
    expect(fn).toMatch(/\.in\("id", ids\)\s*\.eq\("park_id", parkId\)\s*\.is\("reversed_at", null\)/);
    expect(fn.match(/\.update\(/g)?.length, "one update, both halves").toBe(1);
    // And recordPayment writes the on-account half under the same helper —
    // the one place in this file the key is derived for a write.
    expect(src.match(/idempotency_key: key \? onAccountKey\(key\) : null/g)?.length).toBe(1);
    expect(src, "no door spells the suffix itself").not.toMatch(/onaccount/);
  });
});

describe("a refund reaches only what is still unapplied", () => {
  it("a card payment on account with $542.53 against April can send back $57.47 and not a penny more", async () => {
    janBill("9", { period_month: "2027-04" });
    const card = onAccount("9", 600, "2027-01-02", { method: "card", reference: "ch_1", fee_amount: null });
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: card.id, charge_id: "charge-9", amount: 542.53, applied_via: "office" });
    refundResult = { ok: true, ref: "re_1" };
    const tooMuch = await refundParkPayment(PARK, card.id as string, { amount: 57.48, feeAmount: 0, reason: "overpaid", idempotencyKey: "k1" });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.error).toBe("That's more than is left on this payment — at most $57.47 can still go back.");
    expect(db.park_refunds).toHaveLength(0);
    expect(refundAsks, "the processor was never asked for the over-ask").toBe(0);
    const ok = await refundParkPayment(PARK, card.id as string, { amount: 57.47, feeAmount: 0, reason: "overpaid", idempotencyKey: "k2" });
    expect(ok.ok).toBe(true);
    expect(db.park_refunds).toHaveLength(1);
    expect(refundAsks, "asked exactly once, for the $57.47").toBe(1);
  });

  it("the ceiling is the view's remaining — an allocation taken back off its bill is refundable again, and a refund already given is netted", async () => {
    // ONE definition of "what is left on a payment" (park_payment_remaining):
    // amount − LIVE allocations − refunds. A JS subtraction here would count
    // a removed allocation as still on the bill and net no earlier refund.
    janBill("9", { period_month: "2027-04" });
    const card = onAccount("9", 600, "2027-01-02", { method: "card", reference: "ch_1", fee_amount: null });
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: card.id, charge_id: "charge-9", amount: 542.53, applied_via: "office", removed_at: "2027-01-09T00:00:00Z", removed_reason: "wrong month" });
    db.park_refunds.push({ id: "rf-0", payment_id: card.id, park_id: PARK, amount: 100, fee_amount: 0 });
    refundResult = { ok: true, ref: "re_1" };
    const tooMuch = await refundParkPayment(PARK, card.id as string, { amount: 500.01, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(tooMuch.error).toBe("That's more than is left on this payment — at most $500.00 can still go back.");
    expect(refundAsks).toBe(0);
    const ok = await refundParkPayment(PARK, card.id as string, { amount: 500, feeAmount: 0, reason: "x", idempotencyKey: "k2" });
    expect(ok.ok).toBe(true);
    expect(refundAsks).toBe(1);
  });

  it("a payment against a bill (not on account) keeps amount − refunds as its ceiling — the view has no row for it", async () => {
    janBill("9");
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 542.53, method: "card", reference: "ch_2", fee_amount: null, received_on: "2027-01-02", reversed_at: null, returned_at: null });
    refundResult = { ok: true, ref: "re_1" };
    const ok = await refundParkPayment(PARK, "direct", { amount: 542.53, feeAmount: 0, reason: "moved out", idempotencyKey: "k1" });
    expect(ok.ok).toBe(true);
    expect(refundAsks).toBe(1);
  });

  it("a failed read of the view's remaining refuses rather than offering the whole payment back", async () => {
    janBill("9");
    const card = onAccount("9", 600, "2027-01-02", { method: "card", reference: "ch_1", fee_amount: null });
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    refundResult = { ok: true, ref: "re_1" };
    const res = await refundParkPayment(PARK, card.id as string, { amount: 600, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(refundAsks).toBe(0);
  });

  it("a payment wholly against bills has nothing unapplied to send, and says where it is", async () => {
    janBill("9");
    const card = onAccount("9", 542.53, "2027-01-02", { method: "card", reference: "ch_1", fee_amount: null });
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: card.id, charge_id: "charge-9", amount: 542.53, applied_via: "office" });
    refundResult = { ok: true, ref: "re_1" };
    const res = await refundParkPayment(PARK, card.id as string, { amount: 1, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("All of that payment is either against bills ($542.53) or already gone back — there is nothing unapplied to send.");
  });

  it("a returned payment keeps its own reason, even when all of it was against bills", async () => {
    janBill("9");
    const card = onAccount("9", 542.53, "2027-01-02", { method: "ach", reference: "ch_1", fee_amount: null, returned_at: "2027-01-08T00:00:00Z" });
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: card.id, charge_id: "charge-9", amount: 542.53, applied_via: "office" });
    const res = await refundParkPayment(PARK, card.id as string, { amount: 1, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(res.error).toMatch(/^The bank took that payment back/);
  });

  it("a failed read of the allocations is not read as 'nothing applied'", async () => {
    janBill("9");
    const card = onAccount("9", 600, "2027-01-02", { method: "card", reference: "ch_1", fee_amount: null });
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    refundResult = { ok: true, ref: "re_1" };
    const res = await refundParkPayment(PARK, card.id as string, { amount: 600, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError, "the allocations read never happened").toBeNull();
    expect(db.park_refunds).toHaveLength(0);
  });
});

/**
 * OLDEST OPEN BILL FIRST — BOTH ORDERINGS OF "APPLIED TO THE MONTHS IF THERE
 * IS A PREPAY" (R1). The run used to settle only the bill it was raising, so
 * February's run could spend the quarter while January read late and was
 * the one chased; and the excess of a split waited for the NEXT run while
 * an older bill sat open. One helper (settleOnAccount) now does both: the
 * run, recordPayment (and so confirmClaimCollected) and recordOnAccount all
 * settle the household's open bills oldest first, and the preview plans the
 * same way, so its figure is the run's.
 */
describe("money on account settles the oldest open bill first, wherever it is applied from", () => {
  const FEB = "[2027-02-01,2027-03-01)";

  it("the run: January in arrears and $600 on account — January is settled before February, and both are named", async () => {
    db.lot_reservations = [stay("9", "feb-9", FEB)];
    janBill("9");                                   // open, $542.53, raised last month
    onAccount("9", 600, "2027-01-20");
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.ok).toBe(true);
    // February's share is what is left AFTER January: $57.47 — and the plan
    // CARRIES January. It used to plan the $542.53 against January and drop
    // it, so the sentence he approved from said "$57.47 of it already on
    // account" while the run moved $600. A PREVIEW MUST SHOW WHAT THE RUN
    // WILL ACTUALLY DO.
    expect(pre.plan!.toBill[0].fromOnAccount).toBe(57.47);
    expect(pre.plan!.fromOnAccount).toBe(57.47);
    expect(pre.plan!.toOlderBills).toEqual([{ periodMonth: "2027-01", amount: 542.53 }]);
    expect(runSummary(pre.plan!, "2027-02")).toBe(
      "Bill 1 household for February 2027 — $542.53; $600.00 of money on account goes against January 2027 and February 2027",
    );
    expect(db.park_payment_allocations, "a preview writes nothing").toHaveLength(0);

    const run = await runCharges(PARK, "2027-02");
    expect(run.ok).toBe(true);
    // THE RUN'S SENTENCE IS THE PREVIEW'S, past tense: same figure, same months.
    expect(run.signal).toBe(
      "1 bill raised for February 2027 — $542.53; $600.00 of money on account went against January 2027 and February 2027. Nobody has been told.",
    );
    expect(db.park_payment_allocations.map((a) => [a.charge_id, a.amount, a.applied_via])).toEqual([
      ["charge-9", 542.53, "run"],
      [db.park_charges.find((c) => c.period_month === "2027-02")!.id, 57.47, "run"],
    ]);
    expect(db.park_charges.find((c) => c.id === "charge-9")).toMatchObject({ paid_total: 542.53, status: "paid" });
    expect(db.park_charges.find((c) => c.period_month === "2027-02")).toMatchObject({ paid_total: 57.47, status: "open" });
  });

  it("the run: with two older bills and not enough money, the OLDEST is settled and the newer one is left short — whatever order the rows came back in", async () => {
    db.lot_reservations = [stay("9", "feb-9", FEB)];
    janBill("9");                                                    // pushed first…
    db.park_charges.push({ id: "charge-dec", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "dec-9", period_month: "2026-12", due_on: "2026-12-01", amount: 40, paid_total: 0, status: "open" });  // …December second
    onAccount("9", 560, "2027-01-20");
    // THE WORST SHAPE for the preview: the older bills absorb ALL the money,
    // so the plan's fromOnAccount is 0 and the old sentence said nothing
    // about money on account at all — then the run moved $560.
    const pre = await previewChargeRun(PARK, "2027-02");
    expect(pre.plan!.fromOnAccount).toBe(0);
    expect(pre.plan!.toOlderBills).toEqual([{ periodMonth: "2026-12", amount: 40 }, { periodMonth: "2027-01", amount: 520 }]);
    expect(runSummary(pre.plan!, "2027-02")).toBe(
      "Bill 1 household for February 2027 — $542.53; $560.00 of money on account goes against December 2026 and January 2027",
    );
    const run = await runCharges(PARK, "2027-02");
    expect(db.park_payment_allocations.map((a) => [a.charge_id, a.amount])).toEqual([
      ["charge-dec", 40],
      ["charge-9", 520],
    ]);
    expect(run.signal).toBe("1 bill raised for February 2027 — $542.53; $560.00 of money on account went against December 2026 and January 2027. Nobody has been told.");
    expect(db.park_charges.find((c) => c.id === "charge-9")).toMatchObject({ paid_total: 520, status: "open" });
  });

  it("the run: a refused allocation on an OLDER bill names its month, not 'its bill'", async () => {
    db.lot_reservations = [stay("9", "feb-9", FEB)];
    janBill("9");
    onAccount("9", 600, "2027-01-20");
    nextAllocationError = { after: 0, error: { code: "P0001", message: "park_payment_allocations: that bill only has 0.00 left on it, and this would apply 542.53" } };
    const run = await runCharges(PARK, "2027-02");
    expect(run.signal).toContain("⚠️ $542.53 of a household's money on account couldn't be put against its January 2027 bill");
    // Only what LANDED is in the clause: January was refused, so no older
    // month is named and the short form stands.
    expect(run.signal).toContain("$57.47 of it settled from money on account.");
    expect(run.signal).not.toMatch(/went against January/);
  });

  it("recordPayment: the excess of a split settles an OLDER open bill the moment it is recorded, and the paper household is told", async () => {
    janBill("9");                                                    // January, open
    db.park_charges.push({ ...janBill("9", { id: "charge-dec", period_month: "2026-12", due_on: "2026-12-01", amount: 40 }) });
    db.park_charges.pop();                                           // janBill pushed it already
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok).toBe(true);
    expect(res.against).toBe(542.53);
    expect(res.onAccount).toBe(57.47);
    // The excess row, and $40 of it against December — the oldest open bill.
    const acct = db.park_payments.find((p) => p.charge_id == null)!;
    expect(db.park_payment_allocations).toEqual([
      expect.objectContaining({ payment_id: acct.id, charge_id: "charge-dec", amount: 40, applied_via: "office" }),
    ]);
    expect(db.park_charges.find((c) => c.id === "charge-dec")).toMatchObject({ paid_total: 40, status: "paid" });
    expect(res.signal).toBe(
      "$600.00 received — $542.53 against January 2027, $57.47 on account. Of that, $40.00 went against December 2026 — $17.47 stays on account and comes off February 2027 when you raise it.",
    );
    // THE PAPER says the same — never "held by the office" about the $40.
    expect(res.receipt?.onAccount).toEqual({ amount: 57.47, receiptNo: acct.receipt_no, appliedTo: [{ periodMonth: "2026-12", amount: 40 }], remaining: 17.47 });
    const body = receiptBody(res.receipt!);
    expect(body).toContain("Of the $57.47 on account: $40.00 to December 2026, $17.47 on account");
    expect(body).toContain("The $17.47 still on account comes off your next bill.");
    expect(body).not.toMatch(/\$57\.47 on account is held by the office/);
  });

  it("recordPayment: when what is still held could not be read, neither the toast nor the paper prints the whole excess as held", async () => {
    // $40 of the $57.47 just went on December. The view read that says
    // what is left then fails. This used to leave `stillHeld = onAccount`,
    // so the toast said "$57.47 stays on account" and the paper "…$40.00 to
    // December 2026, $57.47 on account" — more than the cheque — about money
    // $40 of which is on December.
    janBill("9");
    db.park_charges.push({ id: "charge-dec", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "dec-9", period_month: "2026-12", due_on: "2026-12-01", amount: 40, paid_total: 0, status: "open" });
    nextReadError = { table: "park_on_account_payments", column: "payment_id", error: { code: "57P01", message: "terminating connection" } };
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(res.ok).toBe(true);
    expect(nextReadError, "the held read happened and failed").toBeNull();
    expect(res.signal).toBe(
      "$600.00 received — $542.53 against January 2027, $57.47 on account. Of that, $40.00 went against December 2026 — what's left stays on account.",
    );
    expect(res.signal).not.toMatch(/\$57\.47 stays on account/);
    expect(res.receipt?.onAccount).toEqual({ amount: 57.47, receiptNo: expect.any(Number), appliedTo: [{ periodMonth: "2026-12", amount: 40 }] });
    expect("remaining" in (res.receipt?.onAccount ?? {}), "a figure nobody read is not on the paper").toBe(false);
    const body = receiptBody(res.receipt!);
    expect(body).toContain("Of the $57.47 on account: $40.00 to December 2026");
    expect(body).toContain("What's still on account wasn't read when this was printed — ask at the office.");
    expect(body).not.toMatch(/December 2026, \$57\.47 on account/);
    expect(body).not.toMatch(/\$17\.47/);
    expect(body).not.toMatch(/held by the office/);
  });

  it("recordPayment: an exact payment while an older bill is open lets money already on account settle the older one, and says so", async () => {
    janBill("9");
    db.park_charges.push({ id: "charge-dec", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "dec-9", period_month: "2026-12", due_on: "2026-12-01", amount: 100, paid_total: 0, status: "open" });
    onAccount("9", 100, "2026-12-28");
    const res = await recordPayment(PARK, "charge-9", 542.53, "check", "1042", TODAY, "", "form-key");
    expect(res.signal).toBe("Recorded — that one's settled. And $100.00 went against December 2026 from money they had on account.");
    expect(db.park_charges.find((c) => c.id === "charge-dec")!.status).toBe("paid");
    expect(res.receipt?.fromOnAccount).toBeNull();
  });

  it("the excess of a split still never pays the bill it came in over, and with nothing older open it waits for the run", async () => {
    janBill("9");
    const res = await recordPayment(PARK, "charge-9", 600, "check", "1042", TODAY, "", "form-key");
    expect(db.park_payment_allocations).toHaveLength(0);
    expect(res.signal).toBe(
      "$600.00 received — $542.53 against January 2027, $57.47 on account and comes off February 2027 when you raise it — or put it against an open bill now from \"Money not against a bill\".",
    );
  });

  it("every door settles through the ONE helper — no door plans its own", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const body = (name: string) => {
      const at = src.indexOf(`export async function ${name}`);
      const next = src.indexOf("\nexport ", at + 1);
      const fn = src.slice(at, next < 0 ? undefined : next);
      expect(fn.length, `${name} not found`).toBeGreaterThan(400);
      return fn;
    };
    expect(body("runCharges")).toMatch(/await settleOnAccount\(admin, parkId, billedHouseholds, "run", null\)/);
    expect(body("recordPayment")).toMatch(/await settleOnAccount\(admin, parkId, \[renterId\], "office"/);
    expect(src, "no private copy of the plan or the writer").not.toMatch(/async function (onAccountSources|writeAllocations)\(/);
    expect(src).not.toMatch(/\.from\("park_payment_allocations"\)\.insert/);
    // The preview plans over the household's OLDER open bills too, oldest
    // first, through the same pure function — or its figure is not the run's.
    expect(body("previewChargeRun")).toMatch(/await openBillsFor\(admin, parkId, billed\)/);
    expect(body("previewChargeRun")).toMatch(/planSettlement\(/);
  });
});

/**
 * TAKING MONEY BACK OFF A BILL (R3) — what the ledger's other doors say
 * about it. voidCharge used to refuse an allocated bill with "sort the
 * payment out first" — an instruction about a payment nobody took at a
 * window, with no door to follow it through. It names the un-apply door
 * now. And a reversal names only LIVE months: an allocation already taken
 * off its bill reopens nothing.
 */
describe("the doors around an allocation taken back off its bill", () => {
  it("voidCharge on a bill settled from money on account names 'Take it off this bill', not 'sort the payment out'", async () => {
    janBill("9");
    const q = onAccount("9", 542.53, "2026-12-28");
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: q.id, charge_id: "charge-9", amount: 542.53, applied_via: "run", removed_at: null });
    db.park_charges[0].paid_total = 542.53; db.park_charges[0].status = "paid";
    const res = await voidCharge(PARK, "charge-9", "raised twice");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "$542.53 of this bill was settled from money on account — take that off it first (under \"Money not against a bill\", \"Take it off this bill\" on the January 2027 line).",
    );
    expect(res.error).not.toMatch(/sort the payment out/);
    expect(db.park_charges[0].status).toBe("paid");
  });

  it("…and a bill with BOTH kinds of money on it names the allocation's door alone — the line comes off first, and only then does the cancel release the rest", async () => {
    janBill("9");
    const q = onAccount("9", 100, "2026-12-28");
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: q.id, charge_id: "charge-9", amount: 100, applied_via: "run", removed_at: null });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    db.park_charges[0].paid_total = 300;
    const res = await voidCharge(PARK, "charge-9", "raised twice");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "$100.00 of this bill was settled from money on account — take that off it first (under \"Money not against a bill\", \"Take it off this bill\" on the January 2027 line).",
    );
    expect(res.error).not.toMatch(/disappear|sort that payment out/);
    expect(db.park_charges[0].status).toBe("open");
  });

  /**
   * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). "Cancel this
   * bill" on a bill paid straight against it used to refuse — "cancelling it
   * would make that money disappear from your totals" — which is a lie now:
   * the money is the household's, on account, derived from the void; the
   * payment row never moves. The door proceeds and says where it went.
   */
  it("voidCharge with direct money only PROCEEDS and says it is on account for the household, with the doors out", async () => {
    // A household still here, January cancelled: the run bills a void
    // month again, and the money comes off THAT — said by month, not as
    // "their next bill".
    db.lot_reservations = [stay("9", "jan-9", "[2027-01-01,2027-02-01)")];
    janBill("9", { paid_total: 200 });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    const res = await voidCharge(PARK, "charge-9", "raised twice");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "Cancelled. The $200.00 taken against it is on account for Household 9 now — it comes off January 2027 when you bill it again, " +
      "or hand it back from \"Money not against a bill\" on the Rent screen.",
    );
    expect(res.signal).not.toMatch(/disappear|sort that payment/);
    expect(db.park_charges[0]).toMatchObject({ status: "void", paid_total: 0, void_reason: "raised twice" });
    // The row never moved, and the view lists it as released from January.
    expect(db.park_payments[0]).toMatchObject({ charge_id: "charge-9", reversed_at: null });
    expect(onAccountView()).toEqual([expect.objectContaining({ payment_id: "direct", remaining: 200, released_from_charge_id: "charge-9", released_from_month: "2027-01" })]);
    // No auto-settle: nothing was put against anything.
    expect(db.park_payment_allocations).toEqual([]);
    // The old refusal is gone from the file, in code and in prose alike.
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8");
    expect(src).not.toMatch(/money disappear/);
  });

  it("…a card payment names the processor's door, and both rails name both; a bill with no household says 'that household'", async () => {
    // Raised twice: a second live January stands, so the run would not
    // bill January again — the money comes off their next bill.
    db.lot_reservations = [stay("9", "jan-9", "[2027-01-01,2027-02-01)")];
    janBill("9", { paid_total: 500 });
    db.park_charges.push({ id: "charge-9-twin", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open" });
    db.park_payments.push({ id: "card", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 300, method: "card", reference: "ch_1", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    db.park_payments.push({ id: "cash", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    const both = await voidCharge(PARK, "charge-9", "raised twice");
    expect(both.signal).toBe(
      "Cancelled. The $500.00 taken against it is on account for Household 9 now — it comes off their next bill, " +
      "or hand it back from \"Money not against a bill\" on the Rent screen, or send it back through \"Refund to card\" on Statements.",
    );
    reset();
    db.lot_reservations = [stay("9", "jan-9", "[2027-01-01,2027-02-01)", { renter_id: null })];
    janBill("9", { paid_total: 300, renter_id: null });
    db.park_charges.push({ id: "charge-9-twin", park_id: PARK, park_lot_id: "lot-9", renter_id: null, reservation_id: "jan-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "open" });
    db.park_payments.push({ id: "card", park_id: PARK, renter_id: null, charge_id: "charge-9", kind: "rent", amount: 300, method: "ach", reference: "ch_1", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    const rail = await voidCharge(PARK, "charge-9", "raised twice");
    // No household on the bill: nothing to ask "nothing more bills?" of,
    // so no promise either way — the doors alone.
    expect(rail.signal).toBe(
      "Cancelled. The $300.00 taken against it is on account for that household now — " +
      "send it back through \"Refund to card\" on Statements.",
    );
  });

  /**
   * "IT COMES OFF THEIR NEXT BILL" IS A PROMISE, decided on the bill just
   * cancelled — never assumed. The resident's receipt (nothingMoreBillsFor)
   * and the held panel (tenancyFactsFor) had already stopped making it to
   * a household who moved out with their final month billed; voidCharge
   * was the one doorway still promising a bill the park will never raise.
   * Three shapes, each pinned, and a failed read makes no promise at all.
   */
  it("voidCharge's promise is decided on the tenancy: the month bills again, nothing more bills, the next bill — and no promise on a failed read", async () => {
    // GONE, final month billed: the January part month stands on the link
    // they left from; a February bill raised early by hand on that link is
    // cancelled. February is after their last day, so the run would not
    // bill it again; nothing more bills for them.
    const gone = () => {
      reset();
      db.lot_reservations = [stay("9", "jan-9", "[2026-06-01,2027-01-16)", { status: "ended", moved_out_on: "2027-01-15" })];
      db.park_charges.push({ id: "charge-jan-part", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2027-01", due_on: "2027-01-01", amount: 262.51, paid_total: 262.51, status: "paid" });
      db.park_charges.push({ id: "charge-feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 542.53, status: "paid" });
      db.park_payments.push({ id: "feb-cheque", park_id: PARK, renter_id: "renter-9", charge_id: "charge-feb", kind: "rent", amount: 542.53, method: "check", received_on: "2027-01-10", reversed_at: null, returned_at: null });
    };
    gone();
    const departed = await voidCharge(PARK, "charge-feb", "raised for a month after they left");
    expect(departed.ok, departed.error).toBe(true);
    expect(departed.signal).toBe(
      "Cancelled. The $542.53 taken against it is on account for Household 9 now — nothing more bills for them; " +
      "hand it back from \"Money not against a bill\" on the Rent screen.",
    );
    expect(departed.signal).not.toMatch(/next bill|bill it again/);

    // GONE, but the bill cancelled is an IN-STAY month (December): the run
    // bills a void month again on an ended row that carries its last day,
    // and takes the money back off account when it does — "theirs to have
    // back" here would instruct a hand-back the next bill then chases.
    gone();
    db.park_charges.push({ id: "charge-dec", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2026-12", due_on: "2026-12-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    db.park_payments.push({ id: "dec-cheque", park_id: PARK, renter_id: "renter-9", charge_id: "charge-dec", kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-02", reversed_at: null, returned_at: null });
    const inStay = await voidCharge(PARK, "charge-dec", "wrong rent");
    expect(inStay.ok, inStay.error).toBe(true);
    expect(inStay.signal).toContain("is on account for Household 9 now — it comes off December 2026 when you bill it again, or hand it back");
    expect(inStay.signal).not.toMatch(/nothing more bills|next bill/);

    // GONE, final month NOT yet billed: a next bill (the part month) is
    // still coming, and it settles from this money (R1).
    gone();
    db.park_charges = db.park_charges.filter((c) => c.id !== "charge-jan-part");
    const notYet = await voidCharge(PARK, "charge-feb", "raised for a month after they left");
    expect(notYet.ok, notYet.error).toBe(true);
    expect(notYet.signal).toContain("is on account for Household 9 now — it comes off their next bill, or hand it back");

    // A FAILED READ of the tenancy: the money IS on account; no promise
    // is made about what happens to it, in either direction.
    gone();
    nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
    const unread = await voidCharge(PARK, "charge-feb", "raised for a month after they left");
    expect(unread.ok, unread.error).toBe(true);
    expect(nextReadError, "the tenancy read never happened").toBeNull();
    expect(unread.signal).toBe(
      "Cancelled. The $542.53 taken against it is on account for Household 9 now — hand it back from \"Money not against a bill\" on the Rent screen.",
    );
    expect(unread.signal).not.toMatch(/next bill|nothing more bills|bill it again/);
    // The promise is read from the shared helper, not a fourth private copy.
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8");
    expect(src).toMatch(/from "@\/lib\/tenancy-facts"/);
  });

  it("…the figure is the view's remaining (net of a refund already given), a failed read of it is said, and the DB's own refusal reaches him by name", async () => {
    janBill("9");
    db.park_payments.push({ id: "card", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 400, method: "card", reference: "ch_1", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    db.park_refunds.push({ id: "rf-1", payment_id: "card", park_id: PARK, amount: 100, fee_amount: 0 });
    recompute("charge-9");
    expect(db.park_charges[0].paid_total).toBe(300);
    const res = await voidCharge(PARK, "charge-9", "raised twice");
    // $400 was taken; $100 already went back to the card; $300 is on
    // account. Three figures, all the view's — "The $300.00 taken against
    // it" named the remainder as the amount taken.
    expect(res.signal).toMatch(/^Cancelled\. The \$400\.00 taken against it, less the \$100\.00 already refunded, leaves \$300\.00 on account for Household 9 now/);
    expect(res.signal).not.toMatch(/\$300\.00 taken against/);

    // A failed view read after the void: the money IS on account and the
    // sentence says so without a figure — never "$0.00", never silence.
    reset();
    janBill("9", { paid_total: 200 });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    const unread = await voidCharge(PARK, "charge-9", "raised twice");
    expect(unread.ok).toBe(true);
    expect(unread.signal).toBe(
      "Cancelled. What was taken against it is on account for Household 9 now, though the figure couldn't be read — check \"Money not against a bill\" on the Rent screen.",
    );
    expect(unread.signal).not.toMatch(/\$0\.00/);
    expect(db.park_charges[0].status).toBe("void");

    // A line that lands between the read and the write: the database
    // refuses by name, and the sentence is its own, not "try again".
    reset();
    janBill("9", { paid_total: 200 });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    const q = onAccount("9", 100, "2026-12-28");
    beforeUpdate = { table: "park_charges", act: () => { db.park_payment_allocations.push({ id: "al-late", park_id: PARK, payment_id: q.id, charge_id: "charge-9", amount: 100, applied_via: "run", removed_at: null }); } };
    const late = await voidCharge(PARK, "charge-9", "raised twice");
    expect(late.ok).toBe(false);
    expect(late.error).toBe("Couldn't cancel that — 100.00 of money on account is against this bill — take it off the bill first (with a reason), then cancel it.");
    expect(late.error).not.toMatch(/park_charges:|try again/);
    expect(db.park_charges[0].status).toBe("open");
  });

  it("a failed allocations read refuses rather than releasing money it could not see; so does a failed read of the money handed over", async () => {
    janBill("9", { paid_total: 200 });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 200, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    const failed = await voidCharge(PARK, "charge-9", "raised twice");
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError).toBeNull();
    nextReadError = { table: "park_payments", column: "charge_id", error: { code: "57P01", message: "terminating connection" } };
    const failed2 = await voidCharge(PARK, "charge-9", "raised twice");
    expect(failed2.ok).toBe(false);
    expect(failed2.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError).toBeNull();
    expect(db.park_charges[0].status).toBe("open");
  });

  it("a live allocation from a cheque that has since BOUNCED is not money on the bill: the void proceeds, and the $100 in the bank is what is released", async () => {
    // paid_total (the DB) counts an allocation only while its payment
    // stands; reading the bounced line regardless would refuse a void the
    // database accepts, naming a line no screen lists.
    janBill("9");
    const q = onAccount("9", 442.53, "2026-12-28", { reversed_at: "2027-01-20T10:00:00Z", reversed_reason: "the cheque bounced" });
    db.park_payment_allocations.push({ id: "al-1", park_id: PARK, payment_id: q.id, charge_id: "charge-9", amount: 442.53, applied_via: "run", removed_at: null });
    db.park_payments.push({ id: "direct", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 100, method: "cash", received_on: "2027-01-04", reversed_at: null, returned_at: null });
    recompute("charge-9");
    expect(db.park_charges[0].paid_total).toBe(100);
    const res = await voidCharge(PARK, "charge-9", "raised twice");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(/^Cancelled\. The \$100\.00 taken against it is on account for Household 9 now/);
    expect(res.signal).not.toMatch(/Take it off this bill|442\.53/);
  });

  it("a stale paid_total with no rows behind it still refuses in words — nothing is released that cannot be named", async () => {
    janBill("9", { paid_total: 250 });
    const stale = await voidCharge(PARK, "charge-9", "raised twice");
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe("$250.00 is recorded against this bill, so it can't be cancelled — check its payments first.");
    expect(db.park_charges[0].status).toBe("open");
  });

  it("an allocation already taken off its bill is not a month the reversal reopens", async () => {
    janBill("9");
    db.park_charges.push({ id: "charge-feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "feb-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 0, status: "open" });
    const q = onAccount("9", 1085.06, "2026-12-28");
    db.park_payment_allocations.push(
      { id: "al-jan", park_id: PARK, payment_id: q.id, charge_id: "charge-9", amount: 542.53, applied_via: "run", removed_at: null },
      { id: "al-feb", park_id: PARK, payment_id: q.id, charge_id: "charge-feb", amount: 542.53, applied_via: "run", removed_at: "2027-01-09T00:00:00Z", removed_reason: "wrong month" },
    );
    const res = await reversePayment(PARK, q.id as string, "the cheque bounced");
    expect(res.signal).toMatch(/It had been put against January 2027 — that bill is outstanding again/);
    expect(res.signal).not.toMatch(/February/);
  });
});

/**
 * A ROW AGAINST A CANCELLED BILL IS MONEY ON ACCOUNT (0169). January is paid
 * by cheque, the household leaves on the 27th, the bill is cancelled and the
 * part month settled from the released $542.53. The row's charge_id still
 * names the void bill, so every door that decided "on account" by
 * `charge_id` alone read a released row as "against a bill": the reversal
 * dropped the part month from its sentence while it silently reopened, the
 * refund said "the bill is outstanding again" about a void bill, and the
 * refusal for a released cheque pointed at a reversal. Each keys on the
 * VIEW now.
 */
describe("a row against a cancelled bill is money on account", () => {
  /** January paid, cancelled on the move-out, the part month settled from the released money. */
  async function releasedJanuary(over: Partial<Row> = {}) {
    janBill("9");
    db.park_payments.push({
      id: "rel", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 542.53, method: "check",
      reference: null, fee_amount: null, received_on: "2027-01-05", receipt_no: 12, reversed_at: null, returned_at: null, idempotency_key: "form-rel", ...over,
    });
    recompute("charge-9");
    const cancelled = await voidCharge(PARK, "charge-9", "moved out January 27, 2027");
    expect(cancelled.ok, cancelled.error).toBe(true);
    db.park_charges.push({ id: "charge-9p", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "jan-9", period_month: "2027-01", due_on: "2027-01-01", amount: 472.53, paid_total: 0, status: "open",
      lines: [{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }, { label: "Grounds", amount: 124.14, basis: "27 of 31 days" }] });
    db.park_payment_allocations.push({ id: "al-p", park_id: PARK, payment_id: "rel", charge_id: "charge-9p", amount: 472.53, applied_via: "office", removed_at: null });
    recompute("charge-9p");
    expect(db.park_charges.find((c) => c.id === "charge-9p")).toMatchObject({ paid_total: 472.53, status: "paid" });
    expect(onAccountView().find((v) => v.payment_id === "rel")).toMatchObject({ remaining: 70, released_from_charge_id: "charge-9" });
    updated.length = 0;
  }

  it("reversePayment on a released row reads its OWN allocations, names the part month, and says the cancelled bill reopens nothing", async () => {
    await releasedJanuary();
    const res = await reversePayment(PARK, "rel", "the cheque bounced");
    expect(res.ok, res.error).toBe(true);
    // TWO JANUARY BILLS, NAMED APART: the re-raise keeps period_month, so
    // "January 2027's bill was already cancelled … put against January 2027
    // — that bill is outstanding again" was one month with two opposite
    // verbs. The cancelled bill by its amount; the re-raise by its amount
    // and its own frozen basis — both read off park_charges, never pay.amount.
    expect(res.signal).toBe(
      "$542.53 taken back (receipt 12). January 2027's $542.53 bill was already cancelled, so nothing reopens on it; " +
      "it had been put against the $472.53 bill raised again for January 2027 (27 of 31 days) — that one is outstanding again, and the record shows why.",
    );
    expect(res.signal).not.toMatch(/The January 2027 bill is outstanding again|against January 2027 —/);
    // The part month reopened; the void bill is exactly as it was.
    expect(db.park_charges.find((c) => c.id === "charge-9p")).toMatchObject({ paid_total: 0, status: "open" });
    expect(db.park_charges.find((c) => c.id === "charge-9")).toMatchObject({ paid_total: 0, status: "void" });
    expect(db.park_payments.find((p) => p.id === "rel")!.reversed_at).toBeTruthy();
  });

  it("…with a $57.47 sibling on account: one update over both rows, BOTH rows' lines read, every reopened month named", async () => {
    // The $600 split — $542.53 against January (released) and $57.47 on
    // account, put against February by the run.
    db.park_charges.push({ id: "charge-feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "feb-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 0, status: "open" });
    await releasedJanuary();
    db.park_payments.push({ id: "sib", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2027-01-05", receipt_no: 13, reversed_at: null, returned_at: null, idempotency_key: "form-rel:onaccount" });
    db.park_payment_allocations.push({ id: "al-f", park_id: PARK, payment_id: "sib", charge_id: "charge-feb", amount: 57.47, applied_via: "run", removed_at: null });
    recompute("charge-feb");
    const res = await reversePayment(PARK, "rel", "the cheque bounced");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe(
      "$600.00 taken back (receipt 12) — both halves of it, the $542.53 against January 2027 and the $57.47 on account. " +
      "January 2027's $542.53 bill was already cancelled, so nothing reopens on it, and $530.00 of it had been put against the $472.53 bill raised again for January 2027 (27 of 31 days) and February 2027 — those bills are outstanding again too. The record shows why.",
    );
    expect(updated.filter((u) => u.table === "park_payments")).toHaveLength(1);
    expect(db.park_payments.find((p) => p.id === "sib")!.reversed_at).toBe(db.park_payments.find((p) => p.id === "rel")!.reversed_at);
    expect(db.park_charges.find((c) => c.id === "charge-9p")).toMatchObject({ paid_total: 0, status: "open" });
    expect(db.park_charges.find((c) => c.id === "charge-feb")).toMatchObject({ paid_total: 0, status: "open" });
    // Tapped from the on-account half: the released half's line is read
    // too, and its void bill is still not said to reopen.
    reset();
    db.park_charges.push({ id: "charge-feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", reservation_id: "feb-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 0, status: "open" });
    await releasedJanuary();
    db.park_payments.push({ id: "sib", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2027-01-05", receipt_no: 13, reversed_at: null, returned_at: null, idempotency_key: "form-rel:onaccount" });
    const fromSib = await reversePayment(PARK, "sib", "keyed twice");
    expect(fromSib.ok, fromSib.error).toBe(true);
    expect(fromSib.signal).toBe(
      "$600.00 taken back (receipt 13) — both halves of it, the $542.53 against January 2027 and the $57.47 on account. " +
      "January 2027's $542.53 bill was already cancelled, so nothing reopens on it, and $472.53 of it had been put against the $472.53 bill raised again for January 2027 (27 of 31 days) — that one is outstanding again too. The record shows why.",
    );
    expect(fromSib.signal).not.toMatch(/The January 2027 bill is outstanding again/);
    expect(db.park_charges.find((c) => c.id === "charge-9p")).toMatchObject({ paid_total: 0, status: "open" });
  });

  it("a failed read of whether the row is on account refuses before anything is written", async () => {
    await releasedJanuary();
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    const res = await reversePayment(PARK, "rel", "the cheque bounced");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't check something just now, so no money has moved/);
    expect(nextReadError, "the view read never happened").toBeNull();
    expect(db.park_payments.find((p) => p.id === "rel")!.reversed_at).toBeNull();
    expect(updated).toHaveLength(0);
  });

  it("refundableOn on a released CARD row caps at the view's remaining, and the refund's sentence does not claim the void bill is outstanding", async () => {
    await releasedJanuary({ method: "card", reference: "ch_rel" });
    refundResult = { ok: true, ref: "re_1" };
    const tooMuch = await refundParkPayment(PARK, "rel", { amount: 70.01, feeAmount: 0, reason: "overpaid the part month", idempotencyKey: "k1" });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.error).toBe("That's more than is left on this payment — at most $70.00 can still go back.");
    expect(refundAsks).toBe(0);
    const ok = await refundParkPayment(PARK, "rel", { amount: 70, feeAmount: 0, reason: "overpaid the part month", idempotencyKey: "k2" });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.signal).toBe("$70.00 sent back to their card. It's off the household's account, and the record shows why.");
    expect(ok.signal).not.toMatch(/outstanding again/);
    expect(refundAsks).toBe(1);
    // The part month is untouched and the void bill holds 0 after the
    // refund's recompute.
    expect(db.park_charges.find((c) => c.id === "charge-9p")).toMatchObject({ paid_total: 472.53, status: "paid" });
    expect(db.park_charges.find((c) => c.id === "charge-9")).toMatchObject({ paid_total: 0, status: "void" });
    expect(onAccountView().find((v) => v.payment_id === "rel")!.remaining).toBe(0);
    // Collapsed the other way: a LIVE bill's card row still says the bill
    // reopens.
    reset();
    janBill("9");
    db.park_payments.push({ id: "live", park_id: PARK, renter_id: "renter-9", charge_id: "charge-9", kind: "rent", amount: 542.53, method: "card", reference: "ch_2", fee_amount: null, received_on: "2027-01-02", reversed_at: null, returned_at: null });
    recompute("charge-9");
    const onLive = await refundParkPayment(PARK, "live", { amount: 100, feeAmount: 0, reason: "x", idempotencyKey: "k3" });
    expect(onLive.signal).toMatch(/The bill is outstanding again by that much/);
  });

  it("a released CASH row is told to hand it back under Money not against a bill — refundRefusal gets `released`", async () => {
    await releasedJanuary();
    const res = await refundParkPayment(PARK, "rel", { amount: 70, feeAmount: 0, reason: "x", idempotencyKey: "k1" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/paid by check.*Hand it back across the window and record it with "Hand it back" on its line under Money not against a bill/);
    expect(res.error).not.toMatch(/It is against a bill/);
    expect(refundAsks).toBe(0);
  });

  it("neither refundableOn nor reversePayment decides 'on account' by charge_id alone — both read the view", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "park", "ledger-actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const refundable = src.match(/export async function refundableOn[\s\S]*?\n}/)?.[0] ?? "";
    const reverse = src.match(/export async function reversePayment[\s\S]*?\n}/)?.[0] ?? "";
    expect(refundable.length, "refundableOn not found — this scan measures nothing").toBeGreaterThan(500);
    expect(reverse.length, "reversePayment not found — this scan measures nothing").toBeGreaterThan(500);
    expect(refundable).not.toMatch(/!pay\.charge_id/);
    expect(refundable).toMatch(/from\("park_on_account_payments"\)[\s\S]*?\.eq\("payment_id", paymentId\)/);
    expect(refundable).toMatch(/if \(row\) \{/);
    // reversePayment: its own lines are read whenever the row is on account
    // — no bill, OR released — and the on-account sibling's beside them.
    expect(reverse).toMatch(/from\("park_on_account_payments"\)[\s\S]*?\.select\("payment_id, remaining, released_from_charge_id"\)[\s\S]*?\.in\("payment_id", \[paymentId, \.\.\.\(sibling \? \[sibling\.id\] : \[\]\)\]\)/);
    expect(reverse).toMatch(/const released = releasedRow\(paymentId\);/);
    expect(reverse).toMatch(/const sibReleased = sibling != null && releasedRow\(sibling\.id\);/);
    expect(reverse).toMatch(/const ownAcct = !pay\.charge_id \|\| released;/);
    expect(reverse).toMatch(/const sibAcct = sibling != null && \(!sibling\.charge_id \|\| sibReleased\);/);
    expect(reverse).toMatch(/\.in\("payment_id", acctRowIds\)/);
    expect(reverse).toMatch(/billCancelled: pay\.charge_id \? released : withSibling && sibReleased,/);
    expect(reverse.match(/!pay\.charge_id/g), "one for ownAcct, one for the sibling's bill month — never a third deciding on account").toHaveLength(2);
  });
});
