import { describe, it, expect, vi, beforeEach } from "vitest";
import { receiptsCsv } from "./receipts-helpers";

/**
 * THE STATEMENT LOADER WRITES WHERE THE MONEY ON ACCOUNT WENT.
 *
 * For one round `OtherReceipt.appliedTo` and `ExclusionContext.
 * onAccountAppliedCents` were read by the CSV's Kind and Bill month cells,
 * by the note under the total and by the statement screen — and written by
 * NOTHING. The accountant's file printed "On account (not yet applied)" on
 * every on-account row forever, which was true of every such row until the
 * first run spent one, and a lie in the file he sends from that morning on.
 * Code, comment and test all agreed, all wrong about what was populated.
 *
 * So this calls the REAL getStatement against a fake of the tables it reads
 * and reads the CSV the screen would download — the caller, not the helper.
 */
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let nextReadError: { table: string; error: { code: string; message: string } } | null = null;

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** Payment ids the view leaves out — a row reversed between the loader's two reads. */
const viewDrops = new Set<string>();
/** park_on_account_payments, modelled (0167): standing rent with no bill, with the database's own `remaining` — live allocations AND refunds netted. */
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null && !viewDrops.has(String(p.id)))
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      const refunded = (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0);
      return { payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount,
        allocated: allocated / 100, refunded: refunded / 100, remaining: Math.max(0, cents(p.amount) - allocated - refunded) / 100 };
    });
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(r[c]) >= v); return this; }
  lte(c: string, v: string) { this.fs.push((r) => String(r[c]) <= v); return this; }
  private source(): Row[] { return this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []); }
  private resolve() {
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    return Promise.resolve({ data: this.source().filter((r) => this.fs.every((f) => f(r))), error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { getStatement } = await import("./receipts-actions");
const { ReadFailed } = await import("@/lib/must-read");

const PARK = "park-haven";
/** Column index in the file, by header — so a column added later shifts nothing here. */
const col = (csv: string, header: string) => csv.split("\r\n")[0].split(",").indexOf(header);
const rowFor = (csv: string, paymentId: string) =>
  csv.split("\r\n").map((l) => l.split(",")).find((cells) => cells.includes(paymentId))!;

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  nextReadError = null;
  db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0 }];
  db.park_lots = [{ id: "lot-9", park_id: PARK, lot_number: "9" }];
  db.park_renters = [{ id: "renter-9", park_id: PARK, display_name: "Household 9" }];
  db.park_fees = [];
  db.park_charges = [
    { id: "jan", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "paid", lines: [] },
    { id: "feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, status: "paid", lines: [] },
    { id: "mar", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-03", due_on: "2027-03-01", amount: 542.53, status: "open", lines: [] },
  ];
  // The quarter-ahead cheque, on account, received 28 December.
  db.park_payments = [
    { id: "q", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1627.59, fee_amount: null, method: "check", reference: "1042", received_on: "2026-12-28", reversed_at: null, returned_at: null },
  ];
  db.park_payment_allocations = [];
  db.park_refunds = [];
  viewDrops.clear();
});

describe("getStatement writes where the money on account has gone", () => {
  it("the December cheque, untouched: 'On account (not yet applied)', a blank Bill month, and appliedTo is [] — read, not unknown", async () => {
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts).toHaveLength(1);
    expect(page.otherReceipts[0].appliedTo).toEqual([]);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const row = rowFor(csv, "q");
    expect(row[col(csv, "Kind")]).toBe("On account (not yet applied)");
    expect(row[col(csv, "Bill month")]).toBe("");
    expect(page.notes.join(" ")).toContain("$1627.59 received on account");
    expect(page.notes.join(" ")).not.toMatch(/has since been put against bills/);
  });

  it("after the run spent two months of it: Kind 'On account (partly applied)', the months in the Bill month cell, and the note says what is still held", async () => {
    db.park_payment_allocations = [
      { id: "al-2", park_id: PARK, payment_id: "q", charge_id: "feb", amount: 542.53, removed_at: null },
      { id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null },
    ];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].appliedTo).toEqual([
      { periodMonth: "2027-02", amountCents: 54253 },
      { periodMonth: "2027-01", amountCents: 54253 },
    ]);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const row = rowFor(csv, "q");
    expect(row[col(csv, "Kind")]).toBe("On account (partly applied)");
    expect(row[col(csv, "Bill month")]).toBe("2027-01: 542.53; 2027-02: 542.53");
    // Cash basis untouched: the row is dated the day it arrived, counted once.
    expect(row[col(csv, "Date received")]).toBe("2026-12-28");
    expect(row[col(csv, "Amount")]).toBe("1627.59");
    expect(page.notes.join(" ")).toContain(
      "$1085.06 of the money on account has since been put against bills — the file says which months — and $542.53 is still held.",
    );
  });

  it("all three months applied: 'On account (applied)' and the note says all of it has gone", async () => {
    db.park_payment_allocations = ["jan", "feb", "mar"].map((c) => ({ id: `al-${c}`, park_id: PARK, payment_id: "q", charge_id: c, amount: 542.53, removed_at: null }));
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Kind")]).toBe("On account (applied)");
    expect(page.notes.join(" ")).toContain("All of the money on account has since been put against bills — the file says which months.");
  });

  it("an allocation taken back off its bill is not 'gone' anywhere, and another park's is never read", async () => {
    db.park_payment_allocations = [
      { id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null },
      { id: "al-x", park_id: PARK, payment_id: "q", charge_id: "feb", amount: 542.53, removed_at: "2027-02-04T00:00:00Z", removed_reason: "wrong month" },
      { id: "al-other", park_id: "park-other", payment_id: "q", charge_id: "jan", amount: 1, removed_at: null },
    ];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].appliedTo).toEqual([{ periodMonth: "2027-01", amountCents: 54253 }]);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Bill month")]).toBe("2027-01: 542.53");
    expect(page.notes.join(" ")).toContain("$542.53 of the money on account has since been put against bills");
  });

  it("a deposit and amenity money carry no answer at all — they are never applied to anything", async () => {
    db.park_payments.push(
      { id: "dep", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, fee_amount: null, method: "cash", reference: null, received_on: "2026-12-28", reversed_at: null, returned_at: null },
      { id: "boat", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "amenity", amount: 60, fee_amount: 1.8, method: "card", reference: "ch_1", received_on: "2026-12-29", reversed_at: null, returned_at: null },
    );
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const byId = new Map(page.otherReceipts.map((o) => [o.paymentId, o]));
    expect(byId.get("q")!.appliedTo).toEqual([]);
    expect("appliedTo" in byId.get("dep")!).toBe(false);
    expect("appliedTo" in byId.get("boat")!).toBe(false);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "dep")[col(csv, "Kind")]).toBe("Deposit (not income)");
    expect(rowFor(csv, "boat")[col(csv, "Kind")]).toBe("Rented out (income)");
  });

  it("a park that has never billed anybody still writes [] and 0 — the empty branch does not skip the fields", async () => {
    db.park_charges = [];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.receipts).toEqual([]);
    expect(page.otherReceipts[0].appliedTo).toEqual([]);
    expect(page.notes.join(" ")).toContain("$1627.59 received on account");
    expect(page.notes.join(" ")).not.toMatch(/has since been put against/);
  });

  it("'is still held' is the view's remaining, summed — a refund the JS subtraction would miss", async () => {
    // $600 on account, $542.53 to January, $57.47 refunded to a card:
    // received − applied says $57.47 is still held; the view says nothing
    // is. The accountant's file must print the view's figure.
    db.park_payments[0].amount = 600; db.park_payments[0].method = "card"; db.park_payments[0].reference = "ch_1";
    db.park_payment_allocations = [{ id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    db.park_refunds = [{ id: "rf-1", payment_id: "q", park_id: PARK, amount: 57.47, fee_amount: 0 }];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const note = page.notes.join(" ");
    expect(note).toContain("$542.53 of the money on account has since been put against bills — the file says which months — and none of it is still held.");
    expect(note).not.toMatch(/\$[\d.]+ is still held/);
    expect(note).not.toMatch(/\$57\.47/);
    // Per row too, so the screen can gate "comes off the next bill" on it.
    expect(page.otherReceipts[0].remainingCents).toBe(0);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Kind")]).toBe("On account (applied)");
  });

  it("the row carries what is still held only when the view had it; the untouched cheque holds all of it", async () => {
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].remainingCents).toBe(162_759);
    expect(page.notes.join(" ")).not.toMatch(/still held/);
    // Taken back between the two reads: absent from the view, so the row
    // carries no figure (the screen then says nothing about it) and the
    // total counts nothing for it.
    db.park_payments.push({ id: "gone", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 50, fee_amount: null, method: "cash", reference: null, received_on: "2026-12-29", reversed_at: null, returned_at: null });
    viewDrops.add("gone");
    const again = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const gone = again.otherReceipts.find((o) => o.paymentId === "gone")!;
    expect(gone.appliedTo).toEqual([]);
    expect("remainingCents" in gone).toBe(false);
    expect(again.otherReceipts.find((o) => o.paymentId === "q")!.remainingCents).toBe(162_759);
  });

  it("a failed read of what is still held throws — never 'still held' about a figure nobody looked at", async () => {
    db.park_payment_allocations = [{ id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2026-12-01", "2026-12-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError, "the view read happened").toBeNull();
  });

  it("a failed read of the allocations throws — never 'not yet applied' about money the run has spent", async () => {
    db.park_payment_allocations = [{ id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2026-12-01", "2026-12-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError, "the allocations read happened").toBeNull();
  });
});
