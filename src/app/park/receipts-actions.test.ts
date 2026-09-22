import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { receiptsCsv, notCollectedAt } from "./receipts-helpers";

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
/** Fail the next read on `table` whose filters name `column` — so one of two reads of the same table can fail alone. */
let nextReadErrorOn: { table: string; column: string; error: { code: string; message: string } } | null = null;

const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** Payment ids the view leaves out — a row reversed between the loader's two reads. */
const viewDrops = new Set<string>();
/**
 * park_on_account_payments, modelled (0167 + 0169): standing rent with no
 * bill, OR standing rent against a bill whose status is void (its money
 * released onto account — the row never moves), with the database's own
 * `remaining` — live allocations AND refunds netted — and the hand-back
 * stamp (0168) and the three released_* columns 0169 appends.
 */
function onAccountView(): Row[] {
  const chargeOf = (p: Row) => (db.park_charges ?? []).find((c) => c.id === p.charge_id);
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && (p.charge_id == null || chargeOf(p)?.status === "void")
      && p.reversed_at == null && p.returned_at == null && !viewDrops.has(String(p.id)))
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      const refunded = (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0);
      const handedBack = p.returned_on != null ? cents(p.returned_amount) : 0;
      const c = chargeOf(p);
      return { payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id ?? c?.renter_id ?? null, amount: p.amount,
        allocated: allocated / 100, refunded: refunded / 100, remaining: Math.max(0, cents(p.amount) - allocated - refunded - handedBack) / 100,
        handed_back: handedBack / 100, handed_back_on: (p.returned_on as string | null) ?? null,
        released_from_charge_id: c?.id ?? null, released_from_month: c?.period_month ?? null, released_on: c?.voided_at ?? null };
    });
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private cols: string[] = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.cols.push(c); this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.cols.push(c); this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  // A null never satisfies a range filter — PostgREST's rule, and the fake's.
  gte(c: string, v: string) { this.cols.push(c); this.fs.push((r) => r[c] != null && String(r[c]) >= v); return this; }
  lte(c: string, v: string) { this.cols.push(c); this.fs.push((r) => r[c] != null && String(r[c]) <= v); return this; }
  private source(): Row[] { return this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []); }
  private resolve() {
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    if (nextReadErrorOn && nextReadErrorOn.table === this.t && this.cols.includes(nextReadErrorOn.column)) {
      const e = nextReadErrorOn.error; nextReadErrorOn = null;
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
  nextReadErrorOn = null;
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
  // Household 9's live tenancy — the lot an on-account row is named by, the
  // same read the on-account receipt printer makes (money-actions).
  db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "active" }];
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
    expect(page.notes.join(" ")).toContain("$1,627.59 received on account");
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
      "$1,085.06 of the money on account has since been put against bills — the file says which months — and $542.53 is still held.",
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
    expect(page.notes.join(" ")).toContain("$1,627.59 received on account");
    // The household is named even before the park has raised a bill — the
    // roll and the lot are read ABOVE the empty branch now.
    expect(page.otherReceipts[0].payerName).toBe("Household 9");
    expect(page.otherReceipts[0].lotNumber).toBe("9");
    expect(page.notes.join(" ")).not.toMatch(/has since been put against/);
  });

  it("'is still held' is the view's remaining, summed — a refund the JS subtraction would miss", async () => {
    // $600 on account, $542.53 to January, $57.47 refunded to a card:
    // received − applied says $57.47 is still held; the view says nothing
    // is. The accountant's file must print the view's figure.
    db.park_payments[0].amount = 600; db.park_payments[0].method = "card"; db.park_payments[0].reference = "ch_1";
    db.park_payment_allocations = [{ id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    db.park_refunds = [{ id: "rf-1", payment_id: "q", park_id: PARK, amount: 57.47, fee_amount: 0, processor_ref: "re_1", reason: "overpaid", created_at: "2027-01-06T15:00:00Z" }];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const note = page.notes.join(" ");
    expect(note).toContain("$542.53 of the money on account has since been put against bills — the file says which months — and none of it is still held.");
    expect(note).not.toMatch(/\$[\d.]+ is still held/);
    // The refund went back on 6 JANUARY — outside December's window — so
    // December's file carries no refund row and no refund sentence. It is
    // January's, dated the day it went back (proven below). This test used
    // to PIN the omission for every window.
    expect(note).not.toMatch(/\$57\.47/);
    expect(page.otherReceipts.some((o) => o.kind === "refund")).toBe(false);
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

  it("the row says whether anything more bills for its household — still here: no; gone with the last month billed: yes — and a failed read throws", async () => {
    // "It comes off the next bill raised for that household" is a promise.
    // The held panel, the resident's home and the receipt all stop making
    // it once the tenancy has ended and the month they left in is billed;
    // the statement's row was the one doorway without the read.
    const here = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(here.otherReceipts[0]).toMatchObject({ nothingMoreBills: false, movedOutOn: null });
    // Gone on 27 January; the January part month stands on the link they left from.
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-06-01,2027-01-28)", moved_out_on: "2027-01-27" }];
    db.park_charges[0].reservation_id = "res-9";
    const gone = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(gone.otherReceipts[0]).toMatchObject({ nothingMoreBills: true, movedOutOn: "2027-01-27" });
    // Gone, but the last month's bill was cancelled and not raised again: a
    // next bill IS still coming, and settles from this money.
    db.park_charges[0].status = "void";
    const notYet = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(notYet.otherReceipts[0]).toMatchObject({ nothingMoreBills: false });
    // A deposit carries no such fact — it is never applied to anything.
    db.park_payments.push({ id: "dep", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, fee_amount: null, method: "check", reference: null, received_on: "2026-12-29", reversed_at: null, returned_at: null });
    const withDep = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect("nothingMoreBills" in withDep.otherReceipts.find((o) => o.paymentId === "dep")!).toBe(false);
    // The tenancy read is the shared one, and a failure throws rather than
    // rendering the promise: the fake fails the read that filters by renter.
    nextReadErrorOn = { table: "lot_reservations", column: "renter_id", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2026-12-01", "2026-12-31")).rejects.toBeInstanceOf(ReadFailed);
    const loader = readFileSync(fileURLToPath(new URL("./receipts-actions.ts", import.meta.url)), "utf8");
    expect(loader).toMatch(/from "@\/lib\/tenancy-facts"/);
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

/**
 * THE RULE IN ONE DOORWAY OF THREE. summariseReceipts and receiptsCsv keep
 * and mark a reversed payment AGAINST a bill; the off-book read filtered
 * reversed and bank-returned rows OUT, so a bounced quarter-ahead cheque on
 * account vanished from every window — no row, no note, and a hole in the
 * receipt-number sequence — while the note still said "Any amounts are
 * listed below so this still reconciles to your bank". Live today on the
 * cheque path: an office cheque needs no processor.
 */
describe("a bounced on-account cheque is kept, marked, and out of every total", () => {
  beforeEach(() => {
    // The cheque bounced on 10 February, after the run had spent January
    // and February of it. reversePayment leaves the allocations as record.
    db.park_payments[0].reversed_at = "2027-02-10T20:30:00Z";
    db.park_payments[0].reversed_reason = "cheque 1042 bounced";
    db.park_payment_allocations = [
      { id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null },
      { id: "al-2", park_id: PARK, payment_id: "q", charge_id: "feb", amount: 542.53, removed_at: null },
    ];
  });

  it("December's file still carries the row — with Taken back = YES, the reason, and the day on the lake's clock", async () => {
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const row = page.otherReceipts.find((o) => o.paymentId === "q")!;
    expect(row, "the bounced cheque dropped out of the file").toBeDefined();
    expect(notCollectedAt(row)).toBe("2027-02-10T20:30:00Z");
    expect(row.reversedReason).toBe("cheque 1042 bounced");
    expect(row.payerName).toBe("Household 9");
    expect(row.lotNumber).toBe("9");
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const cells = rowFor(csv, "q");
    expect(cells[col(csv, "Taken back")]).toBe("YES");
    expect(cells[col(csv, "Taken back how")]).toBe("office correction");
    expect(cells[col(csv, "Taken back on")]).toBe("2027-02-10");
    expect(cells[col(csv, "Reason")]).toBe("cheque 1042 bounced");
    expect(cells[col(csv, "Kind")]).toBe("On account (taken back)");
    expect(cells[col(csv, "Lot")]).toBe("9");
    expect(cells[col(csv, "Payer")]).toBe("Household 9");
    // Cash basis untouched: still dated the day it arrived, at what arrived.
    expect(cells[col(csv, "Date received")]).toBe("2026-12-28");
    expect(cells[col(csv, "Amount")]).toBe("1627.59");
  });

  it("and it is in NO figure: not received on account, nothing applied, nothing held — the note says it was taken back", async () => {
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const note = page.notes.join(" ");
    expect(note).not.toMatch(/received on account/);
    expect(note).not.toMatch(/has since been put against/);
    expect(note).not.toMatch(/still held/);
    expect(note).toContain("$1,627.59 that arrived in this period as a deposit, on account or for something you rent out was later taken back");
    // Its allocations are the record of where it HAD gone, not money anywhere now.
    const row = page.otherReceipts.find((o) => o.paymentId === "q")!;
    expect(row.appliedTo).toEqual([]);
    expect("remainingCents" in row).toBe(false);
    // And a standing cheque beside it is counted exactly as before.
    db.park_payments.push({ id: "q2", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, fee_amount: null, method: "cash", reference: null, received_on: "2026-12-29", reversed_at: null, returned_at: null });
    const again = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(again.notes.join(" ")).toContain("$100.00 received on account");
    expect(again.notes.join(" ")).not.toContain("$1,727.59");
  });

  it("a bank-returned on-account ACH takes the same path, with the bank's code", async () => {
    db.park_payments[0].reversed_at = null; db.park_payments[0].reversed_reason = null;
    db.park_payments[0].method = "ach"; db.park_payments[0].returned_at = "2027-01-08T14:00:00Z"; db.park_payments[0].return_code = "R01";
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const cells = rowFor(csv, "q");
    expect(cells[col(csv, "Taken back")]).toBe("YES");
    expect(cells[col(csv, "Taken back how")]).toBe("bank return");
    expect(cells[col(csv, "Reason")]).toBe("R01");
    expect(page.notes.join(" ")).not.toMatch(/received on account/);
  });

  it("a reversed DEPOSIT is kept and marked too, and out of the deposits figure", async () => {
    db.park_payments = [{ id: "dep", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, fee_amount: null, method: "cash", reference: null, received_on: "2026-12-28", reversed_at: "2026-12-29T15:00:00Z", reversed_reason: "keyed twice", returned_at: null }];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "dep")[col(csv, "Kind")]).toBe("Deposit (taken back)");
    expect(rowFor(csv, "dep")[col(csv, "Taken back")]).toBe("YES");
    expect(page.notes.join(" ")).not.toMatch(/in deposits taken/);
    expect(page.notes.join(" ")).toContain("$500.00 that arrived in this period as a deposit, on account or for something you rent out was later taken back");
  });
});

/**
 * THE HOUSEHOLD ON EVERY ON-ACCOUNT ROW. park_payments.renter_id and the
 * household's live tenancy are one join away, and the receipt the office
 * printed for the same cheque already says "Received from Household 9 / Lot
 * 9"; the file said nothing. The lot is the LIVE tenancy's (the same read
 * the receipt printer makes), never the allocated bills' — a cheque nothing
 * has touched yet must not stay anonymous.
 */
describe("the on-account row names the household", () => {
  it("Payer from the roll, Lot from the live tenancy — before anything is applied", async () => {
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].payerName).toBe("Household 9");
    expect(page.otherReceipts[0].lotNumber).toBe("9");
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Lot")]).toBe("9");
    expect(rowFor(csv, "q")[col(csv, "Payer")]).toBe("Household 9");
  });

  it("a household that has LEFT still names the lot it was for — the ended link's, never '?' and never blank", async () => {
    // Gone in February; the accountant tying cheque 1042 to a lot ledger in
    // April must still get Lot 9. The ended link is one status away.
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-01-01,2027-02-01)", moved_out_on: "2027-01-27" }];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].payerName).toBe("Household 9");
    expect(page.otherReceipts[0].lotNumber).toBe("9");
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Lot")]).toBe("9");
    expect(csv).not.toMatch(/\?/);
  });

  it("a cheque at signing with no link at all: a name and no lot — never '?'; the allocated bills' lot when the run has put it somewhere", async () => {
    db.lot_reservations = [];
    const page = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(page.otherReceipts[0].payerName).toBe("Household 9");
    expect(page.otherReceipts[0].lotNumber).toBeNull();
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "q")[col(csv, "Lot")]).toBe("");
    expect(csv).not.toMatch(/\?/);
    // The fallback: the bills the money was put against.
    db.park_payment_allocations = [{ id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null }];
    const again = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(again.otherReceipts[0].lotNumber).toBe("9");
  });

  it("the pick is the roll's own rule: the link covering today, else the next to start, else any live one, else the most recently ended — never whichever row came first", async () => {
    db.park_lots.push({ id: "lot-14", park_id: PARK, lot_number: "14" }, { id: "lot-2", park_id: PARK, lot_number: "2" });
    // A move within the park: on Lot 9 today, Lot 14 from the 1st of next month — listed successor FIRST.
    db.lot_reservations = [
      { id: "res-next", renter_id: "renter-9", park_lot_id: "lot-14", status: "approved", during: "[2026-11-01,2026-12-01)", moved_out_on: null },
      { id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "active", during: "[2026-09-15,2026-11-01)", moved_out_on: null },
    ];
    // todayLakeDate in this test file is the real clock; pin the ranges around it instead.
    const { todayLakeDate } = await import("@/lib/booking");
    const today = todayLakeDate();
    const shift = (iso: string, days: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    db.lot_reservations[0].during = `[${shift(today, 10)},${shift(today, 40)})`;   // the successor, starting in 10 days
    db.lot_reservations[1].during = `[${shift(today, -20)},${shift(today, 10)})`;  // covering today
    expect((await getStatement(PARK, "2026-12-01", "2026-12-31"))!.otherReceipts[0].lotNumber).toBe("9");
    // No link covers today (signed, moves in next month): the next to start.
    db.lot_reservations[1].status = "ended";
    db.lot_reservations[1].moved_out_on = shift(today, -1);
    expect((await getStatement(PARK, "2026-12-01", "2026-12-31"))!.otherReceipts[0].lotNumber).toBe("14");
    // Only ended links: the most recently ended, whichever row came first.
    db.lot_reservations = [
      { id: "res-old", renter_id: "renter-9", park_lot_id: "lot-2", status: "ended", during: "[2024-01-01,2025-01-01)", moved_out_on: "2024-12-20" },
      { id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2025-01-01,2027-02-01)", moved_out_on: "2027-01-27" },
    ];
    expect((await getStatement(PARK, "2026-12-01", "2026-12-31"))!.otherReceipts[0].lotNumber).toBe("9");
    db.lot_reservations.reverse();
    expect((await getStatement(PARK, "2026-12-01", "2026-12-31"))!.otherReceipts[0].lotNumber).toBe("9");
  });

  it("a failed read of the households' lots throws — never a blank Lot cell about a figure nobody looked at", async () => {
    nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2026-12-01", "2026-12-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError).toBeNull();
  });
});

