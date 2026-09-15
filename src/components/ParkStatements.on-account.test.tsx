import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StatementPage } from "@/app/park/receipts-actions";
import type { OtherReceipt } from "@/app/park/receipts-helpers";
import { summariseReceipts, monthPeriod } from "@/app/park/receipts-helpers";

/**
 * THE STATEMENT SHOWS MONEY ON ACCOUNT, AND WHERE IT HAS SINCE GONE (0167).
 *
 * The screen listed only payments against a bill; money on account reached
 * it as a sentence ("$1,627.59 received on account") and a row in the file
 * with a blank Bill month. Once the run puts that cheque against January,
 * February and March, the accountant's question — which months did the
 * 28 December cheque pay? — has an answer, and the screen gives it against
 * each month, on the row, without moving the cash off the day it arrived.
 *
 * `appliedTo` is WRITTEN by the statement loader (receipts-actions
 * getStatement, since round 2 — for one round it was read here and written
 * by nothing). The last describe below runs the REAL loader against a fake
 * of its tables and renders this screen from what it returns, so the
 * writer and the reader are proven together. When a caller has not read it
 * (undefined) the screen still makes NO claim either way — "not yet applied"
 * is a fact only when the read said so ([]).
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(r[c]) >= v); return this; }
  lte(c: string, v: string) { this.fs.push((r) => String(r[c]) <= v); return this; }
  private resolve() {
    return Promise.resolve({ data: (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))), error: null });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));
// The REAL loader, on a fake of its tables — ParkStatements imports it for
// the client-side window change, which a static render never reaches.
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (t: string) => new Q(t) }) }));
vi.mock("@/app/park/ledger-actions", () => ({
  reversePayment: async () => ({ ok: true }), refundParkPayment: async () => ({ ok: true }), refundableOn: async () => ({ amount: 0, fee: 0 }),
}));

const { ParkStatements } = await import("./ParkStatements");
const { getStatement } = await import("@/app/park/receipts-actions");

const TODAY = "2027-02-02";
const period = monthPeriod("2026-12", TODAY)!;

const acct = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
  paymentId: "pay-acct", kind: "rent", receivedOn: "2026-12-28", amountCents: 162759, feeCents: 0,
  method: "check", reference: "1042", ...over,
});

const page = (other: OtherReceipt[], notes: string[] = []): StatementPage => ({
  parkName: "The Haven", period, summary: summariseReceipts([], period), receipts: [], otherReceipts: other,
  notes, recordsBeginOn: "2026-12-28", billedInWindowCents: 0, today: TODAY, generatedAt: "2027-02-02T12:00:00Z",
});

const words = (p: StatementPage) =>
  renderToStaticMarkup(<ParkStatements parkId="park-haven" page={p} today={TODAY} />)
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("money on account, on the screen and against the months it settled", () => {
  it("lists the row, on the day it arrived, at what arrived", () => {
    const w = words(page([acct({ appliedTo: [] })]));
    expect(w).toMatch(/Money on account in this window/);
    expect(w).toMatch(/December 28, 2026/);
    expect(w).toMatch(/\$1,627\.59/);
    expect(w).toMatch(/check 1042/);
  });

  it("says which months it has since paid, in month order, and calls it partly applied", () => {
    const w = words(page([acct({ appliedTo: [
      { periodMonth: "2027-02", amountCents: 54253 },
      { periodMonth: "2027-01", amountCents: 54253 },
    ] })]));
    const jan = w.indexOf("$542.53 to January 2027");
    const feb = w.indexOf("$542.53 to February 2027");
    expect(jan).toBeGreaterThan(0);
    expect(feb).toBeGreaterThan(jan);
    expect(w).toMatch(/On account \(partly applied\)/);
  });

  it("a cheque every cent of which has gone to bills reads as applied", () => {
    const w = words(page([acct({ appliedTo: [
      { periodMonth: "2027-01", amountCents: 54253 }, { periodMonth: "2027-02", amountCents: 54253 }, { periodMonth: "2027-03", amountCents: 54253 },
    ] })]));
    expect(w).toMatch(/On account \(applied\)/);
    expect(w).toMatch(/\$542\.53 to March 2027/);
  });

  it("money the read said nothing has touched says so, and that it comes off the next bill", () => {
    // "Comes off the next bill" is promised only while the view says the
    // money is still held — remainingCents is the loader's figure, not ours.
    const w = words(page([acct({ appliedTo: [], remainingCents: 162759 })]));
    expect(w).toMatch(/On account \(not yet applied\)/);
    expect(w).toMatch(/comes off the next bill raised for that household/);
  });

  it("money given back, or whose held figure was not read, promises nothing", () => {
    const back = words(page([acct({ appliedTo: [], remainingCents: 0 })]));
    expect(back).toMatch(/Given back\./);
    expect(back).not.toMatch(/comes off the next bill/);
    const unread = words(page([acct({ appliedTo: [] })]));
    expect(unread).not.toMatch(/comes off the next bill/);
    expect(unread).not.toMatch(/Given back/);
  });

  it("a caller that did not read where it went makes no claim either way", () => {
    // undefined is "we did not look", not "nothing applied". The real loader
    // always writes [] or the months for rent on account (proven below); a
    // caller built before it did must still not read as "nothing applied".
    const w = words(page([acct()]));
    expect(w).toMatch(/\$1,627\.59/);
    expect(w).not.toMatch(/not yet applied/);
    expect(w).not.toMatch(/partly applied/);
    expect(w).not.toMatch(/comes off the next bill/);
  });

  it("does not list deposits or amenity money under it — those are not on account", () => {
    const w = words(page([
      acct({ paymentId: "dep", kind: "deposit", amountCents: 50000 }),
      acct({ paymentId: "boat", kind: "amenity", amountCents: 15000 }),
    ]));
    expect(w).not.toMatch(/Money on account in this window/);
  });

  it("never moves the cash off the day it arrived — the section says so", () => {
    const w = words(page([acct({ appliedTo: [{ periodMonth: "2027-01", amountCents: 54253 }] })]));
    expect(w).toMatch(/counted on the day it arrived/);
  });
});

describe("dates a person reads on this screen are words", () => {
  it("the window and the rows", () => {
    const w = words(page([acct({ appliedTo: [] })]));
    expect(w).toMatch(/December 1, 2026 to December 31, 2026/);
    // Everything from the on-account section down is this screen's own
    // rendering. (The headline's "between 2026-12-01 and 2026-12-31" is
    // receiptsHeadline's, in receipts-helpers — flagged, not owned here.)
    const own = w.slice(w.indexOf("Money on account in this window"));
    expect(own.length).toBeGreaterThan(40);
    expect(own).not.toMatch(/2026-12-\d\d/);
  });
});

/**
 * THE WRITER AND THE READER, TOGETHER. getStatement on the quarter-ahead
 * cheque with two months applied by the run, rendered by this screen.
 */
