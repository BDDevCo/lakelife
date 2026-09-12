import { describe, it, expect, vi, beforeEach } from "vitest";
import { todayLakeDate } from "@/lib/booking";
import { receiptBody } from "./receipt-helpers";
import { runSummary } from "./ledger-helpers";

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
let receiptNo = 100;

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private cap: number | null = null;
  private pending: Row[] | null = null;
  private patch: Row | null = null;
  private failed: { code: string; message: string } | null = null;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c: string, _op: string, v: unknown) { this.fs.push((r) => !(v === null ? r[c] == null : r[c] === v)); return this; }
  order() { return this; }
  limit(n: number) { this.cap = n; return this; }
  private rows(): Row[] {
    let out = (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r)));
    if (this.cap != null) out = out.slice(0, this.cap);
    return out;
  }
  insert(row: Row | Row[]) {
    const rows = Array.isArray(row) ? row : [row];
    insertCalls.push(rows.length);
    if (this.t === "park_payments" && nextInsertError) {
      this.failed = nextInsertError; nextInsertError = null; return this;
    }
    const written = rows.map((r) => {
      const w: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, ...r };
      if (this.t === "park_payments") {
        // assign_receipt_no, and sync_charge_paid — the two triggers whose
        // effect the action reads back.
        w.receipt_no = ++receiptNo;
        if (w.fee_amount === undefined) w.fee_amount = null;
        if (w.charge_id) {
          const c = (db.park_charges ?? []).find((x) => x.id === w.charge_id);
          if (c) c.paid_total = Math.round((Number(c.paid_total) + Number(w.amount)) * 100) / 100;
        }
      }
      (db[this.t] ??= []).push(w);
      inserted.push({ ...w, __table: this.t });
      return w;
    });
    this.pending = written;
    return this;
  }
  update(patch: Row) {
    if (nextUpdateError && nextUpdateError.table === this.t) {
      this.failed = nextUpdateError.error; nextUpdateError = null; return this;
    }
    this.patch = patch; return this;
  }
  single() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  private resolve(): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> {
    if (this.failed) return Promise.resolve({ data: null, error: this.failed });
    if (this.pending) return Promise.resolve({ data: this.pending, error: null });
    if (this.patch) {
      const hit = this.rows();
      for (const r of hit) Object.assign(r, this.patch);
      updated.push({ table: this.t, patch: this.patch });
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
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
  giveRefund: async () => refundResult,
}));

const {
  recordPayment, confirmClaimCollected, reversePayment, emailReceipt, refundParkPayment,
  previewChargeRun, runCharges,
} = await import("./ledger-actions");

const PARK = "park-haven";
const TODAY = todayLakeDate();
/** The Haven's real lots — no lot 3, no lot 8. */
const HAVEN = ["1", "2", "6", "7", "9", "10", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "26"];

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  inserted.length = 0; updated.length = 0; insertCalls.length = 0; emails.length = 0;
  nextInsertError = null; nextUpdateError = null; receiptNo = 100;
  emailResult = { ok: true };
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
    expect(res.signal).toBe(
      "$600.00 received — $542.53 against January 2027, $57.47 on account. " +
      "Put it against February 2027 when you raise it — it's under \"Money not against a bill\".",
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
    expect(body).toMatch(/held by the office and hasn't been put/);
    expect(body).toMatch(/TH-\d{4}-0102/);
    expect(body).not.toMatch(/In credit/);
    // No promise the software does not keep.
    expect(body).not.toMatch(/come off your next bill/);
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
    expect(res.signal).toMatch(/\$57\.47 received — January 2027 was already settled, so all of it is on account\./);
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
    expect(runSummary(pre.plan!, "2027-02")).toBe("Bill 10 households for February 2027 — $5425.30 · 8 agreements have run out");

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
    expect(runSummary(pre.plan!, "2027-02")).toBe("Bill 18 households for February 2027 — $9765.54");
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