/**
 * A REFUND IS ITS OWN NEGATIVE ROW ON THE DAY IT WENT BACK (0142). The
 * statement, its notes and its file never read park_refunds, so $140 that
 * went back to two cards was counted as received, the card-fee sentence
 * undercounted by the on-account card's fee, and the file the notes promised
 * "still reconciles to your bank" did not. Latent until
 * LAKELIFE_PAYMENTS_LIVE=true; card_fee_pct is 3.00 and accepts_online_rent
 * is on at the real park, so the day the switch flips this is reachable with
 * no code change.
 */
describe("refunds in the window are their own rows, named in the notes, and the fee figure is one figure", () => {
  beforeEach(() => {
    // Lot 26's January bill paid by card, with the 3% fee; Household 15's $600
    // on account by card, $18 fee. Two refunds in January: $100 off Lot 26's
    // bill payment on the 26th, $40 off Household 15's on-account card on the 25th.
    db.park_lots.push({ id: "lot-26", park_id: PARK, lot_number: "26" }, { id: "lot-15", park_id: PARK, lot_number: "15" });
    db.park_renters.push({ id: "renter-26", park_id: PARK, display_name: "Household 26" }, { id: "renter-15", park_id: PARK, display_name: "Household 15" });
    db.lot_reservations.push({ id: "res-15", renter_id: "renter-15", park_lot_id: "lot-15", status: "active" }, { id: "res-26", renter_id: "renter-26", park_lot_id: "lot-26", status: "active" });
    db.park_charges.push({ id: "jan-26", park_id: PARK, park_lot_id: "lot-26", renter_id: "renter-26", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "open", lines: [] });
    db.park_payments = [
      { id: "pay-card-26", park_id: PARK, renter_id: "renter-26", charge_id: "jan-26", kind: "rent", amount: 542.53, fee_amount: 16.28, method: "card", reference: "ch_26", received_on: "2027-01-20", reversed_at: null, returned_at: null },
      { id: "pay-card-15", park_id: PARK, renter_id: "renter-15", charge_id: null, kind: "rent", amount: 600, fee_amount: 18, method: "card", reference: "ch_15", received_on: "2027-01-20", reversed_at: null, returned_at: null },
    ];
    db.park_refunds = [
      { id: "rf-26", payment_id: "pay-card-26", park_id: PARK, amount: 100, fee_amount: 0, processor_ref: "re_26", reason: "charged too much", created_at: "2027-01-27T02:30:00Z" }, // 9:30pm on the 26th, lake time
      { id: "rf-15", payment_id: "pay-card-15", park_id: PARK, amount: 40, fee_amount: 1.2, processor_ref: "re_15", reason: "overpaid", created_at: "2027-01-25T15:00:00Z" },
    ];
  });

  it("each refund is a negative row dated the lake day it went back, tied to its payment, with the household", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const refunds = page.otherReceipts.filter((o) => o.kind === "refund");
    expect(refunds).toHaveLength(2);
    const r26 = refunds.find((o) => o.paymentId === "pay-card-26")!;
    expect(r26.amountCents).toBe(-10_000);
    expect(r26.feeCents).toBe(0);
    expect(r26.receivedOn, "9:30pm on the 26th at the lakes is the 27th in UTC — the lake day is the date").toBe("2027-01-26");
    expect(r26.reference).toBe("re_26");
    expect(r26.method).toBe("card");
    expect(r26.lotNumber).toBe("26");
    expect(r26.payerName).toBe("Household 26");
    const r15 = refunds.find((o) => o.paymentId === "pay-card-15")!;
    expect(r15.amountCents).toBe(-4_000);
    expect(r15.feeCents).toBe(-120);
    expect(r15.receivedOn).toBe("2027-01-25");
    expect(r15.lotNumber).toBe("15");
    // The payment rows themselves are untouched — money received stays the row it was.
    expect(page.summary.totalCents).toBe(54_253);
    expect(page.summary.count).toBe(1);
    expect(page.otherReceipts.find((o) => o.paymentId === "pay-card-15" && o.kind === "rent")!.amountCents).toBe(60_000);
    // In the file, the Amount column nets to the bank.
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const amountAt = col(csv, "Amount");
    const amounts = csv.split("\r\n").slice(1).map((l) => Number(l.split(",")[amountAt]));
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(54_253 + 60_000 - 10_000 - 4_000);
    expect(csv).toContain("Refund (given back)");
  });

  it("the notes name both refunds and say they are NOT taken off the total", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const line = page.notes.find((l) => /sent back to cards/.test(l))!;
    expect(line).toBeTruthy();
    expect(line).toContain("$140.00 was sent back to cards in this period — Lot 15 $40.00 on January 25, 2027; Lot 26 $100.00 on January 26, 2027.");
    expect(line).toContain("$1.20 of card fee went back with it.");
    expect(line).toMatch(/NOT taken off the total above/);
  });

  it("the card-fee figure is ONE figure: fees on rent plus fees on standing off-book rows, less what went back", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    // 16.28 on the bill row + 18.00 on the on-account card − 1.20 sent back.
    expect(page.cardFeesReceivedCents).toBe(1_628 + 1_800 - 120);
    expect(page.summary.cardFeesCents, "rent rows alone — the old sentence's figure").toBe(1_628);
    const line = page.notes.find((l) => /card fees/.test(l))!;
    expect(line).toContain("$33.08");
    expect(line).not.toContain("$16.28");
    // And the file's Card fee column sums to the same figure.
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const feeAt = col(csv, "Card fee");
    const fees = csv.split("\r\n").slice(1).map((l) => Number(l.split(",")[feeAt]));
    expect(Math.round(fees.reduce((a, b) => a + b, 0) * 100)).toBe(page.cardFeesReceivedCents);
  });

  it("a refund is in the window it went back, not the window the payment arrived — and the refunded payment may be in neither read", async () => {
    // Refund in February, off a payment that arrived in January.
    db.park_refunds = [{ id: "rf-26", payment_id: "pay-card-26", park_id: PARK, amount: 100, fee_amount: 0, processor_ref: "re_26", reason: "x", created_at: "2027-02-03T15:00:00Z" }];
    const jan = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(jan.otherReceipts.some((o) => o.kind === "refund")).toBe(false);
    expect(jan.notes.join(" ")).not.toMatch(/sent back/);
    const feb = (await getStatement(PARK, "2027-02-01", "2027-02-28"))!;
    const r = feb.otherReceipts.find((o) => o.kind === "refund")!;
    expect(r).toBeDefined();
    expect(r.receivedOn).toBe("2027-02-03");
    expect(r.lotNumber).toBe("26");
    expect(r.payerName).toBe("Household 26");
    expect(feb.notes.join(" ")).toContain("Lot 26 $100.00 on February 3, 2027");
  });

  it("a failed read of the refunds throws — never a file that 'reconciles to your bank' with the refunds missing", async () => {
    nextReadError = { table: "park_refunds", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2027-01-01", "2027-01-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError).toBeNull();
  });

  it("the summary card and the note read the same field — the screen cannot print $16.28 over a file summing to $34.28", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/ParkStatements.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/money\(page\.cardFeesReceivedCents\)/);
    expect(src, "the summary card is back on the rent-rows-only figure").not.toMatch(/money\(s\.cardFeesCents\)/);
    expect(src, "'rent plus those fees' — neither rent-plus-its-fees nor a bank total once the figure widened").not.toMatch(/rent plus those fees/);
    const loader = readFileSync(fileURLToPath(new URL("./receipts-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(loader).toMatch(/const cardFeesReceivedCents = summary\.cardFeesCents \+ otherFeesCents;/);
    expect(loader, "the off-book read filters standing again").not.toMatch(/\.is\("reversed_at", null\)/);
    expect(loader).not.toMatch(/\.is\("returned_at", null\)/);
    expect(loader).toMatch(/\.from\("park_refunds"\)/);
  });
});

