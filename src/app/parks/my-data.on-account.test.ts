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

/**
 * park_on_account_payments, as 0167 defines it and 0169 widens it: kind rent,
 * standing, and no charge OR a charge whose status is void — a payment against
 * a cancelled bill is on account, its money released, the row never moved.
 * renter_id is coalesced from the charge; released_from_* are appended.
 */
function onAccountView(): Row[] {
  const chargeOf = (id: unknown) => (db.park_charges ?? []).find((c) => c.id === id) ?? null;
  return (db.park_payments ?? [])
    .filter((p) => p.kind === "rent" && p.reversed_at == null && p.returned_at == null
      && (p.charge_id == null || chargeOf(p.charge_id)?.status === "void"))
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? [])
        .filter((a) => a.payment_id === p.id && a.removed_at == null).reduce((t, a) => t + cents(a.amount), 0);
      const handedBack = p.returned_on != null ? cents(p.returned_amount) : 0;
      const c = p.charge_id == null ? null : chargeOf(p.charge_id);
      return {
        payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id ?? c?.renter_id ?? null, amount: p.amount,
        received_on: p.received_on, allocated: allocated / 100, refunded: 0,
        remaining: Math.max(0, cents(p.amount) - allocated - handedBack) / 100,
        released_from_charge_id: c ? c.id : null, released_from_month: c ? c.period_month : null, released_on: c ? (c.voided_at ?? null) : null,
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
  // HONOURS ITS ARGUMENTS. The first fake ignored them, so a test seeding a
  // January link with notice and a later-created February successor passed
  // whichever row the loader picked — the exact defect it needed to catch.
  private sort: { col: string; asc: boolean } | null = null;
  order(col: string, opts?: { ascending?: boolean }) { this.sort = { col, asc: opts?.ascending !== false }; return this; }
  limit() { return this; }
  private rows(): Row[] {
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    const sorted = this.sort
      ? [...source].sort((a, b) => String(a[this.sort!.col] ?? "").localeCompare(String(b[this.sort!.col] ?? "")) * (this.sort!.asc ? 1 : -1))
      : source;
    return sorted.filter((r) => this.fs.every((f) => f(r))).map((r) => {
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
/** Lake-local today, per test — a notice window is a date, not a constant. */
const clock = { today: "2027-02-02" };
vi.mock("@/lib/booking", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking")>()),
  todayLakeDate: () => clock.today,
}));

const { getRenterHome } = await import("./my-data");

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  nextReadError = null;
  clock.today = "2027-02-02";
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
    db.park_payments[0].reversed_reason = "the cheque bounced";
    db.park_charges[1].paid_total = 0; db.park_charges[1].status = "open";
    const v = await getRenterHome();
    expect(v!.arrears).toHaveLength(1);
    expect(v!.arrears[0].monthLabel).toBe("January 2027");
    expect(v!.arrears[0].fromOnAccount).toBe(0);
    expect(v!.onAccount).toBe(0);
    // AND THE CHEQUE STAYS ON HER LIST, marked. She holds receipt #12; the
    // list used to drop every reversed row and say "Nothing recorded yet"
    // under two months that had flipped to unpaid with no sentence why.
    // Money received stays the row it was; the correction is these fields —
    // exactly the pair /paid/[token] already shows her.
    expect(v!.payments, "the bounced cheque vanished from her list").toHaveLength(1);
    expect(v!.payments[0].receiptNo).toBe(12);
    expect(v!.payments[0].amount).toBe(1627.59);
    expect(v!.payments[0].takenBackOn).toBe("2027-01-05T10:00:00Z");
    expect(v!.payments[0].takenBackWhy).toBe("the cheque bounced");
    expect(v!.payments[0].bankReturnedOn, "a reversal is not a bank return").toBeNull();
  });

  it("a standing payment carries neither; a bank return carries both, with the bank's code", async () => {
    const standing = await getRenterHome();
    expect(standing!.payments[0].takenBackOn).toBeNull();
    expect(standing!.payments[0].takenBackWhy).toBeNull();
    db.park_payments[0].method = "ach";
    db.park_payments[0].returned_at = "2027-01-08T09:00:00Z";
    db.park_payments[0].return_code = "R01";
    const returned = await getRenterHome();
    expect(returned!.payments[0].bankReturnedOn).toBe("2027-01-08T09:00:00Z");
    expect(returned!.payments[0].takenBackOn).toBe("2027-01-08T09:00:00Z");
    expect(returned!.payments[0].takenBackWhy).toBe("R01");
    // The deposit maths still leave a reversed deposit out.
    db.park_payments.push({ id: "dep", park_id: "park-haven", renter_id: "renter-9", kind: "deposit", charge_id: null, amount: 500,
      fee_amount: null, method: "cash", received_on: "2026-12-28", receipt_no: 11, returned_on: null, reversed_at: "2026-12-29T10:00:00Z", reversed_reason: "keyed twice", returned_at: null });
    const v = await getRenterHome();
    expect(v!.deposit).toBeNull();
    expect(v!.payments.map((p) => p.receiptNo)).toEqual([12]);
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
    // Nothing of it handed back: the row carries zero and no day.
    expect(v!.payments[0].handedBack).toBe(0);
    expect(v!.payments[0].handedBackOn).toBeNull();
  });
});

