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

  it("the pick is by coverage — pinned in source, using the roll's own coversDay", () => {
    const src = readFileSync(fileURLToPath(new URL("./my-data.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{ coversDay \} from "@\/app\/park\/park-helpers"/);
    expect(src).toMatch(/liveStays\.find\(\(r\) => coversDay\(parseDaterange\(r\.during as string\), today\)\)/);
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
