import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadFailed } from "@/lib/must-read";

/**
 * HER MONEY ON ACCOUNT, AS THE DATABASE COUNTS IT (0167).
 *
 * The resident's loader defined "on account" as `charge_id is null` and
 * summed `amount`. Since 0167 the payment row never moves — a quarter paid
 * ahead keeps `charge_id null` forever while the run puts $542.53 of it
 * against January — so that sum would have read $1,627.59 "on account" the
 * morning January was settled from it, and $1,627.59 still in March when
 * every cent had been applied. The figure is now the view's `remaining`, and
 * the bill it settled says where its money came from.
 *
 * The REAL loader, against a fake that models the view and the allocations
 * table the way 0167 defines them.
 */

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** Make the next read of this table fail with this error. */
let nextReadError: { table: string; error: { code: string; message: string } } | null = null;

/** park_on_account_payments, as 0167 defines it. */
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => p.kind === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null)
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? [])
        .filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      return {
        payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount,
        received_on: p.received_on, allocated: allocated / 100, refunded: 0,
        remaining: Math.max(0, cents(p.amount) - allocated) / 100,
      };
    });
}

class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private head = false;
  constructor(private t: string) {}
  select(_cols?: string, opts?: { head?: boolean; count?: string }) { if (opts?.head) this.head = true; return this; }
  eq(c: string, v: unknown) {
    // A filter through an embedded resource — `park_payments.renter_id` on an
    // allocations read — resolves through the row's foreign key.
    if (c.startsWith("park_payments.")) {
      const col = c.slice("park_payments.".length);
      this.fs.push((r) => (db.park_payments ?? []).find((p) => p.id === r.payment_id)?.[col] === v);
      return this;
    }
    this.fs.push((r) => r[c] === v); return this;
  }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  gte(c: string, v: string) { this.fs.push((r) => String(r[c]) >= v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  limit() { return this; }
  private rows(): Row[] {
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    return source.filter((r) => this.fs.every((f) => f(r))).map((r) => {
      // The embedded payment on an allocations read, as PostgREST returns a
      // many-to-one: an object with the columns asked for.
      if (this.t !== "park_payment_allocations") return r;
      const p = (db.park_payments ?? []).find((x) => x.id === r.payment_id);
      return { ...r, park_payments: p ? { renter_id: p.renter_id, reversed_at: p.reversed_at ?? null, returned_at: p.returned_at ?? null } : null };
    });
  }
  private resolve() {
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e, count: null });
    }
    const rows = this.rows();
    return Promise.resolve({ data: this.head ? null : rows, error: null, count: rows.length });
  }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-9" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => "2027-02-02",
}));

const { getRenterHome } = await import("./my-data");

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  nextReadError = null;
  db.park_renters = [{ id: "renter-9", park_id: "park-haven", user_id: "user-9", display_name: "Household 9", mobile_e164: null, sms_consent_operational_at: null }];
  db.lot_reservations = [{
    id: "res-9", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-01-01,2028-01-01)", term: "monthly",
    status: "active", expected_move_out: null, tenancy_began_on: "2015-04-01", moved_out_on: null, created_at: "2026-12-20",
  }];
  db.park_lots = [{ id: "lot-9", lot_number: "9", qr_token: null }];
  db.parks = [{ id: "park-haven", name: "The Haven", address: "9085 E 500 S", accepts_online_rent: false, card_fee_pct: 0 }];
  db.payment_methods = [];
  db.properties = [];
  db.park_requests = [];
  db.park_payment_claims = [];
  db.park_charges = [
    { id: "charge-feb", reservation_id: "res-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 0, status: "open",
      lines: [{ label: "Lot rent", amount: 400, basis: "for the month" }, { label: "Grounds fee", amount: 142.53, basis: "for the month" }] },
    { id: "charge-jan", reservation_id: "res-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid",
      lines: [{ label: "Lot rent", amount: 400, basis: "for the month" }, { label: "Grounds fee", amount: 142.53, basis: "for the month" }] },
  ];
  // A quarter paid ahead on 28 December, and the run put January against it.
  db.park_payments = [{
    id: "pay-acct", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: null, amount: 1627.59,
    fee_amount: null, method: "check", received_on: "2026-12-28", receipt_no: 12,
    returned_on: null, reversed_at: null, returned_at: null,
  }];
  db.park_payment_allocations = [
    { id: "al-1", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-jan", amount: 542.53, applied_via: "run", applied_at: "2027-01-01T06:00:00Z" },
  ];
}
beforeEach(seed);