describe("through the real loader: the December cheque and the months the run has put it against", () => {
  const PARK = "park-haven";
  beforeEach(() => {
    for (const k of Object.keys(db)) delete db[k];
    db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0 }];
    db.park_lots = [{ id: "lot-9", park_id: PARK, lot_number: "9" }];
    db.park_renters = [{ id: "renter-9", park_id: PARK, display_name: "Household 9" }];
    db.park_fees = [];
    db.park_charges = [
      { id: "jan", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "paid", lines: [] },
      { id: "feb", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, status: "paid", lines: [] },
      { id: "mar", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-03", due_on: "2027-03-01", amount: 542.53, status: "open", lines: [] },
    ];
    db.park_payments = [
      { id: "q", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1627.59, fee_amount: null, method: "check", reference: "1042", received_on: "2026-12-28", reversed_at: null, returned_at: null },
    ];
    db.park_payment_allocations = [
      { id: "al-2", park_id: PARK, payment_id: "q", charge_id: "feb", amount: 542.53, removed_at: null },
      { id: "al-1", park_id: PARK, payment_id: "q", charge_id: "jan", amount: 542.53, removed_at: null },
      // Taken back off March by the office — the record, not money against a bill.
      { id: "al-3", park_id: PARK, payment_id: "q", charge_id: "mar", amount: 542.53, removed_at: "2027-03-02T15:00:00Z", removed_reason: "wrong month" },
    ];
    // The view's answer for what is still held — the loader reads THIS for
    // "is still held", never amount − applied in JavaScript.
    db.park_on_account_payments = [{ payment_id: "q", park_id: PARK, remaining: 542.53 }];
  });

  it("the row reads partly applied, names January and February in order, and never March", async () => {
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(real.otherReceipts[0].appliedTo, "the loader wrote it").toBeDefined();
    const w = words(real);
    expect(w).toMatch(/Money on account in this window/);
    expect(w).toMatch(/December 28, 2026/);
    expect(w).toMatch(/On account \(partly applied\)/);
    const jan = w.indexOf("$542.53 to January 2027");
    const feb = w.indexOf("$542.53 to February 2027");
    expect(jan).toBeGreaterThan(0);
    expect(feb).toBeGreaterThan(jan);
    expect(w).not.toMatch(/to March 2027/);
    // And the note under the total says what is still held — the loader's
    // onAccountAppliedCents, written into the same page.
    expect(w).toMatch(/\$1085\.06 of the money on account has since been put against bills — the file says which months — and \$542\.53 is still held/);
  });

  it("untouched: the loader says [] and the screen says not yet applied — a read, not a guess", async () => {
    db.park_payment_allocations = [];
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(real.otherReceipts[0].appliedTo).toEqual([]);
    const w = words(real);
    expect(w).toMatch(/On account \(not yet applied\)/);
    expect(w).toMatch(/comes off the next bill raised for that household/);
  });
});

describe("the loader that feeds this screen", () => {
  // The screen renders `appliedTo` when the statement carries it. The type
  // has the field (receipts-helpers, 0167); this pins that the screen reads
  // it by that name, so the loader's write and the screen's read cannot
  // drift.
  const src = readFileSync(fileURLToPath(new URL("./ParkStatements.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads appliedTo and the shared kind label — no second definition of 'applied' here", () => {
    expect(src).toMatch(/o\.appliedTo/);
    expect(src).toMatch(/onAccountKindLabel\(o\)/);
    expect(src).not.toMatch(/"On account \((not yet |partly )?applied\)"/);
  });
});
