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
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
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
  method: "check", reference: "1042", payerName: "Household 9", lotNumber: "9",
  reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
});

const page = (other: OtherReceipt[], notes: string[] = [], over: Partial<StatementPage> = {}): StatementPage => ({
  parkName: "The Haven", period, summary: summariseReceipts([], period), receipts: [], otherReceipts: other,
  notes, cardFeesReceivedCents: 0, billedInWindowCents: 0, today: TODAY, generatedAt: "2027-02-02T12:00:00Z",
  ...over,
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

  it("money held for a household nothing more bills for does not promise a next bill — the held panel's own sentence, from the loader's read", () => {
    // The $57.47 half of a departed household's split: tenancy ended, the
    // part month billed. "It comes off the next bill raised for that
    // household" promised a bill the park will never raise, on the office's
    // own statement, while every other door had stopped.
    const gone = words(page([acct({ appliedTo: [], remainingCents: 5747, nothingMoreBills: true, movedOutOn: "2027-01-27" })]));
    expect(gone).toMatch(/Not yet put against a bill\. They moved out January 27, 2027 — nothing more bills for them; this is theirs to have back\./);
    expect(gone).not.toMatch(/comes off the next bill/);
    // Still here (read, and false): the promise stands.
    const here = words(page([acct({ appliedTo: [], remainingCents: 5747, nothingMoreBills: false, movedOutOn: null })]));
    expect(here).toMatch(/comes off the next bill raised for that household/);
    expect(here).not.toMatch(/nothing more bills/);
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

  // AND THE PART-PERIOD SENTENCE, which every test above this one missed
  // because they all ask for a month that is over. `open` is `to >= today`,
  // so this paragraph is the NORMAL state of the month being lived in — and
  // it printed `2027-01-31` two lines under the same date rendered through
  // longDate on the card above it.
  it("the part-period sentence, on a window that has not finished", () => {
    const jan = monthPeriod("2027-01", "2027-01-31")!;
    expect(jan.open).toBe(true);
    const open = page([acct({ receivedOn: "2027-01-03" })], [], {
      period: jan, summary: summariseReceipts([], jan), today: "2027-01-31",
    });
    const w = renderToStaticMarkup(
      <ParkStatements parkId="park-haven" page={open} today="2027-01-31" />,
    ).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(w).toMatch(/This window isn&#x27;t finished yet\./);
    expect(w).toMatch(/More money can still come in before January 31, 2027, so this is a part-period/);
    expect(w).not.toMatch(/2027-01-31/);
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
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "active" }];
    db.park_refunds = [];
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
    expect(w).toMatch(/\$1,085\.06 of the money on account has since been put against bills — the file says which months — and \$542\.53 is still held/);
  });

  it("untouched: the loader says [] and the screen says not yet applied — a read, not a guess", async () => {
    db.park_payment_allocations = [];
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(real.otherReceipts[0].appliedTo).toEqual([]);
    const w = words(real);
    expect(w).toMatch(/On account \(not yet applied\)/);
    expect(w).toMatch(/comes off the next bill raised for that household/);
  });

  it("the row names the household — Lot 9 · Household 9 — from the loader's own read", async () => {
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const w = words(real);
    const own = w.slice(w.indexOf("Money on account in this window"));
    expect(own).toMatch(/Lot 9 · Household 9/);
  });

  it("the bounced quarter cheque, through the real loader: on the screen, struck through, named, and in no total", async () => {
    // The cheque bounced on 10 February; the run had spent January and
    // February of it. Before: the off-book read filtered it out and this
    // screen, the notes and the file lost the row entirely.
    db.park_payments[0].reversed_at = "2027-02-10T20:30:00Z";
    db.park_payments[0].reversed_reason = "cheque 1042 bounced";
    db.park_on_account_payments = [];
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    const html = renderToStaticMarkup(<ParkStatements parkId="park-haven" page={real} today={TODAY} />);
    const w = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    const own = w.slice(w.indexOf("Money on account in this window"));
    expect(own).toMatch(/Lot 9 · Household 9/);
    expect(own).toMatch(/taken back/);
    expect(own).toMatch(/Taken back on February 10, 2027 — cheque 1042 bounced\. It counts toward nothing\./);
    expect(own).not.toMatch(/comes off the next bill/);
    expect(own).not.toMatch(/not yet applied|partly applied|Given back/);
    expect(html).toMatch(/line-through/);
    // Under "Worth a look", beside the rent rows' own taken-back list.
    expect(w).toMatch(/Worth a look/);
    expect(w).toMatch(/Lot 9 · Household 9 — \$1,627\.59 received on account on December 28, 2026 and then taken back: cheque 1042 bounced\. It is NOT counted in the totals above\./);
    // And the notes say it — not "received on account".
    expect(w).toMatch(/\$1,627\.59 that arrived in this period as a deposit, on account or for something you rent out was later taken back/);
    expect(w).not.toMatch(/NOT in the total above: \$1,627\.59 received on account/);
    expect(real.notes.join(" ")).not.toMatch(/received on account/);
  });

  it("a refund through the real loader: under Worth a look, in the notes, and the fee row is the loader's one figure", async () => {
    db.park_payments[0].method = "card"; db.park_payments[0].reference = "ch_9"; db.park_payments[0].fee_amount = 48.83;
    db.park_refunds = [{ id: "rf-1", payment_id: "q", park_id: PARK, amount: 542.53, fee_amount: 16.28, processor_ref: "re_9", reason: "one month too many", created_at: "2026-12-30T15:00:00Z" }];
    const real = (await getStatement(PARK, "2026-12-01", "2026-12-31"))!;
    expect(real.cardFeesReceivedCents).toBe(4883 - 1628);
    const w = words(real);
    expect(w).toMatch(/Lot 9 · Household 9 — \$542\.53 was sent back to the card on December 30, 2026, with \$16\.28 of card fee \(re_9\)\. It is NOT taken off the total above/);
    expect(w).toMatch(/\$542\.53 was sent back to a card in this period — Lot 9 \$542\.53 on December 30, 2026\./);
    expect(w).toMatch(/\$32\.55 card fees on top — not yours, not in the total/);
    expect(w).not.toMatch(/rent plus those fees/);
    // The refund row is NOT listed as money on account — it is money going out.
    // The on-account section is the LAST section, so "to the end" is the
    // section; the guard makes that explicit rather than sliced blind.
    const at = w.indexOf("Money on account in this window");
    expect(at).toBeGreaterThan(-1);
    const own = w.slice(at);
    expect(own).not.toMatch(/Worth a look/);
    expect((own.match(/December 30, 2026/g) ?? []).length).toBe(0);
  });
});

describe("the file blurb", () => {
  it("no longer says these rows have 'no lot' — every on-account row names one now", () => {
    const w = words(page([acct({ appliedTo: [] })]));
    expect(w).toMatch(/1 line is money that isn.{1,6}t rent against a bill/);
    expect(w).toMatch(/and no bill against them/);
    expect(w).not.toMatch(/no lot or bill/);
  });

  it("the button counts LINES, not payments — a refund or a hand-back is a line of money going out", () => {
    const w = words(page([acct({ appliedTo: [] }), acct({ paymentId: "rf", kind: "refund", amountCents: -4_000, method: "card", receivedOn: "2027-01-25" })]));
    expect(w).toMatch(/Download 2 lines for your accountant/);
    expect(w).not.toMatch(/Download 2 payments/);
    expect(words(page([acct({ appliedTo: [] })]))).toMatch(/Download 1 line for your accountant/);
  });

  it("the filter warning counts EVERY line marked Taken back — a bounced on-account cheque with no rent reversals still gets it", () => {
    // One reversed on-account row, no rent rows at all: the blurb keyed on
    // summary.reversed alone and said nothing over a file holding a marked row.
    const bounced = acct({ appliedTo: [], reversedAt: "2027-02-10T20:30:00Z", reversedReason: "cheque 1042 bounced" });
    const w = words(page([bounced]));
    expect(w).toMatch(/1 taken-back line is in the file too, marked (&quot;|")Taken back(&quot;|")/);
    expect(w).toMatch(/don.{1,6}t sum the Amount column without filtering that out/);
    // One of each: the count is the file's, two.
    const rent = { ...summariseReceipts([], period), count: 0, reversed: [{ paymentId: "r", lotNumber: "3", amountCents: 1, receivedOn: "2026-12-02", reversedReason: "typo" } as never], reversedCents: 1 };
    const both = words(page([bounced], [], { summary: rent }));
    expect(both).toMatch(/2 taken-back lines are in the file too/);
    // None: no warning.
    expect(words(page([acct({ appliedTo: [] })]))).not.toMatch(/taken-back line/);
  });

  it("names what the non-rent lines can be, hand-backs included", () => {
    const w = words(page([acct({ appliedTo: [] })]));
    expect(w).toMatch(/anything given back, whether sent back through the processor or handed back across the window/);
  });

  it("the summary card's fee row reads the loader's one figure, not the rent rows' alone", () => {
    const withFee = page([], [], { summary: { ...summariseReceipts([], period), count: 1, totalCents: 54253, cardFeesCents: 1628 }, cardFeesReceivedCents: 3428 });
    const w = words(withFee);
    expect(w).toMatch(/\$34\.28 card fees on top/);
    expect(w).not.toMatch(/\$16\.28/);
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

  it("reads the reason a row did not stay from the one helper — no fourth copy of the derivation here", () => {
    expect(src).toMatch(/takenBackWhy,?\s[\s\S]*?from "@\/app\/park\/receipts-helpers"/);
    expect(src).not.toMatch(/function takenBackWhy/);
    expect(src).not.toMatch(/returned by the bank/);
  });

  it("the blurb's taken-back count is the file's — rent rows plus the off-book rows beside them", () => {
    expect(src).toMatch(/const takenBack = s\.reversed\.length \+ otherGone\.length;/);
    expect(src).not.toMatch(/s\.reversed\.length\} taken-back/);
  });
});

/**
 * THE FOURTH EXIT, ON THE SCREEN. A hand-back across the window — the
 * deposit returned, the $57.47 handed to a household that has gone — is a
 * negative line in the file; the owner about to forward that file is told
 * so under "Worth a look" and in the notes, exactly as a refund is. And a
 * refund off an ACH payment says "bank account", not "card".
 */
describe("money handed back across the window, and the rail a refund went back on", () => {
  const handed = (over: Partial<OtherReceipt> = {}): OtherReceipt => ({
    paymentId: "pay-acct", kind: "handed_back", receivedOn: "2027-01-28", amountCents: -5_747, feeCents: 0,
    method: "check", reference: "moved out 27 January; nothing more bills", payerName: "Household 9", lotNumber: "9",
    reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });

  it("a hand-back is named under Worth a look, with the day and the reason, and never listed as money on account", () => {
    const w = words(page([acct({ appliedTo: [{ periodMonth: "2027-01", amountCents: 54_253 }], remainingCents: 0, amountCents: 60_000 }), handed()]));
    expect(w).toMatch(/Worth a look/);
    expect(w).toMatch(/Lot 9 · Household 9 — \$57\.47 was handed back to them on January 28, 2027 — moved out 27 January; nothing more bills\. It is NOT taken off the total above/);
    const at = w.indexOf("Money on account in this window");
    expect(at).toBeGreaterThan(-1);
    const own = w.slice(at);
    expect(own).not.toMatch(/January 28, 2027/);
    expect(own).not.toMatch(/handed back/);
    // The file's row count includes it.
    expect(w).toMatch(/Download 2 lines for your accountant/);
  });

  it("a deposit's return, with no reason on the record, prints no dangling dash", () => {
    const w = words(page([handed({ kind: "handed_back", amountCents: -50_000, method: "cash", reference: null, lotNumber: "14", payerName: "Household 14", receivedOn: "2027-02-03" })]));
    expect(w).toMatch(/Lot 14 · Household 14 — \$500\.00 was handed back to them on February 3, 2027\. It is NOT taken off/);
    expect(w).not.toMatch(/2027 — \./);
  });

  it("a refund off an ACH payment went back to their bank account, not the card", () => {
    const w = words(page([acct({ paymentId: "rf", kind: "refund", amountCents: -4_000, method: "ach", receivedOn: "2027-01-25", reference: "re_1" })]));
    expect(w).toMatch(/\$40\.00 was sent back to their bank account on January 25, 2027/);
    expect(w).not.toMatch(/sent back to the card/);
    const card = words(page([acct({ paymentId: "rf", kind: "refund", amountCents: -4_000, method: "card", receivedOn: "2027-01-25", reference: "re_1" })]));
    expect(card).toMatch(/\$40\.00 was sent back to the card on January 25, 2027/);
  });

  it("through the real loader: the $57.47 handed back after Lot 9 left is on the screen, in the notes, and the summary is untouched", async () => {
    for (const k of Object.keys(db)) delete db[k];
    const PARK = "park-haven";
    db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0 }];
    db.park_lots = [{ id: "lot-9", park_id: PARK, lot_number: "9" }];
    db.park_renters = [{ id: "renter-9", park_id: PARK, display_name: "Household 9" }];
    db.park_fees = [];
    db.park_charges = [{ id: "jan", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "paid", lines: [] }];
    db.park_payments = [
      { id: "bill-half", park_id: PARK, renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-05", reversed_at: null, returned_at: null, returned_on: null, returned_amount: null, return_note: null },
      { id: "acct-half", park_id: PARK, renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-05", reversed_at: null, returned_at: null, returned_on: "2027-01-28", returned_amount: 57.47, return_note: "moved out 27 January; nothing more bills" },
    ];
    db.park_payment_allocations = [];
    db.park_on_account_payments = [{ payment_id: "acct-half", park_id: PARK, remaining: 0 }];
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-01-01,2027-01-28)", moved_out_on: "2027-01-27" }];
    db.park_refunds = [];
    const real = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    const w = words(real);
    expect(w).toMatch(/\$542\.53 came in — 1 payment\./);
    expect(w).toMatch(/Lot 9 · Household 9 — \$57\.47 was handed back to them on January 28, 2027 — moved out 27 January; nothing more bills\./);
    expect(w).toMatch(/\$57\.47 was handed back across the window in this period — Lot 9 \$57\.47 of their money on account on January 28, 2027 \(moved out 27 January; nothing more bills\)\./);
    // The on-account row: given back, and it does not promise a next bill.
    const own = w.slice(w.indexOf("Money on account in this window"));
    expect(own).toMatch(/Given back\./);
    expect(own).not.toMatch(/comes off the next bill/);
    expect(w).toMatch(/Download 3 lines for your accountant/);
  });
});

/**
 * A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). Lot 9 paid
 * January in full, left on the 20th; the office cancelled the whole-month
 * bill and raised the part month again, settled from the released money;
 * $70.00 is still on account, later handed back. The receipt against the
 * cancelled bill is STILL the receipt — counted once, under "Worth a look"
 * as before — and the sentence there now says where the money went, in
 * words, from the loader's own read (`released`), so the writer and the
 * reader are proven together.
 */
describe("rent paid on a bill that was cancelled after it was paid", () => {
  const rec = (over: Partial<StatementPage["receipts"][number]> = {}): StatementPage["receipts"][number] => ({
    paymentId: "pay-jan", chargeId: "jan", amountCents: 54_253, feeCents: 0, method: "check", reference: "1042", receivedOn: "2027-01-04",
    lotNumber: "9", payerName: "Household 9", periodMonth: "2027-01", chargeAmountCents: 54_253, chargeStatus: "void", chargeLines: [],
    reversedAt: null, reversedReason: null, bankReturnedAt: null, returnCode: null, ...over,
  });
  const jan = monthPeriod("2027-01", TODAY)!;
  const withReceipt = (r: StatementPage["receipts"][number]) =>
    page([], [], { period: jan, receipts: [r], summary: summariseReceipts([r], jan) });
  // The render escapes the apostrophe in "It's"; read it back as a person would.
  const say = (p: StatementPage) => words(p).replace(/&#x27;/g, "'");

  const released = { allocations: [{ periodMonth: "2027-01", amount: 472.53 }], remainingCents: 7_000, handedBackCents: 0, handedBackOn: null, handedBackInFile: false, refundedCents: 0, refundedInFile: false };

  it("says where the released money went — the part month it paid and what is still held — and the hand-back when there is one", () => {
    const w = say(withReceipt(rec({ released })));
    expect(w).toMatch(/Lot 9 — \$542\.53 came in on January 4, 2027 against a bill that was later cancelled\. It's counted here because the money arrived\. It went on their account: \$472\.53 to January 2027, \$70\.00 on account\. /);
    expect(w).not.toMatch(/handed back/);
    // With the loader's figures on the row, "if you sent it back to a card"
    // is not a guess to make: nothing was refunded, so nothing is said.
    expect(w).not.toMatch(/If you sent it back to a card/);
    const handed = say(withReceipt(rec({ released: { ...released, remainingCents: 0, handedBackCents: 7_000, handedBackOn: "2027-01-22", handedBackInFile: true } })));
    expect(handed).toMatch(/It went on their account: \$472\.53 to January 2027\. \$70\.00 was handed back on January 22, 2027 — its own line below and in the file\. /);
    expect(handed).not.toMatch(/2027-01-22/);
    // A hand-back in the NEXT month is in February's file, and this screen
    // says so rather than promising a line below that is not there.
    const later = say(withReceipt(rec({ released: { ...released, remainingCents: 0, handedBackCents: 7_000, handedBackOn: "2027-02-03", handedBackInFile: false } })));
    expect(later).toMatch(/\$70\.00 was handed back on February 3, 2027 — its own line in the statement for February 2027\./);
    expect(later).not.toMatch(/below and in the file/);
    // A refund, likewise, by whether its negative row is in this file — and
    // NO RAIL IS NAMED. This said "went back to a card"; 0142 refunds ACH
    // too and `released` carries no method, so the card was an invention on
    // every bank refund. Pinned both ways: the words, and the absence.
    const refunded = say(withReceipt(rec({ released: { ...released, remainingCents: 0, refundedCents: 7_000, refundedInFile: true } })));
    expect(refunded).toMatch(/\$70\.00 went back — its own line below and in the file\./);
    expect(refunded).not.toMatch(/back to a card/);
    const refundedLater = say(withReceipt(rec({ released: { ...released, remainingCents: 0, refundedCents: 7_000, refundedInFile: false } })));
    expect(refundedLater).toMatch(/\$70\.00 went back — its own line in the statement for the month it went back\./);
    expect(refundedLater).not.toMatch(/back to a card/);
    // The colliding line — the part month shares January's period — is
    // named as the bill raised again, through the one allocation sentence.
    const collide = say(withReceipt(rec({ released: { ...released, allocations: [{ periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: "27 of 31 days" } }] } })));
    expect(collide).toMatch(/It went on their account: \$472\.53 to the bill raised again for January 2027 \(27 of 31 days\), \$70\.00 on account\./);
    // Nothing applied, nothing held, nothing handed back: it went back to a card.
    const none = say(withReceipt(rec({ released: { ...released, allocations: [], remainingCents: 0 } })));
    expect(none).toMatch(/It went on their account: none of it is still held\. /);
  });

  it("a cancelled bill the loader found nothing released for keeps the old sentence — no claim about where money went", () => {
    const w = say(withReceipt(rec()));
    // "If you sent it back" — not "back to a card": the same rail that is
    // unknown on the figures is unknown on the hypothetical.
    expect(w).toMatch(/against a bill that was later cancelled\. It's counted here because the money arrived\. If you sent it back, that refund is its own line below and in the file\./);
    expect(w).not.toMatch(/back to a card/);
    expect(w).not.toMatch(/went on their account/);
  });

  it("through the real loader: the released January, the part month, the $70 held — on the screen, in the notes, once in the total", async () => {
    for (const k of Object.keys(db)) delete db[k];
    const PARK = "park-haven";
    db.parks = [{ id: PARK, name: "The Haven", office_recording_lag_days: 0 }];
    db.park_lots = [{ id: "lot-9", park_id: PARK, lot_number: "9" }];
    db.park_renters = [{ id: "renter-9", park_id: PARK, display_name: "Household 9" }];
    db.park_fees = [];
    db.park_charges = [
      { id: "jan", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, status: "void", voided_at: "2027-01-20T16:00:00Z", lines: [] },
      { id: "jan-part", park_id: PARK, park_lot_id: "lot-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 472.53, status: "paid", lines: [] },
    ];
    db.park_payments = [
      { id: "pay-jan", park_id: PARK, renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, fee_amount: null, method: "check", reference: "1042", received_on: "2027-01-04", reversed_at: null, returned_at: null, returned_on: null, returned_amount: null, return_note: null },
    ];
    db.park_payment_allocations = [{ id: "al-part", park_id: PARK, payment_id: "pay-jan", charge_id: "jan-part", amount: 472.53, removed_at: null }];
    // The view as 0169 lists it: still against the void bill, released.
    db.park_on_account_payments = [{ payment_id: "pay-jan", park_id: PARK, remaining: 70, released_from_charge_id: "jan", released_from_month: "2027-01", released_on: "2027-01-20T16:00:00Z", handed_back: 0, handed_back_on: null }];
    db.lot_reservations = [{ id: "res-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", during: "[2026-01-01,2027-01-21)", moved_out_on: "2027-01-20" }];
    db.park_refunds = [];
    const real = (await getStatement(PARK, "2027-01-01", "2027-01-31"))!;
    expect(real.receipts[0].released, "the loader wrote it").toBeDefined();
    const w = say(real);
    expect(w).toMatch(/\$542\.53 came in — 1 payment\./);
    expect(w).toMatch(/Lot 9 — \$542\.53 came in on January 4, 2027 against a bill that was later cancelled\. It's counted here because the money arrived\. It went on their account: \$472\.53 to the bill raised again for January 2027, \$70\.00 on account\./);
    expect(w).toMatch(/\$542\.53 that Lot 9 paid on their January 2027 bill went on account for them when that bill was cancelled on January 20, 2027\./);
    expect(w).toMatch(/bill cancelled/);
    // Not a second row under money on account, and no on-account figure about it.
    expect(w).not.toMatch(/Money on account in this window/);
    expect(w).not.toMatch(/received on account/);
    expect(w).toMatch(/Download 1 line for your accountant/);
  });

  it("the screen prints the released figures through the one sentence helper and the one date formatter", () => {
    const src = readFileSync(fileURLToPath(new URL("./ParkStatements.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/describeAllocations\(r\.released\.allocations, r\.released\.remainingCents \/ 100\)/);
    // The hand-back's whereabouts through the note's own helper — one copy.
    expect(src).toMatch(/handedBackWhere\(r\.released, \{ asSentence: true \}\)/);
    expect(src).not.toMatch(/was handed back\$\{/);
    expect(src).not.toMatch(/released\.remainingCents \/ 100\)\.toFixed/);
    // THE REFUND'S WHEREABOUTS THE SAME WAY. This screen wrote the sentence
    // out inline while the note and the file said nothing about a refunded
    // release at all — three doorways, one of them speaking. The helper is
    // now the only writer here, and the rail it used to name is gone from
    // the whole file (refundRails, which DOES know the rail, lives in the
    // helpers and never reaches this component).
    expect(src).toMatch(/refundedWhere\(r\.released\)/);
    expect(src).not.toMatch(/refundedInFile \?/);
    expect(src).not.toMatch(/back to a card/);
  });
});