describe("what she has on account is what is still unapplied", () => {
  it("reads the view's remaining, never the cheque's amount", async () => {
    const v = await getRenterHome();
    expect(v).not.toBeNull();
    // $1,627.59 less the $542.53 January took.
    expect(v!.onAccount).toBe(1085.06);
  });

  it("is zero once every cent has been put against bills", async () => {
    db.park_payment_allocations.push(
      { id: "al-2", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53, applied_via: "run", applied_at: "2027-02-01T06:00:00Z" },
      { id: "al-3", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-mar", amount: 542.53, applied_via: "run", applied_at: "2027-03-01T06:00:00Z" },
    );
    const v = await getRenterHome();
    expect(v!.onAccount).toBe(0);
  });

  it("leaves a reversed or bank-returned cheque out, as the view does", async () => {
    db.park_payments[0].returned_at = "2027-01-03T00:00:00Z";
    const v = await getRenterHome();
    expect(v!.onAccount).toBe(0);
  });

  it("refuses rather than printing zero when the view cannot be read", async () => {
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    await expect(getRenterHome()).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe("a bill settled from money on account says where its money came from", () => {
  it("January, settled by the run from the quarter she paid ahead, carries the $542.53", async () => {
    // The morning January was raised: it is her only bill, and the run put
    // $542.53 of the 28 December cheque against it.
    db.park_charges = db.park_charges.filter((c) => c.id === "charge-jan");
    const v = await getRenterHome();
    expect(v!.bill!.monthLabel).toBe("January 2027");
    expect(v!.bill!.outstanding).toBe(0);
    expect(v!.bill!.paidTotal).toBe(542.53);
    expect(v!.bill!.fromOnAccount).toBe(542.53);
    expect(v!.arrears).toEqual([]);
  });

  it("a bill nothing on account touched carries zero", async () => {
    const v = await getRenterHome();
    expect(v!.bill!.monthLabel).toBe("February 2027");
    expect(v!.bill!.fromOnAccount).toBe(0);
  });

  it("a part-applied bill carries the part, and an arrears month carries its own", async () => {
    db.park_charges[0].paid_total = 200;
    db.park_payment_allocations.push(
      { id: "al-2", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-feb", amount: 200, applied_via: "office", applied_at: "2027-02-01T06:00:00Z" },
    );
    // And January only half settled, so it is in arrears with its own figure.
    db.park_charges[1].paid_total = 300;
    db.park_payment_allocations[0].amount = 300;
    const v = await getRenterHome();
    expect(v!.bill!.fromOnAccount).toBe(200);
    expect(v!.bill!.outstanding).toBe(342.53);
    expect(v!.arrears).toHaveLength(1);
    expect(v!.arrears[0].monthLabel).toBe("January 2027");
    expect(v!.arrears[0].fromOnAccount).toBe(300);
    expect(v!.arrears[0].outstanding).toBe(242.53);
  });

  it("only HER payments' allocations count — the read is scoped through the payment's household", async () => {
    // Another household's cheque applied to a bill that (by a data error)
    // sits in her chain must not read as her money.
    db.park_payments.push({
      id: "pay-other", park_id: "park-haven", renter_id: "renter-7", kind: "rent", charge_id: null, amount: 542.53,
      fee_amount: null, method: "check", received_on: "2027-01-02", receipt_no: 13, returned_on: null, reversed_at: null, returned_at: null,
    });
    db.park_payment_allocations.push(
      { id: "al-x", park_id: "park-haven", payment_id: "pay-other", charge_id: "charge-feb", amount: 542.53, applied_via: "office", applied_at: "2027-02-01T06:00:00Z" },
    );
    const v = await getRenterHome();
    expect(v!.bill!.fromOnAccount).toBe(0);
  });

  it("a bounced cheque's allocations are record, not money that paid the month", async () => {
    // The reversal reopens January (recompute_charge_paid drops it); the
    // allocation row survives. The screen must not say "$542.53 came off
    // money you had on account" about money that bounced.
    db.park_payments[0].reversed_at = "2027-01-05T10:00:00Z";
    db.park_charges[1].paid_total = 0; db.park_charges[1].status = "open";
    const v = await getRenterHome();
    expect(v!.arrears).toHaveLength(1);
    expect(v!.arrears[0].monthLabel).toBe("January 2027");
    expect(v!.arrears[0].fromOnAccount).toBe(0);
    expect(v!.onAccount).toBe(0);
  });

  it("a line the office took back off its bill (R3) is the record of a correction, not money that paid the month", async () => {
    // The office put $542.53 of the cheque against February by hand, then
    // took it off — wrong month. recompute drops it; the view's remaining
    // rises; the screen must not say "$542.53 of it came from money you had
    // on account" under a February that owes again.
    db.park_payment_allocations.push(
      { id: "al-2", park_id: "park-haven", payment_id: "pay-acct", charge_id: "charge-feb", amount: 542.53, applied_via: "office", applied_at: "2027-02-01T06:00:00Z",
        removed_at: "2027-02-03T15:00:00Z", removed_reason: "they meant it for March" },
    );
    const v = await getRenterHome();
    expect(v!.bill!.monthLabel).toBe("February 2027");
    expect(v!.bill!.fromOnAccount).toBe(0);
    expect(v!.bill!.outstanding).toBe(542.53);
    // January's live line still counts.
    expect(v!.arrears).toEqual([]);
  });

  it("a failed allocations read refuses rather than saying 'paid in full' with no word of how", async () => {
    nextReadError = { table: "park_payment_allocations", error: { code: "57P01", message: "terminating connection" } };
    await expect(getRenterHome()).rejects.toBeInstanceOf(ReadFailed);
  });
});

describe("the cheque itself stays on her list at its full amount", () => {
  it("$1,627.59, receipt 12 — money received stays the row it was", async () => {
    const v = await getRenterHome();
    expect(v!.payments).toHaveLength(1);
    expect(v!.payments[0].amount).toBe(1627.59);
    expect(v!.payments[0].receiptNo).toBe(12);
  });
});

describe("the loader's shape, pinned in source", () => {
  const src = readFileSync(fileURLToPath(new URL("./my-data.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads money on account from the view, inside the tenancy batch", () => {
    const at = src.indexOf("await Promise.all([");
    const batch = src.slice(at, src.indexOf("]);", at));
    expect(batch).toMatch(/\.from\("park_on_account_payments"\)/);
    expect(batch).toMatch(/\.gt\("remaining", 0\)/);
    // And the allocations, scoped to HER payments, in the same trip.
    expect(batch).toMatch(/\.from\("park_payment_allocations"\)/);
    expect(batch).toMatch(/park_payments!inner\(renter_id, reversed_at, returned_at\)/);
    expect(src).toMatch(/pay\?\.reversed_at != null \|\| pay\?\.returned_at != null\) continue;/);
    expect(batch).toMatch(/\.eq\("park_payments\.renter_id", file\.id as string\)/);
    // LIVE LINES ONLY (R3): a line taken back off its bill counts toward
    // nothing, here as in the view and the recompute.
    const allocs = batch.slice(batch.indexOf('.from("park_payment_allocations")'));
    expect(allocs).toMatch(/\.is\("removed_at", null\)/);
  });

  it("no longer sums a payment's amount as 'on account'", () => {
    expect(src).not.toMatch(/\.is\("charge_id", null\)[\s\S]{0,80}\.is\("returned_at", null\),\n\s*\]\)/);
    expect(src).toMatch(/Number\(p\.remaining \?\? 0\)/);
  });

  it("guards both new reads", () => {
    expect(src).toMatch(/mustRead\("money you have on account", acctRes\)/);
    expect(src).toMatch(/mustRead\("where your money on account went", allocRes\)/);
  });
});