/**
 * THE FOURTH EXIT, ON HER SCREEN. Money from a cheque handed back across
 * the window (0168) is a stamp on the payment row — returned_on,
 * returned_amount. Her on-account card (the view's remaining) had already
 * stopped counting it; the cheque sat on her list unmarked and the card
 * simply shrank. The row now carries the hand-back, and a returned deposit
 * is said on the deposit card rather than "None held." alone.
 */
describe("money handed back to her across the window", () => {
  it("the $57.47 handed back after she left is on the cheque's row — how much, and the day; the row stays at what she handed over", async () => {
    // A $600 cheque on 5 January, $542.53 to January, the $57.47 handed back on the 28th.
    db.park_payments = [{
      id: "pay-600", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: null, amount: 600,
      fee_amount: null, method: "check", received_on: "2027-01-05", receipt_no: 14,
      returned_on: "2027-01-28", returned_amount: 57.47, return_note: "moved out 27 January; nothing more bills", reversed_at: null, returned_at: null,
    }];
    db.park_payment_allocations = [{ id: "al-1", park_id: "park-haven", payment_id: "pay-600", charge_id: "charge-jan", amount: 542.53, applied_via: "run", applied_at: "2027-01-05T15:00:00Z" }];
    const v = await getRenterHome();
    expect(v!.payments).toHaveLength(1);
    expect(v!.payments[0].amount).toBe(600);
    expect(v!.payments[0].handedBack).toBe(57.47);
    expect(v!.payments[0].handedBackOn).toBe("2027-01-28");
    // A hand-back is not a reversal and not a bank return.
    expect(v!.payments[0].takenBackOn).toBeNull();
    expect(v!.payments[0].bankReturnedOn).toBeNull();
  });

  it("a deposit handed back is said on the deposit card — amount and day — and none is held", async () => {
    db.park_payments.push({
      id: "pay-dep", park_id: "park-haven", renter_id: "renter-9", kind: "deposit", charge_id: null, amount: 500,
      fee_amount: null, method: "cash", received_on: "2026-12-10", receipt_no: 11,
      returned_on: "2027-02-03", returned_amount: 500, return_note: null, reversed_at: null, returned_at: null,
    });
    const v = await getRenterHome();
    expect(v!.deposit).toBeNull();
    expect(v!.depositReturned).toEqual({ amount: 500, on: "2027-02-03" });
    // The deposit is never on the payments list, returned or not.
    expect(v!.payments.every((p) => p.receiptNo !== 11)).toBe(true);
  });

  it("a deposit still held says so, and no return; a reversed deposit is neither", async () => {
    db.park_payments.push({
      id: "pay-dep", park_id: "park-haven", renter_id: "renter-9", kind: "deposit", charge_id: null, amount: 500,
      fee_amount: null, method: "cash", received_on: "2026-12-10", receipt_no: 11,
      returned_on: null, returned_amount: null, return_note: null, reversed_at: null, returned_at: null,
    });
    const held = await getRenterHome();
    expect(held!.deposit).toEqual({ amount: 500, since: "2026-12-10" });
    expect(held!.depositReturned).toBeNull();
    db.park_payments[1].reversed_at = "2026-12-11T10:00:00Z";
    db.park_payments[1].returned_on = "2026-12-12"; db.park_payments[1].returned_amount = 500;
    const reversed = await getRenterHome();
    expect(reversed!.deposit).toBeNull();
    expect(reversed!.depositReturned).toBeNull();
  });

  it("the loader selects the stamp and derives the standing through the one helper", () => {
    const src = readFileSync(fileURLToPath(new URL("./my-data.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/returned_on, returned_amount, reversed_at, reversed_reason, returned_at, return_code"\)/);
    expect(src).toMatch(/handedBack: p\.returned_on != null \? Number\(p\.returned_amount \?\? 0\) : 0/);
    expect(src).toMatch(/takenBackWhy\(takenBackOfRow\(p\)\)/);
    expect(src).toMatch(/notCollectedAt\(takenBackOfRow\(p\)\)/);
    expect(src).not.toMatch(/"returned by the bank"/);
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

/**
 * MONEY A CANCELLED BILL RELEASED (0169). She paid January in full on the
 * 4th; she left on the 20th; the office cancelled the whole-month bill and
 * raised the $472.53 part month, which was settled from the money the
 * cancelled bill released. The payment row never moved (charge_id still
 * names January) and the view lists it, with the cancelled bill's month.
 * Her screen has to count what is left of it as hers, and the part month
 * has to say where its money came from — the January bill she can see her
 * cheque against, not "money you had on account".
 */
describe("money released from a cancelled bill is on her page, and the part month names it", () => {
  const walked = (over: Partial<Row> = {}) => {
    clock.today = "2027-02-02";
    db.lot_reservations = [{
      id: "res-9", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-01-01,2027-01-21)", term: "monthly",
      status: "ended", expected_move_out: "2027-01-20", tenancy_began_on: "2015-04-01", moved_out_on: "2027-01-20", created_at: "2026-12-20",
    }];
    db.park_charges = [
      { id: "charge-jan", reservation_id: "res-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "void",
        voided_at: "2027-01-20T15:00:00Z", void_reason: "moved out 20 Jan; part month raised", lines: [] },
      { id: "charge-part", reservation_id: "res-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 472.53, paid_total: 472.53, status: "paid",
        lines: [{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }] },
    ];
    db.park_payments = [{
      id: "pay-direct", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: "charge-jan", amount: 542.53,
      fee_amount: null, method: "check", received_on: "2027-01-04", receipt_no: 14,
      returned_on: null, reversed_at: null, returned_at: null, ...over,
    }];
    db.park_payment_allocations = [
      { id: "al-p", park_id: "park-haven", payment_id: "pay-direct", charge_id: "charge-part", amount: 472.53, applied_via: "office", applied_at: "2027-01-20T15:05:00Z" },
    ];
  };

  it("the $70.00 left is on account by the view's word, the tenancy has ended and the final month is billed", async () => {
    walked();
    const v = await getRenterHome();
    expect(v!.onAccount).toBe(70);
    expect(v!.tenancyEnded).toBe("2027-01-20");
    // The part month is a live January bill: "nothing more bills for you".
    expect(v!.finalMonthBilled).toBe(true);
  });

  /**
   * THE LINE AGAINST THE JANUARY RAISED AGAIN is marked apart from the
   * January cancelled (0169), the way /paid/[token] marks it: the same
   * month as the cancelled bill the money was released from, so the
   * sentence can say "the $472.53 bill raised again for January 2027 (27
   * of 31 days)" rather than "January 2027" — two bills in one word. The
   * basis is the bill's OWN frozen text, carried verbatim; the amount is
   * the bill's, not the line's.
   */
  const partMonth = { periodMonth: "2027-01", amount: 472.53, raisedAgain: { basis: "27 of 31 days" }, billAmount: 472.53 };

  it("the released cheque's own row says which bill was cancelled, where its money went, and the $70.00 still held", async () => {
    walked();
    const v = await getRenterHome();
    const row = v!.payments.find((p) => p.receiptNo === 14)!;
    // By the view's word (released_from_month), never the row's charge_id.
    expect(row.releasedFrom).toEqual({ month: "2027-01" });
    // Its live allocations, with the month of the bill each went to — and
    // the January raised again named apart, with its own amount and basis.
    expect(row.allocations).toStrictEqual([partMonth]);
    // The view's remaining — the same figure the On account card sums.
    expect(row.onAccountRemaining).toBe(70);
    expect(v!.onAccount).toBe(row.onAccountRemaining);
    // Nothing left of it: zero, not a missing key, and the origin still named.
    walked({ amount: 472.53 });
    const spent = (await getRenterHome())!.payments.find((p) => p.receiptNo === 14)!;
    expect(spent.releasedFrom).toEqual({ month: "2027-01" });
    expect(spent.onAccountRemaining).toBe(0);
    expect(spent.allocations).toStrictEqual([partMonth]);
    // Nothing applied yet — the bill cancelled, the part month not raised:
    // no lines, the whole still held.
    walked();
    db.park_charges = db.park_charges.filter((c) => c.id === "charge-jan");
    db.park_payment_allocations = [];
    const held = (await getRenterHome())!.payments.find((p) => p.receiptNo === 14)!;
    expect(held.releasedFrom).toEqual({ month: "2027-01" });
    expect(held.allocations).toEqual([]);
    expect(held.onAccountRemaining).toBe(542.53);
  });

  it("a payment no cancelled bill released carries null, and its own remaining", async () => {
    // The quarter paid ahead from seed(): on account through its own door.
    const v = await getRenterHome();
    const acct = v!.payments.find((p) => p.receiptNo === 12)!;
    expect(acct.releasedFrom).toBeNull();
    // An ordinary line keeps its shape: no cancelled bill released this
    // money, so nothing collides and no mark rides — no key at all, not an
    // undefined one.
    expect(acct.allocations).toStrictEqual([{ periodMonth: "2027-01", amount: 542.53 }]);
    expect(acct.onAccountRemaining).toBe(1085.06);
    // And a cheque against a live bill: nothing of it is on account.
    walked();
    db.park_charges[0].status = "paid"; db.park_charges[0].paid_total = 542.53;
    db.park_payment_allocations = [];
    const direct = (await getRenterHome())!.payments.find((p) => p.receiptNo === 14)!;
    expect(direct.releasedFrom).toBeNull();
    expect(direct.allocations).toEqual([]);
    expect(direct.onAccountRemaining).toBe(0);
  });

  it("a released cheque since reversed carries no lines and nothing held — its allocations are record, as for the bill", async () => {
    walked({ reversed_at: "2027-01-22T10:00:00Z", reversed_reason: "the cheque bounced" });
    const row = (await getRenterHome())!.payments.find((p) => p.receiptNo === 14)!;
    expect(row.takenBackOn).not.toBeNull();
    expect(row.allocations).toEqual([]);
    expect(row.onAccountRemaining).toBe(0);
  });

  /**
   * TWO CANCELLED BILLS' MONEY ON ONE PART MONTH — the shape the close-out
   * cascade writes (finalMonthNow, park/actions.ts). January part-paid $400
   * by cheque; February raised early on the successor and paid $542.53; the
   * move-out (27 January) recorded on 3 February. endTenancy cancelled both
   * bills, and the part month was settled from BOTH: $400 of January's
   * money and $72.53 of February's. Naming the larger month alone left the
   * $72.53 to read as "money you had on account" — her February cheque.
   */
  it("a part month settled from two cancelled bills' money names both months and sums the amount", async () => {
    clock.today = "2027-02-04";
    db.lot_reservations = [
      { id: "res-9", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-01-01,2027-01-28)", term: "monthly",
        status: "ended", expected_move_out: "2027-01-27", tenancy_began_on: "2015-04-01", moved_out_on: "2027-01-27", created_at: "2026-12-20" },
    ];
    db.park_charges = [
      { id: "charge-jan", reservation_id: "res-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 0, status: "void",
        voided_at: "2027-02-03T15:00:00Z", void_reason: "moved out 27 Jan; part month raised", lines: [] },
      { id: "charge-feb", reservation_id: "res-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 542.53, paid_total: 0, status: "void",
        voided_at: "2027-02-03T15:00:00Z", void_reason: "moved out 27 Jan", lines: [] },
      { id: "charge-part", reservation_id: "res-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 472.53, paid_total: 472.53, status: "paid",
        lines: [{ label: "Lot rent", amount: 348.39, basis: "27 of 31 days" }] },
    ];
    db.park_payments = [
      { id: "pay-j", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: "charge-jan", amount: 400,
        fee_amount: null, method: "check", received_on: "2027-01-04", receipt_no: 14, returned_on: null, reversed_at: null, returned_at: null },
      { id: "pay-f", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: "charge-feb", amount: 542.53,
        fee_amount: null, method: "check", received_on: "2027-01-20", receipt_no: 15, returned_on: null, reversed_at: null, returned_at: null },
    ];
    db.park_payment_allocations = [
      { id: "al-j", park_id: "park-haven", payment_id: "pay-j", charge_id: "charge-part", amount: 400, applied_via: "office", applied_at: "2027-02-03T15:05:00Z" },
      { id: "al-f", park_id: "park-haven", payment_id: "pay-f", charge_id: "charge-part", amount: 72.53, applied_via: "office", applied_at: "2027-02-03T15:05:00Z" },
    ];
    const v = await getRenterHome();
    expect(v!.bill!.monthLabel).toBe("January 2027");
    expect(v!.bill!.fromOnAccount).toBe(472.53);
    // Both months, in order, whichever cheque was larger; the amount summed.
    expect(v!.bill!.fromCancelledBill).toEqual({ months: ["2027-01", "2027-02"], amount: 472.53 });
    // $470.00 of February's cheque is what is left, and its row says so.
    expect(v!.onAccount).toBe(470);
    const feb = v!.payments.find((p) => p.receiptNo === 15)!;
    expect(feb.releasedFrom).toEqual({ month: "2027-02" });
    // February's money on the January part month: the months differ, so
    // the line is January itself — not "the bill raised again for
    // February", which was never raised. Bare shape, no mark.
    expect(feb.allocations).toStrictEqual([{ periodMonth: "2027-01", amount: 72.53 }]);
    expect(feb.onAccountRemaining).toBe(470);
    const jan = v!.payments.find((p) => p.receiptNo === 14)!;
    expect(jan.releasedFrom).toEqual({ month: "2027-01" });
    // January's money on the January part month collides: marked, with the
    // bill's own $472.53 beside the $400.00 this cheque put against it.
    expect(jan.allocations).toStrictEqual([{ periodMonth: "2027-01", amount: 400, raisedAgain: { basis: "27 of 31 days" }, billAmount: 472.53 }]);
    expect(jan.onAccountRemaining).toBe(0);
    // Collapsed: take February's line away and one month is named.
    db.park_payment_allocations = db.park_payment_allocations.filter((a) => a.id !== "al-f");
    db.park_charges[2].paid_total = 400;
    const one = await getRenterHome();
    expect(one!.bill!.fromCancelledBill).toEqual({ months: ["2027-01"], amount: 400 });
  });

  it("the part month says $472.53 of it came from what she'd paid on the cancelled January bill", async () => {
    walked();
    const v = await getRenterHome();
    expect(v!.bill!.monthLabel).toBe("January 2027");
    expect(v!.bill!.outstanding).toBe(0);
    expect(v!.bill!.fromOnAccount).toBe(472.53);
    expect(v!.bill!.fromCancelledBill).toEqual({ months: ["2027-01"], amount: 472.53 });
    // The cancelled bill itself is not on her screen (the charges read skips void).
    expect(v!.arrears).toEqual([]);
  });

  it("…and still says so when nothing of the released money is left — the read is not the 'still held' one", async () => {
    // A $472.53 cheque on January, cancelled, released in full onto the part
    // month: remaining 0, so the on-account read (.gt remaining 0) never
    // sees it. The sentence must not fall back to "money you had on account".
    walked({ amount: 472.53 });
    const v = await getRenterHome();
    expect(v!.onAccount).toBe(0);
    expect(v!.bill!.fromCancelledBill).toEqual({ months: ["2027-01"], amount: 472.53 });
  });

  it("a released cheque that was later reversed is record, not money that paid the month", async () => {
    walked({ reversed_at: "2027-01-22T10:00:00Z", reversed_reason: "the cheque bounced" });
    db.park_charges[1].paid_total = 0; db.park_charges[1].status = "open";
    const v = await getRenterHome();
    expect(v!.bill!.fromOnAccount).toBe(0);
    expect(v!.bill!.fromCancelledBill).toBeNull();
    expect(v!.onAccount).toBe(0);
  });

  it("money keyed on account through its own door carries null — the old sentence stands for it", async () => {
    const v = await getRenterHome();
    expect(v!.arrears).toEqual([]);
    expect(v!.bill!.fromCancelledBill).toBeNull();
    db.park_charges = db.park_charges.filter((c) => c.id === "charge-jan");
    const jan = await getRenterHome();
    expect(jan!.bill!.fromOnAccount).toBe(542.53);
    expect(jan!.bill!.fromCancelledBill).toBeNull();
  });

  it("the $600 split, walked: the released half and the on-account half both settle the part month, and only the released dollars name the bill", async () => {
    walked();
    db.park_payments.push({
      id: "pay-half", park_id: "park-haven", renter_id: "renter-9", kind: "rent", charge_id: null, amount: 57.47,
      fee_amount: null, method: "check", received_on: "2027-01-04", receipt_no: 15, returned_on: null, reversed_at: null, returned_at: null,
    });
    db.park_payment_allocations = [
      { id: "al-h", park_id: "park-haven", payment_id: "pay-half", charge_id: "charge-part", amount: 57.47, applied_via: "office", applied_at: "2027-01-20T15:05:00Z" },
      { id: "al-p", park_id: "park-haven", payment_id: "pay-direct", charge_id: "charge-part", amount: 415.06, applied_via: "office", applied_at: "2027-01-20T15:05:00Z" },
    ];
    const v = await getRenterHome();
    expect(v!.bill!.fromOnAccount).toBe(472.53);
    expect(v!.bill!.fromCancelledBill).toEqual({ months: ["2027-01"], amount: 415.06 });
    expect(v!.onAccount).toBe(127.47);
    // And under each cheque: the released half's line is the January
    // raised again; the on-account half's, against the same bill, is plain
    // January — no cancelled bill released it, so nothing collides.
    expect(v!.payments.find((p) => p.receiptNo === 14)!.allocations).toStrictEqual([{ ...partMonth, amount: 415.06 }]);
    expect(v!.payments.find((p) => p.receiptNo === 15)!.allocations).toStrictEqual([{ periodMonth: "2027-01", amount: 57.47 }]);
  });

  it("refuses rather than saying 'money you had on account' when where it came from cannot be read", async () => {
    walked();
    // The first view read succeeds; the second — the unfiltered one — fails.
    let reads = 0;
    const orig = Q.prototype.then;
    Q.prototype.then = function (this: Q, ok, bad) {
      if ((this as unknown as { t: string }).t === "park_on_account_payments" && ++reads === 2) {
        return Promise.resolve({ data: null, error: { code: "57P01", message: "terminating connection" }, count: null }).then(ok, bad);
      }
      return orig.call(this, ok, bad);
    } as typeof orig;
    try {
      await expect(getRenterHome()).rejects.toBeInstanceOf(ReadFailed);
    } finally {
      Q.prototype.then = orig;
    }
  });

  it("pinned in source: a second, unfiltered view read by renter_id, and the test is the view's word, never charge_id", () => {
    const src = readFileSync(fileURLToPath(new URL("./my-data.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const at = src.indexOf("await Promise.all([");
    const batch = src.slice(at, src.indexOf("]);", at));
    expect(batch).toMatch(/\.select\("payment_id, released_from_month"\)\n\s*\.eq\("renter_id", file\.id as string\),/);
    expect((batch.match(/\.from\("park_on_account_payments"\)/g) ?? []).length).toBe(2);
    expect(src).toMatch(/mustRead\("where your money came from", releasedRes\)/);
    expect(src).toMatch(/fromCancelledBill: fromCancelledBill\(c\.id as string\),/);
    expect(src).toMatch(/releasedMonthOf\.get\(a\.payment_id as string\)/);
    expect(src, "decided by charge_id, not the view").not.toMatch(/pay\?\.charge_id/);
    // EVERY cancelled bill, summed — never the largest month alone. The
    // cascade writes two, and the sort-and-take-first read one.
    expect(src).not.toMatch(/sort\(\(a, b\) => b\[1\] - a\[1\]/);
    expect(src).toMatch(/months = \[\.\.\.byMonth\.keys\(\)\]\.sort\(\)/);
    // The payment row reads the same two maps, and the view's remaining —
    // never the cheque less its lines.
    expect(src).toMatch(/releasedFrom: releasedMonthOf\.has\(p\.id as string\)/);
    expect(src).toMatch(/onAccountRemaining: remainingOf\.get\(p\.id as string\) \?\? 0,/);
    expect(src).toMatch(/\.select\("id, amount, fee_amount, method, received_on/);
    // THE RE-RAISE IS MARKED THROUGH lib/allocations, never a second copy of
    // the collision test or the basis read: withRaisedAgain over the bill
    // row's own lines, the released-from month passed in; the bill's amount
    // rides on the colliding line alone. The bills read carries the lines
    // and amount it needs.
    expect(src).toMatch(/withRaisedAgain\(\n\s*\{ periodMonth: String\(bill\.period_month \?\? ""\), amount: c \/ 100 \},\n\s*month \?\? null,\n\s*bill\.lines,\n\s*\)/);
    expect(src).toMatch(/line\.raisedAgain && bill\.amount != null \? \{ \.\.\.line, billAmount: Number\(bill\.amount\) \} : line/);
    expect(src, "the collision decided here, not in lib/allocations").not.toMatch(/periodMonth === |=== month\b|"for the month"/);
    expect(batch).toMatch(/\.select\("id, period_month, due_on, amount, paid_total, status, lines"\)/);
  });
});

/**
 * THE LINK THAT COVERS TODAY, NOT THE NEWEST ROW. A renewal is a successor
 * row written in the agreement's last half; the notice she gave stands on
 * the link the roll called current. Picking the newest row read the
 * February successor — no notice — and the screen said "rolls on" and hid
 * the "Leaving" pill, while the owner's Today said "Lot 9 leaves in 6 days".
 * At The Haven every renewal is written this way, so this is the common
 * case. Both orderings, so the pick is proven to be by coverage, not by
 * created_at either way.
 */
describe("during the notice window, with the next agreement already written", () => {
  const jan = { id: "res-jan", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-01-01,2027-02-01)", term: "monthly",
    status: "active", expected_move_out: "2027-01-27", tenancy_began_on: "2015-04-01", moved_out_on: null, created_at: "2027-01-01T00:00:00Z" };
  const feb = { id: "res-feb", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-02-01,2027-03-01)", term: "monthly",
    status: "approved", expected_move_out: null, tenancy_began_on: "2015-04-01", moved_out_on: null, created_at: "2027-01-16T00:00:00Z" };
  beforeEach(() => {
    clock.today = "2027-01-21";
    db.park_charges = [];
    db.park_payment_allocations = [];
    db.park_requests = [{ park_lot_id: "lot-9", note: "Riser is leaking", status: "new", resolution_note: null, created_at: "2027-01-10T15:00:00Z" }];
  });

  it("successor created LATER (the real shape): leavingOn is the January link's notice", async () => {
    db.lot_reservations = [jan, feb];
    const v = await getRenterHome();
    expect(v!.leavingOn).toBe("2027-01-27");
    expect(v!.tenancyEnded).toBeNull();
    expect(v!.term).toBe("monthly");
    // And the report she filed in January is still listed — the window is her
    // time on this lot, not the successor's start.
    expect(v!.reported.map((r) => r.note)).toEqual(["Riser is leaking"]);
  });

  it("successor created EARLIER than the link it succeeds: still the covering link's notice", async () => {
    db.lot_reservations = [{ ...jan, created_at: "2027-01-16T00:00:00Z" }, { ...feb, created_at: "2027-01-01T00:00:00Z" }];
    const v = await getRenterHome();
    expect(v!.leavingOn).toBe("2027-01-27");
  });

  it("with the successor withdrawn: the same answer", async () => {
    db.lot_reservations = [jan, { ...feb, status: "cancelled" }];
    const v = await getRenterHome();
    expect(v!.leavingOn).toBe("2027-01-27");
    expect(v!.reported.map((r) => r.note)).toEqual(["Riser is leaking"]);
  });

  it("no notice anywhere: rolls on, whichever row is newest", async () => {
    db.lot_reservations = [{ ...jan, expected_move_out: null }, feb];
    const v = await getRenterHome();
    expect(v!.leavingOn).toBeNull();
  });

  it("from the 1st, when the successor covers today, January's report is still hers to see", async () => {
    // The second symptom from the same pick: the report window used to start
    // at the covering link's start, so the morning February began every
    // report she filed in January vanished and the card said "Nothing yet.
    // Tell the office" about a riser she had already reported.
    clock.today = "2027-02-02";
    db.lot_reservations = [{ ...jan, expected_move_out: null }, feb];
    const v = await getRenterHome();
    expect(v!.reported.map((r) => r.note)).toEqual(["Riser is leaking"]);
    // But never a PREVIOUS household's report on the same lot: the window
    // starts at HER earliest link on this lot.
    db.park_requests.push({ park_lot_id: "lot-9", note: "Old tenant's step", status: "done", resolution_note: "fixed", created_at: "2026-11-10T15:00:00Z" });
    const again = await getRenterHome();
    expect(again!.reported.map((r) => r.note)).toEqual(["Riser is leaking"]);
  });

  it("the notice on the SUCCESSOR (a February day, given in January) is read too — any live link carries it", async () => {
    clock.today = "2027-02-02";
    db.lot_reservations = [{ ...jan, expected_move_out: null }, { ...feb, expected_move_out: "2027-02-15" }];
    const v = await getRenterHome();
    expect(v!.leavingOn).toBe("2027-02-15");
  });

  it("a move within the park: today's screen is today's lot, and the next link's lot from its first day", async () => {
    // The observable that tells the covering link from the newest row: she
    // moves from Lot 9 to Lot 14 on 1 February. On 21 January her screen is
    // Lot 9's; on 2 February it is Lot 14's.
    db.park_lots.push({ id: "lot-14", lot_number: "14", qr_token: null });
    db.lot_reservations = [{ ...jan, expected_move_out: null }, { ...feb, park_lot_id: "lot-14" }];
    expect((await getRenterHome())!.lotNumber).toBe("9");
    clock.today = "2027-02-02";
    expect((await getRenterHome())!.lotNumber).toBe("14");
  });

  it("no link covers today (she signed, moves in next month): the next to start is the stay, not the wrap-up", async () => {
    db.lot_reservations = [{ ...feb, expected_move_out: null }];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBeNull();
    expect(v!.lotNumber).toBe("9");
  });

  it("a monthly agreement that lapsed with no successor written: still living there, never the wrap-up", async () => {
    // The 'rent quietly stops' case (renew-actions): the only live link ended
    // last month and nothing covers today. She has not moved out.
    clock.today = "2027-02-10";
    db.lot_reservations = [{ ...jan, expected_move_out: null }];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBeNull();
    expect(v!.leavingOn).toBeNull();
  });

  it("the ended row carries the wrap-up only when NO live link exists", async () => {
    clock.today = "2027-02-10";
    db.lot_reservations = [{ ...jan, status: "ended", during: "[2027-01-01,2027-01-28)", moved_out_on: "2027-01-27" }];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBe("2027-01-27");
    expect(v!.leavingOn).toBe("2027-01-27");
  });

  it("closed out THROUGH the renewal: the ended successor is a later link, and the run-out January link is not where she lives", async () => {
    // She renewed for February, then left on 10 February — recorded on the
    // successor, which is `ended` (trimmed to the day). January is still
    // approved/active, run out, with nothing HELD after it: read from the
    // live links alone that is the lapsed-holdover shape, and the screen
    // showed her January's lot — "rolls on" — ten days after she had gone,
    // with her final part month and her deposit nowhere on it.
    clock.today = "2027-02-20";
    db.lot_reservations = [
      { ...jan, expected_move_out: null },
      { ...feb, status: "ended", during: "[2027-02-01,2027-02-11)", moved_out_on: "2027-02-10" },
    ];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBe("2027-02-10");
    // The other half: the successor WITHDRAWN (cancelled — never lived in)
    // leaves January the lapsed holdover it is; she is still living there.
    db.lot_reservations = [
      { ...jan, expected_move_out: null },
      { ...feb, status: "cancelled" },
    ];
    const still = await getRenterHome();
    expect(still!.tenancyEnded).toBeNull();
    expect(still!.lotNumber).toBe("9");
  });

  it("the pick is by coverage — pinned in source, using the roll's own coversDay, and the lapsed fallback is the roll's own lapsedRowOf", () => {
    const src = readFileSync(fileURLToPath(new URL("./my-data.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{ coversDay, lapsedRowOf \} from "@\/app\/park\/park-helpers"/);
    expect(src).toMatch(/liveStays\.find\(\(r\) => coversDay\(parseDaterange\(r\.during as string\), today\)\)/);
    // The fallback is the ONE rule, fed EVERY row (stays — held and ended),
    // never "any live link": collapse it to `liveStays[0]` and a household
    // closed out through their renewal reads as living on the run-out link.
    expect(src).toMatch(/const lapsed = lapsedRowOf\(\s*\(stays \?\? \[\]\)\.map/);
    expect(src).toMatch(/\?\? lapsed;/);
    expect(src).not.toMatch(/\?\? liveStays\[0\]/);
    expect(src, "the notice is read off one link again").not.toMatch(/leavingOn: \(stay\.expected_move_out/);
    expect(src).toMatch(/liveStays\.map\(\(r\) => \(r\.expected_move_out as string \| null\) \?\? null\)\.find/);
  });
});

/**
 * WHETHER THE MOVE-OUT MONTH IS ALREADY BILLED. The resident's on-account
 * card says "it comes off your bills, oldest first" — true right up to the
 * last bill. Once the tenancy has ended AND that month is billed, no next
 * bill will ever take it, and the card must stop promising one. A move-out
 * recorded before that month's run still raises a prorated final bill (and
 * R1 settles it from money on account), so `tenancyEnded` alone is not the
 * test — the screen reads this flag.
 */
describe("finalMonthBilled", () => {
  const ended = { id: "res-9", park_lot_id: "lot-9", renter_id: "renter-9", during: "[2027-01-01,2027-01-28)", term: "monthly",
    status: "ended", expected_move_out: "2027-01-27", tenancy_began_on: "2015-04-01", moved_out_on: "2027-01-27", created_at: "2026-12-20" };

  it("false while the tenancy stands", async () => {
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBeNull();
    expect(v!.finalMonthBilled).toBe(false);
  });

  it("true once the move-out month has a bill in her chain", async () => {
    db.lot_reservations = [ended];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBe("2027-01-27");
    expect(v!.finalMonthBilled, "January is billed (charge-jan)").toBe(true);
  });

  it("false when the move-out month is not yet billed — the final part-month is still to come, and money on account WILL come off it", async () => {
    db.lot_reservations = [{ ...ended, during: "[2027-01-01,2027-03-16)", expected_move_out: "2027-03-15", moved_out_on: "2027-03-15" }];
    const v = await getRenterHome();
    expect(v!.tenancyEnded).toBe("2027-03-15");
    expect(v!.finalMonthBilled).toBe(false);
  });

  it("a void bill for that month does not count", async () => {
    db.lot_reservations = [ended];
    db.park_charges = db.park_charges.map((c) => (c.id === "charge-jan" ? { ...c, status: "void" } : c));
    const v = await getRenterHome();
    expect(v!.finalMonthBilled).toBe(false);
  });
});