/**
 * THE FOURTH EXIT REACHES THE BOOKS. Reversal, bank return and refund were
 * rows or sentences in the accountant's file; money handed back across the
 * window — a deposit returned (returnDeposit, live today, no processor), rent
 * on account handed back (0168) — was read by nothing. A $500 deposit
 * received in December and given back by park cheque in February was, in
 * February's file, nothing, while the note beneath still promised "Any
 * amounts are listed below so this still reconciles to your bank". The
 * record is the stamp on park_payments (returned_on / returned_amount /
 * return_note) — read by the day it went BACK, off the payments table, not
 * the on-account view.
 */
describe("money handed back across the window is its own negative row on the day it went back", () => {
  beforeEach(() => {
    // Lot 9's $600 cheque on 5 January: $542.53 against January, $57.47 on
    // account; they moved out on the 27th and the office handed the $57.47
    // back on the 28th. And Lot 14's $500 deposit from December, returned
    // on 3 February.
    db.park_lots.push({ id: "lot-14", park_id: PARK, lot_number: "14" });
    db.park_renters.push({ id: "renter-14", park_id: PARK, display_name: "Household 14" });
    db.lot_reservations = [
      { id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-01-01,2027-01-28)", moved_out_on: "2027-01-27" },
      { id: "res-14", renter_id: "renter-14", park_lot_id: "lot-14", status: "ended", during: "[2025-06-01,2027-02-01)", moved_out_on: "2027-01-31" },
    ];
    db.park_payments = [
      { id: "bill-half", park_id: PARK, renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-05", reversed_at: null, returned_at: null, returned_on: null, returned_amount: null, return_note: null },
      { id: "acct-half", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-05", reversed_at: null, returned_at: null, returned_on: "2027-01-28", returned_amount: 57.47, return_note: "moved out 27 January; nothing more bills" },
      { id: "dep-14", park_id: PARK, renter_id: "renter-14", charge_id: null, kind: "deposit", amount: 500, fee_amount: null, method: "cash", reference: null, received_on: "2026-12-10", reversed_at: null, returned_at: null, returned_on: "2027-02-03", returned_amount: 500, return_note: null },
    ];
  });

  it("January's file: the cheque's on-account half at $57.47 in, and a $57.47 'Handed back' row out on the 28th, tied to it, with the reason and the lot", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const rows = page.otherReceipts.filter((o) => o.kind === "handed_back");
    expect(rows, "the hand-back dropped out of the file").toHaveLength(1);
    const h = rows[0];
    expect(h.paymentId).toBe("acct-half");
    expect(h.amountCents).toBe(-5_747);
    expect(h.feeCents).toBe(0);
    expect(Object.is(h.feeCents, -0)).toBe(false);
    expect(h.receivedOn).toBe("2027-01-28");
    expect(h.method).toBe("check");
    expect(h.reference).toBe("moved out 27 January; nothing more bills");
    expect(h.lotNumber).toBe("9");
    expect(h.payerName).toBe("Household 9");
    // The payment row itself is untouched — money received stays the row it was.
    const acct = page.otherReceipts.find((o) => o.paymentId === "acct-half" && o.kind === "rent")!;
    expect(acct.amountCents).toBe(5_747);
    expect(page.summary.totalCents).toBe(54_253);
    // In the file, the Amount column nets to the bank: 542.53 + 57.47 − 57.47.
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const amountAt = col(csv, "Amount");
    const amounts = csv.split("\r\n").slice(1).map((l) => Number(l.split(",")[amountAt].replace(/"/g, "")));
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(54_253);
    const cells = csv.split("\r\n").map((l) => l.split(",")).filter((c) => c.includes("acct-half"));
    // The payment row's own Kind reads the view's `remaining`, which nets
    // the hand-back (0168's park_payment_remaining) — "given back", never
    // "not yet applied" about $57.47 the office handed across the counter.
    // The fake used to leave the stamp out of `remaining`, and this line
    // pinned the lie.
    expect(cells.map((c) => c[col(csv, "Kind")]).sort()).toEqual(["Handed back (given back)", "On account (given back)"].sort());
    // The deposit went back in February — not in January's file.
    expect(page.otherReceipts.some((o) => o.paymentId === "dep-14")).toBe(false);
  });

  it("the note names it — what it was, the day, the reason — and says it is NOT taken off the total", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const line = page.notes.find((l) => /handed back across the window/.test(l))!;
    expect(line).toBeTruthy();
    expect(line).toContain("$57.47 was handed back across the window in this period — Lot 9 $57.47 of their money on account on January 28, 2027 (moved out 27 January; nothing more bills).");
    expect(line).toMatch(/NOT taken off the total above/);
  });

  it("February's file: the December deposit's return is a −$500.00 'Handed back' row dated 3 February — in the window it went back, not the window it arrived", async () => {
    const feb = (await getStatement(PARK, "2027-02-01", "2027-02-28"))!;
    const h = feb.otherReceipts.find((o) => o.kind === "handed_back")!;
    expect(h, "the deposit's return is in no February file").toBeDefined();
    expect(h.paymentId).toBe("dep-14");
    expect(h.amountCents).toBe(-50_000);
    expect(h.receivedOn).toBe("2027-02-03");
    expect(h.method).toBe("cash");
    expect(h.reference).toBeNull();
    expect(h.lotNumber).toBe("14");
    expect(h.payerName).toBe("Household 14");
    expect(feb.notes.join(" ")).toContain("$500.00 was handed back across the window in this period — Lot 14 $500.00 of their deposit on February 3, 2027.");
    // December's file carries the deposit as received, with no hand-back row.
    const dec = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(dec.otherReceipts.some((o) => o.kind === "handed_back")).toBe(false);
    expect(dec.notes.join(" ")).toContain("$500.00 in deposits taken");
    expect(dec.notes.join(" ")).not.toMatch(/handed back/);
    const csv = receiptsCsv(feb.receipts, feb.otherReceipts, { parkName: feb.parkName, generatedAt: feb.generatedAt });
    expect(rowFor(csv, "dep-14")[col(csv, "Kind")]).toBe("Handed back (given back)");
    expect(rowFor(csv, "dep-14")[col(csv, "Amount")]).toBe("-500.00");
  });

  it("a failed read of the hand-backs throws — never a file that 'reconciles to your bank' with the park's own cheque missing", async () => {
    // The hand-back read is a SECOND park_payments read; the first (the
    // off-book rows, filtered on received_on) succeeds, so the fake fails
    // only the one whose filter names returned_on.
    nextReadErrorOn = { table: "park_payments", column: "returned_on", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2027-01-01", "2027-01-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadErrorOn, "the hand-back read happened").toBeNull();
  });

  it("the loader reads the hand-back ROWS off park_payments by the day they went back — the view's stamp columns feed only a released receipt's own figures", () => {
    const loader = readFileSync(fileURLToPath(new URL("./receipts-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(loader).toMatch(/\.gte\("returned_on", period\.from\)/);
    expect(loader).toMatch(/\.lte\("returned_on", period\.to\)/);
    // The negative rows are built from the park_payments read (handedBackInWindow),
    // never from the view: the view lists only rows that still stand and only
    // rent, and a deposit's return would drop out of the file.
    expect(loader).toMatch(/const handedBack: OtherReceipt\[\] = handedBackInWindow\.map/);
    expect(loader).not.toMatch(/handed_back_note/);
    const viewStamp = loader.match(/handed_back_on/g) ?? [];
    expect(viewStamp.length, "the view's stamp is read once, into Receipt.released").toBe(2);
    expect(loader).toMatch(/kind: "handed_back"/);
    // The four taken-back fields come from the one adapter, not four casts.
    expect(loader).toMatch(/\.\.\.takenBackOfRow\(p2\)/);
    // The lot: every status the roll reads, the roll's own rule.
    expect(loader).toMatch(/\.in\("status", \["approved", "active", "ended"\]\)/);
    expect(loader).toMatch(/coversDay\(/);
  });
});

/**
 * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). Lot 9 paid
 * January in full on the 4th, left on the 20th; the office cancelled the
 * whole-month bill and raised the part month again — $472.53, settled from
 * the released money — and $70.00 is still on account, later handed back.
 * The payment row never moved: it is still a RECEIPT against the cancelled
 * January, counted ONCE as rent received on the day it arrived; the view
 * now lists it too, and that is where "where did the $542.53 go" is read
 * from. The released money gets its own sentence and its own cell — never
 * folded into the on-account figures, whose population is money received
 * ON ACCOUNT in the window.
 */
describe("a receipt against a bill that was cancelled after it was paid — the money released onto account", () => {
  beforeEach(() => {
    db.park_charges = [
      { id: "jan", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "void", voided_at: "2027-01-20T16:00:00Z", void_reason: "moved out 20 January", lines: [] },
      { id: "jan-part", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 472.53, status: "paid", lines: [] },
    ];
    db.park_payments = [
      { id: "pay-jan", park_id: PARK, renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-04", reversed_at: null, returned_at: null, returned_on: null, returned_amount: null, return_note: null },
    ];
    db.park_payment_allocations = [
      { id: "al-part", park_id: PARK, payment_id: "pay-jan", charge_id: "jan-part", amount: 472.53, removed_at: null },
    ];
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-01-01,2027-01-21)", moved_out_on: "2027-01-20" }];
  });

  it("counts once as cash in, carries released.allocations and the view's remaining, and is not a second row under money on account", async () => {
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(page.summary.totalCents).toBe(54_253);
    expect(page.summary.count).toBe(1);
    expect(page.summary.againstVoided).toHaveLength(1);
    expect(page.receipts).toHaveLength(1);
    const r = page.receipts[0];
    expect(r.chargeStatus).toBe("void");
    // The part month shares the cancelled bill's month (the re-raise keeps
    // period_month), so its line is marked as the bill raised again — with
    // no days basis, since this bill carries no snapshot.
    expect(r.released, "the loader wrote where the released money went").toEqual({
      allocations: [{ periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: null } }],
      remainingCents: 7_000,
      handedBackCents: 0,
      handedBackOn: null,
      handedBackInFile: false,
      refundedCents: 0,
      refundedInFile: false,
    });
    // Once. The on-account rows are money with no bill; this row has one.
    expect(page.otherReceipts.filter((o) => o.paymentId === "pay-jan")).toHaveLength(0);
    // The file: still Rent, still dated the day it arrived, and the Bill
    // status cell ties the cancelled January to the paid part month.
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    const cells = rowFor(csv, "pay-jan");
    expect(cells[col(csv, "Kind")]).toBe("Rent");
    expect(cells[col(csv, "Date received")]).toBe("2027-01-04");
    expect(cells[col(csv, "Amount")]).toBe("542.53");
    expect(cells[col(csv, "Bill month")]).toBe("2027-01");
    expect(cells[col(csv, "Bill status")]).toBe("CANCELLED — money released on account: 2027-01: 472.53; still held: 70.00");
    expect(csv.split("\r\n").filter((l) => l.includes("pay-jan"))).toHaveLength(1);
  });

  it("the note gives the released money ITS OWN sentence — never the 'received on account' figure, whose population is different", async () => {
    // A standing $100 cheque on account beside it, nothing applied: the
    // on-account sentence is about the $100, and says nothing about the $70.
    db.park_payments.push({ id: "q2", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, fee_amount: null, method: "cash", reference: null, received_on: "2027-01-10", reversed_at: null, returned_at: null });
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const note = page.notes.join(" ");
    expect(note).toContain("$100.00 received on account");
    expect(note).not.toMatch(/\$170\.00/);
    expect(note).not.toMatch(/has since been put against bills/);
    const own = page.notes.find((l) => /went on account for them when that bill was cancelled/.test(l))!;
    expect(own, "the released money has no sentence of its own").toBeTruthy();
    // "…paid on their January 2027 bill … $472.53 to January 2027" was two
    // January bills under one word; the re-raise is named apart, with its
    // own frozen basis when the bill carries one.
    expect(own).toBe(
      "$542.53 that Lot 9 paid on their January 2027 bill went on account for them when that bill was cancelled on January 20, 2027. " +
      "It IS in the total above — it arrived as rent — and the file marks that bill CANCELLED and says where the money went: $472.53 to the bill raised again for January 2027, $70.00 still held.",
    );
    db.park_charges[1].lines = [{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }, { label: "Grounds", amount: 124.14, basis: "27 of 31 days" }];
    const withBasis = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!.notes.find((l) => /went on account for them when that bill was cancelled/.test(l))!;
    expect(withBasis).toContain("$472.53 to the bill raised again for January 2027 (27 of 31 days), $70.00 still held.");
    // A line against a DIFFERENT month (the released money settled February)
    // keeps its plain name: only the colliding month is qualified.
    db.park_charges[1].lines = [];
    db.park_charges.push({ id: "feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 70, status: "paid", lines: [] });
    db.park_payment_allocations.push({ id: "al-feb", park_id: PARK, payment_id: "pay-jan", charge_id: "feb", amount: 70, removed_at: null });
    const two = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!.notes.find((l) => /went on account for them when that bill was cancelled/.test(l))!;
    expect(two).toContain("$472.53 to the bill raised again for January 2027, $70.00 to February 2027.");
    db.park_charges.pop(); db.park_payment_allocations.pop();
    // Collapsed the other way: without the released row there is no sentence.
    db.park_payments.shift();
    const without = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(without.notes.some((l) => /bill was cancelled/.test(l))).toBe(false);
  });

  it("its hand-back is ONE negative row on the day it went back, and the receipt's released figures show it", async () => {
    db.park_payments[0].returned_on = "2027-01-22"; db.park_payments[0].returned_amount = 70; db.park_payments[0].return_note = "moved out; overpaid the part month";
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const rows = page.otherReceipts.filter((o) => o.kind === "handed_back");
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentId).toBe("pay-jan");
    expect(rows[0].amountCents).toBe(-7_000);
    expect(rows[0].receivedOn).toBe("2027-01-22");
    expect(rows[0].lotNumber).toBe("9");
    expect(page.receipts[0].released).toEqual({
      allocations: [{ periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: null } }],
      remainingCents: 0,
      handedBackCents: 7_000,
      handedBackOn: "2027-01-22",
      handedBackInFile: true,
      refundedCents: 0,
      refundedInFile: false,
    });
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "pay-jan")[col(csv, "Bill status")]).toBe("CANCELLED — money released on account: 2027-01: 472.53; handed back 2027-01-22: 70.00");
    // The Amount column nets to the bank: 542.53 in, 70.00 out.
    const amountAt = col(csv, "Amount");
    const amounts = csv.split("\r\n").slice(1).map((l) => Number(l.split(",")[amountAt].replace(/"/g, "")));
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(54_253 - 7_000);
    const own = page.notes.find((l) => /bill was cancelled/.test(l))!;
    expect(own).toContain("$472.53 to the bill raised again for January 2027, $70.00 handed back on January 22, 2027 — its own line below and in the file.");
    expect(own).not.toMatch(/still held/);
    expect(page.notes.join(" ")).toContain("Lot 9 $70.00 of their money on account on January 22, 2027 (moved out; overpaid the part month)");
  });

  it("a hand-back in the NEXT month is February's line, not January's — and January's note says so instead of promising a line it lacks", async () => {
    // The stamp is read off the view with no window; the negative row by
    // the day it went back. January's note said "its own line below and in
    // the file" about a $70.00 that was only in February's file, and the
    // CSV had no −70.00 line to match. The sentence keys on the loader's
    // own windowed hand-back read — the same read that writes the row.
    db.park_payments[0].returned_on = "2027-02-03"; db.park_payments[0].returned_amount = 70; db.park_payments[0].return_note = "moved out; overpaid the part month";
    const jan = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(jan.otherReceipts.filter((o) => o.kind === "handed_back")).toHaveLength(0);
    expect(jan.receipts[0].released).toMatchObject({ handedBackCents: 7_000, handedBackOn: "2027-02-03", handedBackInFile: false });
    const own = jan.notes.find((l) => /bill was cancelled/.test(l))!;
    expect(own).toContain("$70.00 handed back on February 3, 2027 — its own line in the statement for February 2027.");
    expect(own).not.toMatch(/below and in the file/);
    const csv = receiptsCsv(jan.receipts, jan.otherReceipts, { parkName: jan.parkName, generatedAt: jan.generatedAt });
    expect(csv).not.toMatch(/-70\.00/);
    // February's file carries the row, and the receipt itself is January's.
    const feb = (await getStatement(PARK, "2027-02-01", "2027-02-28"))!;
    expect(feb.otherReceipts.filter((o) => o.kind === "handed_back")).toHaveLength(1);
    expect(feb.receipts).toHaveLength(0);
    // A failed hand-back read throws — never a January note deciding for
    // itself, from the stamp's date, which file the line is in.
    nextReadErrorOn = { table: "park_payments", column: "returned_on", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2027-01-01", "2027-01-31")).rejects.toBeInstanceOf(ReadFailed);
  });

  it("a refund off the released row: the view's figure on the receipt, and whether its negative row is in THIS file", async () => {
    db.park_refunds = [{ id: "rf-1", park_id: PARK, payment_id: "pay-jan", amount: 70, fee_amount: 0, processor_ref: "re_1", created_at: "2027-02-05T15:00:00Z" }];
    db.park_payments[0].method = "card";
    const jan = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(jan.receipts[0].released).toMatchObject({ remainingCents: 0, refundedCents: 7_000, refundedInFile: false });
    const feb = (await getStatement(PARK, "2027-02-01", "2027-02-28"))!;
    expect(feb.otherReceipts.filter((o) => o.kind === "refund")).toHaveLength(1);
    db.park_refunds[0].created_at = "2027-01-25T15:00:00Z";
    const same = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(same.receipts[0].released).toMatchObject({ refundedCents: 7_000, refundedInFile: true });
  });

  it("a cancelled bill the view does not list — a void from before 0169, or a released row since taken back — carries nothing and says nothing", async () => {
    viewDrops.add("pay-jan");
    const page = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(page.summary.totalCents).toBe(54_253);
    expect("released" in page.receipts[0]).toBe(false);
    const csv = receiptsCsv(page.receipts, page.otherReceipts, { parkName: page.parkName, generatedAt: page.generatedAt });
    expect(rowFor(csv, "pay-jan")[col(csv, "Bill status")]).toBe("CANCELLED");
    expect(page.notes.some((l) => /bill was cancelled/.test(l))).toBe(false);
    // And a reversed one is out of every total, as before.
    viewDrops.clear();
    db.park_payments[0].reversed_at = "2027-01-25T15:00:00Z"; db.park_payments[0].reversed_reason = "bounced";
    const gone = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(gone.summary.totalCents).toBe(0);
    expect("released" in gone.receipts[0]).toBe(false);
  });

  it("the view is read for the park even with no on-account rows, and a failed read throws — never 'CANCELLED' with the money's whereabouts silently blank", async () => {
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2027-01-01", "2027-01-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError, "the view read happened").toBeNull();
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    await expect(getStatement(PARK, "2027-01-01", "2027-01-31")).rejects.toBeInstanceOf(ReadFailed);
    expect(nextReadError, "the allocations read happened for the released row").toBeNull();
  });

  it("the writer keys `released` on the view, never on the bill's status alone, and the on-account figures sum the on-account rows only", () => {
    const loader = readFileSync(fileURLToPath(new URL("./receipts-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(loader).toMatch(/\.select\("payment_id, remaining, refunded, released_from_charge_id, handed_back, handed_back_on"\)/);
    expect(loader).toMatch(/releasedOf\(p\.id as string\)/);
    expect(loader).toMatch(/const onAccountHeldCents = acctIds\.reduce/);
    expect(loader).toMatch(/\.filter\(\(a\) => acctIdSet\.has\(a\.payment_id as string\)\)/);
    expect(loader).toMatch(/releasedFromCancelled,/);
    expect(loader).not.toMatch(/releasedIds\.reduce/);
  });
});


/**
 * THE CALLER, not the sentence. `exclusionLines` can be given a go-live date
 * all day; what decides whether the owner ever sees the line is whether the
 * LOADER reads `parks.cutover_date` and hands it over with the window it is
 * describing. The field this replaces (`recordsBeginOn`) was computed,
 * declared on the returned page, passed into the note — and read by nothing
 * anywhere, for its whole life. A symbol with no caller.
 */
describe("the statement says when a window is from before the park's books begin", () => {
  it("reads the go-live date with the park and says so on a pre-cutover window — in words", async () => {
    db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0, cutover_date: "2026-12-15" }];
    db.park_payments = [];
    const dec = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(dec.notes[0]).toMatch(/These dates are all before you went live here on December 15, 2026/);
    expect(dec.notes[0]).toMatch(/Your books here start with January 2027/);
    // Collapsed the other way: January is the park's own month, and hears
    // nothing about a takeover.
    const jan = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(jan.notes.some((l) => /went live here/.test(l))).toBe(false);
    // THROUGH THE OTHER DOORWAY TOO. A park with no bills raised at all
    // returns early, and that early return is exactly the December shape
    // this line exists for — it used to hardcode the note's context.
    db.park_charges = [];
    const bare = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(bare.receipts).toEqual([]);
    expect(bare.notes[0]).toMatch(/These dates are all before you went live here on December 15, 2026/);
  });

  it("a park with no go-live date set is told nothing — the note never invents the day", async () => {
    db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0, cutover_date: null }];
    db.park_payments = [];
    const dec = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(dec.notes.some((l) => /went live here/.test(l))).toBe(false);
  });

  it("the loader asks for the column and passes the window it is describing, and carries no unread edge-of-records field", () => {
    const loader = readFileSync(fileURLToPath(new URL("./receipts-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(loader).toMatch(/\.select\("name, office_recording_lag_days, cutover_date"\)/);
    expect(loader).toMatch(/const cutoverOn = /);
    // BOTH doorways: the early return for a window with no bills at all is
    // exactly the December case this line exists for, and it used to be the
    // one that got `recordsBeginOn: null` hardcoded.
    expect(loader.match(/cutoverOn, windowEndsOn: period\.to,/g) ?? []).toHaveLength(2);
    expect(loader).not.toMatch(/recordsBeginOn/);
  });
});
