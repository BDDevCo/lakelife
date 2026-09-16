import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadFailed } from "@/lib/must-read";

/**
 * THE RENT PAGE READS WHERE MONEY ON ACCOUNT WENT, AND THE PANEL SHOWS IT.
 *
 * The real page, with its loaders faked at their module boundary and the
 * allocations read against a fake service client — so the thing under test
 * is the page's own read (the one writer of the panel's `allocations` prop),
 * its join to the bill's month, and the panel rendering what it was handed.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let nextReadError: { table: string; error: { code: string; message: string } } | null = null;

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  private rows(): Row[] {
    return (db[this.t] ?? []).filter((r) => this.fs.every((f) => f(r))).map((r) => {
      // The embedded bill, as PostgREST returns a many-to-one: an object.
      if (this.t !== "park_payment_allocations") return r;
      const c = (db.park_charges ?? []).find((x) => x.id === r.charge_id);
      return { ...r, park_charges: c ? { period_month: c.period_month } : null };
    });
  }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e }).then(ok, bad);
    }
    return Promise.resolve({ data: this.rows(), error: null }).then(ok, bad);
  }
}

const quarterRow = () => ({
  paymentId: "pay-acct", renterId: "renter-9", renterName: "Household 9",
  amount: 1627.59, remaining: 542.53, allocated: 1085.06, refunded: 0, refunds: [], handedBack: 0, handedBackOn: null, handedBackNote: null,
  method: "check", receivedOn: "2026-12-28", reference: "1042", receiptNo: 12, split: null,
  tenancyEnded: false, movedOutOn: null, finalMonthBilled: false,
});
const held = {
  onAccount: [quarterRow()],
  deposits: [], onAccountTotal: 542.53, depositsHeldTotal: 0,
};

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/Toast", () => ({ toast: Object.assign(() => {}, { ok: () => {}, err: () => {} }) }));
vi.mock("@/components/Brand", () => ({ TopBar: () => <i>topbar</i> }));
vi.mock("@/components/ParkNav", () => ({ ParkNav: () => <i>nav</i> }));
vi.mock("@/components/ParkRent", () => ({ ParkRent: () => <i>rent</i> }));
vi.mock("@/lib/env", () => ({ hasSupabaseEnv: () => true }));
vi.mock("@/app/park/data", () => ({ getMyPark: async () => ({ id: "park-haven", name: "The Haven" }) }));
// Switchable so the page's own guard on a null ledger can be pinned both ways.
let ledger: Record<string, unknown> | null = { month: "2027-03", rows: [], claims: {}, summary: {}, lagDays: 3, today: "2027-03-02" };
vi.mock("@/app/park/ledger-actions", () => ({
  getLedger: async () => ledger,
  reversePayment: async () => ({ ok: true }),
  emailReceipt: async () => ({ ok: true }),
  takeDropSlipSerials: async () => ({ ok: true }),
}));
vi.mock("@/app/park/money-actions", () => ({
  getHeldMoney: async () => held,
  getHouseholds: async () => [{ id: "renter-9", name: "Household 9" }],
  getOpenChargesForApply: async () => [{ id: "charge-mar", renterId: "renter-9", label: "March 2027 — $542.53 owing" }],
  recordOnAccount: async () => ({ ok: true }),
  recordDeposit: async () => ({ ok: true }),
  returnDeposit: async () => ({ ok: true }),
  applyOnAccount: async () => ({ ok: true }),
  unapplyAllocation: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

const { default: ParkRentPage } = await import("./page");

const render = async () =>
  renderToStaticMarkup(await ParkRentPage({ searchParams: Promise.resolve({}) }))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  nextReadError = null;
  ledger = { month: "2027-03", rows: [], claims: {}, summary: {}, lagDays: 3, today: "2027-03-02" };
  db.park_charges = [
    { id: "charge-jan", park_id: "park-haven", period_month: "2027-01" },
    { id: "charge-feb", park_id: "park-haven", period_month: "2027-02" },
  ];
  db.park_payment_allocations = [
    { id: "al-2", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53, applied_via: "run", applied_at: "2027-02-01T06:00:00Z" },
    { id: "al-1", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-jan", amount: 542.53, applied_via: "run", applied_at: "2027-01-01T06:00:00Z" },
    // Another park's row with the same payment id can't exist (FK), but a
    // scope filter is still the rule — prove it is applied.
    { id: "al-x", park_id: "park-other", payment_id: "pay-acct", charge_id: "charge-feb", amount: 999, applied_via: "office", applied_at: "2027-02-01T06:00:00Z" },
  ];
});

describe("the rent page hands the panel where each payment's money went", () => {
  it("renders the months under the remaining figure, joined to the bill's month, in month order", async () => {
    const w = await render();
    expect(w).toMatch(/\$542\.53 still on account · Household 9/);
    expect(w).toMatch(/Of \$1,627\.59 received, \$1,085\.06 is against bills/);
    const jan = w.indexOf("$542.53 to January 2027 · when January 2027 was billed");
    const feb = w.indexOf("$542.53 to February 2027 · when February 2027 was billed");
    expect(jan).toBeGreaterThan(0);
    expect(feb).toBeGreaterThan(jan);
    expect(w).not.toMatch(/\$999/);
  });

  it("a line the office took back off its bill is read with its reason and shown as the record, not as money against the bill", async () => {
    db.park_payment_allocations.push(
      { id: "al-0", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-jan", amount: 200, applied_via: "office", applied_at: "2027-01-02T06:00:00Z",
        removed_at: "2027-01-03T15:00:00Z", removed_reason: "they meant it for February" },
    );
    const w = await render();
    expect(w).toMatch(/\$200\.00 taken off January 2027 on January 3, 2027 — “they meant it for February”/);
    expect(w).not.toMatch(/\$200\.00 to January 2027/);
    // Still two live lines, each with its own control.
    expect((w.match(/Take it off this bill/g) ?? []).length).toBe(2);
  });

  it("a cheque the run has spent in full stays on the page under Applied in full, with Take it back", async () => {
    held.onAccount = [{ ...held.onAccount[0], remaining: 0, allocated: 1627.59 }];
    held.onAccountTotal = 0;
    db.park_charges.push({ id: "charge-mar", park_id: "park-haven", period_month: "2027-03" });
    db.park_payment_allocations.push(
      { id: "al-3", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-mar", amount: 542.53, applied_via: "run", applied_at: "2027-03-01T06:00:00Z" },
    );
    const w = await render();
    const section = w.slice(w.indexOf("Applied in full"));
    expect(section.length).toBeGreaterThan(40);
    expect(section).toMatch(/Household 9/);
    expect(section).toMatch(/\$542\.53 to March 2027/);
    expect(section).toMatch(/Take it back/);
    expect(section).not.toMatch(/Put against/);
    expect(w).toMatch(/\$0\.00 on account/);
    held.onAccount = [quarterRow()];
    held.onAccountTotal = 542.53;
  });

  it("a failed allocations read takes the page to its error boundary rather than rendering 'nothing applied'", async () => {
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    await expect(ParkRentPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(ReadFailed);
  });

  /**
   * getLedger is null only when assertMyPark is — and getMyPark has just
   * proved the park is his. The page used to render "Nothing here." with no
   * strip for that: a failed read shown as an empty month, and a dead end.
   */
  it("a ledger that did not answer for a proven park goes to the error boundary, never 'Nothing here.'", async () => {
    ledger = null;
    let thrown: unknown;
    try { await ParkRentPage({ searchParams: Promise.resolve({}) }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ReadFailed);
    expect((thrown as ReadFailed).what).toBe("this month's bills");
  });

  it("a ledger that answered renders the strip and the month — the other side of the same guard", async () => {
    const w = await render();
    expect(w).toMatch(/topbar nav rent/);
    expect(w).not.toMatch(/Nothing here/);
  });

  it("makes no allocations read at all when nothing is on account", async () => {
    held.onAccount = [];
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "x" } };
    await expect(render()).resolves.toBeTruthy();
    expect(nextReadError, "the read was made").not.toBeNull();
    nextReadError = null;
  });
});
