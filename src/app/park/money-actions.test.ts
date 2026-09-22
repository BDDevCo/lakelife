import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { todayLakeDate } from "@/lib/booking";

/**
 * MONEY THE BANK TOOK BACK MUST STOP COUNTING EVERYWHERE, NOT IN ONE PLACE.
 *
 * `recompute_charge_paid` (0155) drops a returned payment out of a BILL's
 * paid_total. It cannot help the two piles of money that have no bill:
 * `kind = 'rent'` with no `charge_id` — money on account — and `kind =
 * 'deposit'`. Both are summed in JavaScript, in `getHeldMoney`, and both would
 * keep reading as cash the park is holding after the bank pulled it back.
 *
 * That is this repo's standing failure — the rule in one doorway of three — so
 * these scan for the CLASS: every read of `park_payments` in this module has
 * to name `returned_at`, and a fourth doorway added later fails here rather
 * than quietly counting money that isn't there.
 *
 * Source scans, for the reason `refund-path.test.ts` gives: every behavioural
 * path through this module needs a live Postgres, a park, a household and a
 * payment. A scan earns its keep only if it would go red when the property
 * breaks, so each one asserts the thing it measures actually exists first.
 */
const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
/** Comments are prose and can name anything; only code counts. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * One exported function's body, start of signature to the next `export`.
 *
 * NOT `[\s\S]*?\n}` — `getHeldMoney` returns an inline object type, so its
 * signature contains a line beginning `}> {` and that regex stops there,
 * measuring 173 characters of type annotation and passing whatever it is
 * asked. A scan that silently shrinks to nothing is worse than no scan.
 */
const fnBody = (src: string, name: string, min = 400) => {
  const at = src.indexOf(`export async function ${name}`);
  const next = at < 0 ? -1 : src.indexOf("\nexport ", at + 1);
  const fn = at < 0 ? "" : src.slice(at, next < 0 ? undefined : next);
  expect(fn.length, `${name} not found — this scan is measuring nothing`).toBeGreaterThan(min);
  return fn;
};

const SRC = () => code("app/park/money-actions.ts");

/** Every `.from("park_payments")` whose next call is a `.select(` — the reads. */
const paymentReads = (src: string) =>
  src
    .split('.from("park_payments")')
    .slice(1)
    .map((s) => s.slice(0, 400))
    .filter((s) => /^\s*\.select\(/.test(s));

describe("every read of a payment in this module knows about a bank return", () => {
  it("has park_payments reads to scan at all", () => {
    // Three since 0167: the on-account pile is read through the view, which
    // filters the bank return in the database (see the next describe).
    expect(paymentReads(SRC()).length).toBeGreaterThanOrEqual(3);
  });

  it("names returned_at in every one of them", () => {
    // A fifth read that forgets the column lands here, not on a park owner's
    // screen as money he does not have.
    for (const chain of paymentReads(SRC())) {
      expect(chain, `a park_payments read that ignores a bank return:\n${chain.slice(0, 200)}`)
        .toMatch(/returned_at/);
    }
  });
});

describe("money that did not settle cannot be spent", () => {
  it("applyOnAccount refuses a payment the bank took back", () => {
    const fn = fnBody(SRC(), "applyOnAccount");
    expect(fn, "the row it decides on has to carry returned_at").toMatch(/returned_at/);
    expect(fn, "and it has to actually branch on it").toMatch(/pay\.returned_at/);
  });

  it("returnDeposit refuses to hand back a deposit that never settled", () => {
    // Returning a deposit the bank has already pulled back pays the household
    // twice out of the park's own money.
    const fn = fnBody(SRC(), "returnDeposit");
    expect(fn).toMatch(/dep\.returned_at/);
  });

  it("getHeldMoney leaves returned money out of both piles", () => {
    const fn = fnBody(SRC(), "getHeldMoney", 800);
    // The deposit pile filters by hand; the on-account pile comes from
    // park_on_account_payments (0167), whose definition carries the same two
    // filters — pinned below against the migration file, not assumed.
    const filters = fn.match(/\.is\("returned_at", null\)/g) ?? [];
    expect(filters.length, "the deposit read filters the bank return").toBeGreaterThanOrEqual(1);
    expect(fn).toMatch(/\.from\("park_on_account_payments"\)/);
    // NOT `.gt("remaining", 0)`: a cheque the run has spent in full stays
    // listed (remaining 0, allocated > 0) so "Take it back" is reachable when
    // it bounces — the filter is on remaining OR allocated, in the reader.
    expect(fn, "a spent cheque stays reachable").toMatch(/remaining ?\?\? 0\) > 0 \|\| Number\(r\.allocated/);
    expect(fn).not.toMatch(/\.gt\("remaining", 0\)/);
    const view = read("../supabase/migrations/0167_money_on_account_comes_off_the_next_bills.sql");
    const def = view.slice(view.indexOf("create or replace view public.park_on_account_payments"), view.indexOf("comment on view public.park_on_account_payments"));
    expect(def.length).toBeGreaterThan(200);
    expect(def).toMatch(/p\.reversed_at is null/);
    expect(def).toMatch(/p\.returned_at is null/);
    expect(def).toMatch(/p\.charge_id is null/);
    expect(def).toMatch(/p\.kind = 'rent'/);
  });
});

describe("the deposit return and the bank return are not the same column", () => {
  it("keeps reading returned_on for the deposit the office handed back", () => {
    // park_payments.returned_on / returned_amount / return_note (0102, 0103)
    // are a SECURITY DEPOSIT going back to a departing tenant. returned_at is
    // a bank pulling money back. The names are one letter apart and mean
    // opposite things, so both must still be here.
    const fn = fnBody(SRC(), "returnDeposit");
    expect(fn).toMatch(/returned_on/);
    expect(fn).toMatch(/returned_amount/);
  });
});

// ---------------------------------------------------------------------------
// THE TWO RAILS ARE REFUSED AT THE API, BEFORE ANYTHING IS READ OR WRITTEN.
//
// The rent screen's door refused `card`/`ach` before its insert; these two
// doors kept their own six-way list with both rails on it. A deposit carries
// no reference at all, so `ach` here ALWAYS hit 0108 and the office read the
// raw constraint text; money on account keyed as `ach` with any reference
// became a row 0142 will never let him reverse, with no charge to refund
// against. The selects stopped offering the rails; rule 1's standard is the
// API. The real actions, against a fake that records every touch.
// ---------------------------------------------------------------------------
const touched: string[] = [];
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
/** Every row handed to `.insert`, with the table it went to. */
const inserted: Row[] = [];
/** Make the next park_payment_allocations insert fail with this error. */
let nextAllocationError: { code: string; message: string } | null = null;
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);
/** A live allocation: not taken back off its bill (0167 R3 — removed rows count toward nothing). */
const live = (a: Row) => a.removed_at == null;
/**
 * park_payment_remaining and the view, modelled (0167, 0169). MEMBERSHIP is
 * the 0169 definition: kind rent, standing, and no charge OR a charge whose
 * status is void — a payment against a cancelled bill is on account, its
 * money released, the row never moved. renter_id is coalesced from the
 * charge, and the three released_* columns are appended.
 */
function onAccountView(): Row[] {
  const chargeOf = (id: unknown) => (db.park_charges ?? []).find((c) => c.id === id) ?? null;
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.reversed_at == null && p.returned_at == null
      && (p.charge_id == null || chargeOf(p.charge_id)?.status === "void"))
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && live(a)).reduce((t, a) => t + cents(a.amount), 0);
      const handedBack = cents(p.returned_amount);
      const refunded = (db.park_refunds ?? []).filter((r) => r.payment_id === p.id).reduce((t, r) => t + cents(r.amount), 0);
      const c = p.charge_id == null ? null : chargeOf(p.charge_id);
      return { payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id ?? c?.renter_id ?? null, amount: p.amount, received_on: p.received_on,
        created_at: p.created_at ?? null,
        allocated: allocated / 100, refunded: refunded / 100, remaining: Math.max(0, cents(p.amount) - allocated - handedBack - refunded) / 100, method: p.method,
        handed_back: handedBack / 100, handed_back_on: p.returned_on ?? null,
        reference: p.reference ?? null, receipt_no: p.receipt_no ?? null, note: p.note ?? null, idempotency_key: p.idempotency_key ?? null,
        released_from_charge_id: c ? c.id : null, released_from_month: c ? c.period_month : null, released_on: c ? (c.voided_at ?? null) : null };
    });
}
function recompute(chargeId: string) {
  const c = (db.park_charges ?? []).find((x) => x.id === chargeId);
  if (!c) return;
  const applied = (db.park_payment_allocations ?? []).filter((a) => a.charge_id === chargeId && live(a)).reduce((t, a) => t + cents(a.amount), 0);
  const paid = applied / 100;
  c.paid_total = paid;
  c.status = paid >= Number(c.amount) ? "paid" : "open";
}
/** Every `.update` payload, with its table and the rows it reached. */
const updated: Array<{ table: string; patch: Row; ids: string[] }> = [];
/** Fail the next `.update` on that table. */
let nextUpdateError: { table: string; error: { code: string; message: string } } | null = null;
/** Fail the next plain read on that table — a dropped connection between a door's insert and its sentence. */
let nextReadError: { table: string; error: { code: string; message: string } } | null = null;
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private pending: Row[] | null = null;
  private failed: { code: string; message: string } | null = null;
  private patch: Row | null = null;
  constructor(private t: string) { touched.push(this.t); }
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.fs.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.fs.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gt(c: string, v: number) { this.fs.push((r) => Number(r[c]) > v); return this; }
  in(c: string, vs: unknown[]) { this.fs.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  limit() { return this; }
  private rows(): Row[] {
    const source = this.t === "park_on_account_payments" ? onAccountView() : (db[this.t] ?? []);
    return source.filter((r) => this.fs.every((f) => f(r)));
  }
  insert(row: Row) {
    touched.push(`${this.t}:insert`);
    if (this.t === "park_payment_allocations" && nextAllocationError) {
      this.failed = nextAllocationError; nextAllocationError = null; return this;
    }
    const w: Row = { id: `${this.t}-${(db[this.t] ??= []).length + 1}`, receipt_no: (db[this.t] ?? []).length + 1, ...row };
    // 0167's park_payment_allocations_live_line_idx is PARTIAL on removed_at
    // is null: a line taken off a bill and applied again is the ordinary
    // correction, and the fake must not refuse what the database allows.
    if (this.t === "park_payment_allocations"
        && (db[this.t] ?? []).some((a) => a.payment_id === w.payment_id && a.charge_id === w.charge_id && live(a))) {
      this.failed = { code: "23505", message: "duplicate key value violates unique constraint park_payment_allocations_payment_id_charge_id_key" };
      return this;
    }
    (db[this.t] ??= []).push(w);
    inserted.push({ ...w, __table: this.t });
    if (this.t === "park_payment_allocations") recompute(w.charge_id as string);
    this.pending = [w];
    return this;
  }
  update(patch: Row) {
    touched.push(`${this.t}:update`);
    if (nextUpdateError && nextUpdateError.table === this.t) {
      this.failed = nextUpdateError.error; nextUpdateError = null; return this;
    }
    this.patch = patch; return this;
  }
  private resolve() {
    if (this.failed) return Promise.resolve({ data: null, error: this.failed });
    if (this.pending) return Promise.resolve({ data: this.pending, error: null });
    if (this.patch) {
      const hit = this.rows();
      // 0167's guard on an UPDATE: only a removal, once, with a reason.
      if (this.t === "park_payment_allocations") {
        for (const r of hit) {
          if (r.removed_at != null) return Promise.resolve({ data: null, error: { code: "P0001", message: "park_payment_allocations: that allocation was already taken off its bill" } });
          if (!String(this.patch.removed_reason ?? "").trim()) return Promise.resolve({ data: null, error: { code: "P0001", message: "park_payment_allocations: say why it is coming off the bill — the record has to carry the reason" } });
        }
      }
      // 0168's guard on park_payments: a hand-back is recorded once, never
      // more than is still on account, and a handed-back row cannot be reversed.
      if (this.t === "park_payments") {
        for (const r of hit) {
          if (this.patch.returned_on != null && r.returned_on != null) return Promise.resolve({ data: null, error: { code: "P0001", message: `park_payments: that money was already handed back on ${r.returned_on} — a hand-back is recorded once` } });
          if (this.patch.returned_on != null && (r.kind ?? "rent") === "rent") {
            // 0169 §6(iii): money against a LIVE bill is never handed back.
            if (r.charge_id != null && (db.park_charges ?? []).find((c) => c.id === r.charge_id)?.status !== "void") {
              return Promise.resolve({ data: null, error: { code: "P0001", message: "park_payments: money against a live bill is not handed back — reverse it if the record is wrong, or refund it if it came by card" } });
            }
            const left = onAccountView().find((v) => v.payment_id === r.id)?.remaining ?? 0;
            if (cents(this.patch.returned_amount) > cents(left)) return Promise.resolve({ data: null, error: { code: "P0001", message: `park_payments: only ${Number(left).toFixed(2)} of that payment is still on account, and this would hand back ${Number(this.patch.returned_amount).toFixed(2)}` } });
          }
          if (this.patch.reversed_at != null && r.returned_on != null) return Promise.resolve({ data: null, error: { code: "P0001", message: `park_payments: ${r.returned_amount} of that payment was already handed back on ${r.returned_on} — a reversal would contradict the record` } });
        }
      }
      for (const r of hit) Object.assign(r, this.patch);
      updated.push({ table: this.t, patch: this.patch, ids: hit.map((r) => String(r.id)) });
      // sync_charge_paid_from_allocation fires on UPDATE too: the bill gives it back.
      if (this.t === "park_payment_allocations") for (const r of hit) recompute(r.charge_id as string);
      return Promise.resolve({ data: hit, error: null });
    }
    if (nextReadError && nextReadError.table === this.t) {
      const e = nextReadError.error; nextReadError = null;
      return Promise.resolve({ data: null, error: e });
    }
    return Promise.resolve({ data: this.rows(), error: null });
  }
  single() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  maybeSingle() { return this.resolve().then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); }
  then<A, B>(ok?: ((x: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
             bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.resolve().then(ok, bad);
  }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) } }),
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { recordOnAccount, recordDeposit, applyOnAccount, getHeldMoney, unapplyAllocation, handBackOnAccount, returnDeposit } = await import("./money-actions");
const { receiptBody } = await import("./receipt-helpers");
const TODAY = todayLakeDate();

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  inserted.length = 0; touched.length = 0; updated.length = 0; nextAllocationError = null; nextUpdateError = null; nextReadError = null;
  db.parks = [{ id: "park-haven", name: "The Haven", address: "9085 E 500 S" }];
  db.park_renters = [{ id: "renter-9", display_name: "Household 9", park_id: "park-haven", merged_into: null, email: "nine@example.com", contact_pref: "email" }];
  db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "active" }];
  db.park_lots = [{ id: "lot-9", lot_number: "9" }];
  db.park_payments = [];
  db.park_charges = [];
  db.park_payment_allocations = [];
  db.park_refunds = [];
}
beforeEach(seed);

describe("money on account and deposits cannot be keyed on a processor rail", () => {
  beforeEach(() => { touched.length = 0; });

  it("recordDeposit refuses `ach` before any read or insert, with the sentence the rent door uses", async () => {
    const res = await recordDeposit("park-haven", "renter-9", 500, "ach" as never, TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only the processor writes one/);
    expect(res.error).toMatch(/record it as a bank transfer/);
    expect(res.error).not.toMatch(/violates|constraint|try again/i);
    expect(touched).toEqual([]);
  });

  it("recordOnAccount refuses `card` the same way — a reference does not make it a rail the office may use", async () => {
    const res = await recordOnAccount("park-haven", "renter-9", 57.47, "card" as never, "old terminal 4412", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only the processor writes one/);
    expect(touched).toEqual([]);
  });

  it("and anything that is not a way money arrives", async () => {
    const res = await recordOnAccount("park-haven", "renter-9", 57.47, "zelle" as never, "", TODAY, "", "k1");
    expect(res.error).toBe("That isn't a way money arrives.");
    expect(touched).toEqual([]);
  });

  it("still records the four hand-keyed ways", async () => {
    for (const m of ["cash", "check", "transfer", "other"] as const) {
      touched.length = 0;
      const res = await recordDeposit("park-haven", "renter-9", 500, m, TODAY, "", `k-${m}`);
      expect(res.ok, m).toBe(true);
      expect(touched).toContain("park_payments:insert");
    }
  });
});

// ---------------------------------------------------------------------------
// A SIBLING DOOR LEFT BEHIND. The rent door stopped saying "isn't a number"
// of -5 and of 0.004 in one round; these two doors kept saying it, and passed
// 0.004 unrounded to the insert — numeric(10,2) made it 0.00 and the office
// read `violates check constraint "park_payments_amount_check"`. The three
// refusals now live in ledger-helpers and every door reads them.
// ---------------------------------------------------------------------------
describe("a bad amount is told what is wrong with it, before anything is touched", () => {
  beforeEach(() => { touched.length = 0; });

  it("recordOnAccount refuses 0.004 as less than a cent — never the constraint's name", async () => {
    const res = await recordOnAccount("park-haven", "renter-9", 0.004, "cash", "", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That payment amount is less than a cent.");
    expect(touched).toEqual([]);
  });

  it("recordDeposit says -5 needs to be more than zero — -5 is a number", async () => {
    const res = await recordDeposit("park-haven", "renter-9", -5, "cash", TODAY, "", "k1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That payment amount needs to be more than zero.");
    expect(touched).toEqual([]);
  });

  it("and each door keeps every sentence — NaN, 0, 0.004 — with the typo line after them", async () => {
    const cases: Array<[number, string]> = [
      [Number.NaN, "That payment amount isn't a number."],
      [0, "That payment amount needs to be more than zero."],
      [0.004, "That payment amount is less than a cent."],
      [250_000, "That amount looks like a typo."],
    ];
    for (const [bad, sentence] of cases) {
      touched.length = 0;
      expect((await recordOnAccount("park-haven", "renter-9", bad, "check", "", TODAY, "", "k1")).error, `on account ${bad}`).toBe(sentence);
      expect((await recordDeposit("park-haven", "renter-9", bad, "check", TODAY, "", "k1")).error, `deposit ${bad}`).toBe(sentence);
      expect(touched).toEqual([]);
    }
  });

  it("amountProblem reads the one refusal from ledger-helpers and keeps no sentence of its own", () => {
    const src = SRC();
    const at = src.indexOf("function amountProblem(");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    expect(body).toMatch(/paymentAmountRefusal\(amount\)/);
    expect(src).not.toMatch(/isn't a number/);
    // The typo line is this file's own and comes AFTER the three.
    expect(body.indexOf("paymentAmountRefusal(amount)")).toBeLessThan(body.indexOf("looks like a typo"));
  });
});

// ---------------------------------------------------------------------------
// PUTTING MONEY ON ACCOUNT AGAINST A BILL — AS MUCH AS THE BILL CAN TAKE (0167).
//
// This door refused $1,627.59 against a $542.53 bill: "it would strand the
// difference", because the only way to apply was to move the whole payment
// onto one bill. An allocation is min(what is left on the payment, what is
// left on the bill); the rest stays on account and the sentence says both.
// The real action against a fake that models the allocations table, the
// on-account view and the recompute.
// ---------------------------------------------------------------------------
describe("applyOnAccount applies what the bill can take and says what is left", () => {
  const bill = (id: string, month: string, over: Partial<Row> = {}) => {
    db.park_charges.push({ id, park_id: "park-haven", renter_id: "renter-9", period_month: month, amount: 542.53, paid_total: 0, status: "open", ...over });
  };
  const ahead = (id: string, amount: number, over: Partial<Row> = {}) => {
    db.park_payments.push({ id, park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null, ...over });
  };

  it("a quarter ahead against January: $542.53 applied, $1,085.06 still on account, no refusal", async () => {
    bill("jan", "2027-01"); ahead("q", 1627.59);
    const res = await applyOnAccount("park-haven", "q", "jan");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations).toEqual([
      expect.objectContaining({ park_id: "park-haven", payment_id: "q", charge_id: "jan", amount: 542.53, applied_via: "office", applied_by: "owner-1" }),
    ]);
    expect(db.park_charges[0].status).toBe("paid");
    expect(res.signal).toBe("Applied $542.53 to January 2027 — that bill is settled. $1,085.06 is still on account.");
    expect(res.signal).not.toMatch(/strand/);
  });

  it("then February and March from the same payment, and the fourth month is refused with what is left", async () => {
    bill("jan", "2027-01"); bill("feb", "2027-02"); bill("mar", "2027-03"); bill("apr", "2027-04"); ahead("q", 1627.59);
    await applyOnAccount("park-haven", "q", "jan");
    await applyOnAccount("park-haven", "q", "feb");
    const mar = await applyOnAccount("park-haven", "q", "mar");
    expect(mar.signal).toBe("Applied $542.53 to March 2027 — that bill is settled. Nothing is left on account from that payment.");
    const apr = await applyOnAccount("park-haven", "q", "apr");
    expect(apr.ok).toBe(false);
    expect(apr.error).toBe("Nothing is left on that payment — all of it has already been put against bills.");
    expect(db.park_payment_allocations).toHaveLength(3);
    expect(db.park_charges.map((c) => c.status)).toEqual(["paid", "paid", "paid", "open"]);
  });

  it("less than the bill: the whole remainder goes on and the sentence says what is still owing", async () => {
    bill("jan", "2027-01"); ahead("p", 200);
    const res = await applyOnAccount("park-haven", "p", "jan");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations[0].amount).toBe(200);
    expect(res.signal).toBe("Applied $200.00 to January 2027 — $342.53 still owing on it. Nothing is left on account from that payment.");
  });

  it("a bill already settled takes nothing, and says so by month", async () => {
    bill("jan", "2027-01", { paid_total: 542.53, status: "paid" }); ahead("p", 200);
    const res = await applyOnAccount("park-haven", "p", "jan");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("The January 2027 bill is already settled — nothing to put against it.");
    expect(db.park_payment_allocations).toHaveLength(0);
  });

  it("a second line on the same bill is refused as one line per payment and bill, never 'try again'", async () => {
    bill("jan", "2027-01"); ahead("p", 600);
    await applyOnAccount("park-haven", "p", "jan");
    db.park_charges[0].paid_total = 100; db.park_charges[0].status = "open";   // a refund reopened it
    const res = await applyOnAccount("park-haven", "p", "jan");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(
      "That payment already has a line against the January 2027 bill — the record keeps one live line per payment and bill. " +
      "To put more of it against that bill, take the existing line off first (\"Take it off this bill\" under \"Money not against a bill\"), then apply it again for the new amount.",
    );
    expect(res.error).not.toMatch(/try again/);
  });

  it("the old refusals stand, each before the write", async () => {
    bill("jan", "2027-01");
    ahead("rev", 100, { reversed_at: "2027-01-05T00:00:00Z" });
    ahead("ret", 100, { returned_at: "2027-01-05T00:00:00Z", method: "ach", reference: "x" });
    ahead("dep", 100, { kind: "deposit" });
    ahead("theirs", 100, { renter_id: "renter-2" });
    ahead("moved", 100, { charge_id: "other" });
    expect((await applyOnAccount("park-haven", "rev", "jan")).error).toBe("That payment was reversed.");
    expect((await applyOnAccount("park-haven", "ret", "jan")).error).toMatch(/bank took that payment back/);
    expect((await applyOnAccount("park-haven", "dep", "jan")).error).toMatch(/deposit is held money/);
    expect((await applyOnAccount("park-haven", "theirs", "jan")).error).toMatch(/different household/);
    // "moved" is against a charge that is not void — a LIVE bill's money
    // (0169: on account is membership in the view, never charge_id alone).
    expect((await applyOnAccount("park-haven", "moved", "jan")).error).toBe("That money is against a live bill — it is that bill's money.");
    expect(db.park_payment_allocations).toHaveLength(0);
  });

  it("the database's own refusal reaches the office without the table's name on it", async () => {
    bill("jan", "2027-01"); ahead("p", 200);
    nextAllocationError = { code: "P0001", message: "park_payment_allocations: that bill only has 0.00 left on it, and this would apply 200.00" };
    const res = await applyOnAccount("park-haven", "p", "jan");
    expect(res.error).toBe("Couldn't apply that — that bill only has 0.00 left on it, and this would apply 200.00");
  });

  it("the 'strand the difference' refusal and the charge_id move are gone from the source", () => {
    const fn = fnBody(SRC(), "applyOnAccount", 800);
    expect(fn).not.toMatch(/strand/);
    expect(fn, "the old door — moving the payment onto the bill").not.toMatch(/update\(\{ charge_id/);
    expect(fn).toMatch(/\.from\("park_payment_allocations"\)/);
    expect(fn).toMatch(/applied_via: "office"/);
  });
});

describe("getHeldMoney lists what is still held, not what arrived", () => {
  it("a quarter ahead with two months applied is one month on account", async () => {
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1627.59, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null, receipt_no: 7 });
    db.park_payment_allocations.push(
      { id: "a1", payment_id: "q", charge_id: "jan", amount: 542.53 },
      { id: "a2", payment_id: "q", charge_id: "feb", amount: 542.53 },
    );
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount).toHaveLength(1);
    expect(held.onAccount[0]).toMatchObject({ paymentId: "q", amount: 1627.59, allocated: 1085.06, remaining: 542.53, renterName: "Household 9", receiptNo: 7 });
    expect(held.onAccountTotal).toBe(542.53);
  });

  it("a payment wholly applied stays listed at $0 remaining — 'Take it back' has to stay reachable", async () => {
    // 17 of 18 Haven households pay by cheque. A quarter-ahead cheque
    // bounces AFTER the run has spent it on three months; this panel is the
    // only screen with "Take it back" on a cheque with no bill, so dropping
    // the row the morning March was applied made the reversal unreachable
    // in exactly the case it was built for. Listed, contributing $0.
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    db.park_payment_allocations.push({ id: "a1", payment_id: "q", charge_id: "jan", amount: 542.53 });
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount).toHaveLength(1);
    expect(held.onAccount[0]).toMatchObject({ paymentId: "q", remaining: 0, allocated: 542.53, amount: 542.53 });
    expect(held.onAccountTotal).toBe(0);
  });

  it("the on-account half of a split cheque says so — 'Take it back' on it reverses the bill's half too — and ONLY when that half stands", async () => {
    // recordPayment writes $600 on a $542.53 bill as two rows under one key
    // and key + ":onaccount"; reversePayment takes both back whichever half
    // is tapped. The panel's confirm must not say "Reverse $57.47" about an
    // act that reverses $600, so the row carries the fact — READ from the
    // sibling row, never derived from the key's suffix: recordPayment writes
    // the suffix whether or not a bill row exists (a payment keyed over a
    // settled bill lands entirely on account), so the suffix alone said
    // "the whole cheque — and the part against the bill" about $542.53 in
    // cash with no other half. Collapsed both ways: a key-derived flag
    // fails on `lone`; a flag that never reads fails on `half`.
    db.park_charges.push({ id: "jan", park_id: "park-haven", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    db.park_payments.push(
      { id: "bill-half", park_id: "park-haven", renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, method: "check", received_on: "2027-01-04", reversed_at: null, returned_at: null, idempotency_key: "form-key" },
      { id: "half", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2027-01-04", reversed_at: null, returned_at: null, idempotency_key: "form-key:onaccount" },
      { id: "lone", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "cash", received_on: "2027-01-05", reversed_at: null, returned_at: null, idempotency_key: "form-9-b:onaccount" },
      { id: "bounced-bill", park_id: "park-haven", renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, method: "check", received_on: "2027-01-06", reversed_at: "2027-01-08T00:00:00Z", returned_at: null, idempotency_key: "form-x" },
      { id: "orphan", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 20, method: "check", received_on: "2027-01-06", reversed_at: null, returned_at: null, idempotency_key: "form-x:onaccount" },
      { id: "own", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null, idempotency_key: "form-own" },
      { id: "old", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "cash", received_on: "2026-12-20", reversed_at: null, returned_at: null },
      { id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-12-20", reversed_at: null, returned_at: null, idempotency_key: "dep-key:onaccount" },
    );
    const held = await getHeldMoney("park-haven");
    const by = new Map(held.onAccount.map((r) => [r.paymentId, r.split]));
    expect(by.get("half"), "the bill's half stands, so the confirm names it").toEqual({ against: 542.53, billMonth: "2027-01", billCancelled: false });
    expect(by.get("lone"), "cash keyed over a settled bill has no other half — the suffix alone is not proof").toBeNull();
    expect(by.get("orphan"), "a sibling already reversed is not standing — nothing else goes back with this one").toBeNull();
    expect(by.get("own"), "a cheque keyed through its own door has no other half").toBeNull();
    expect(by.get("old"), "a row with no key at all has no other half").toBeNull();
    expect(held.deposits[0].split, "a deposit is never half of a split").toBeNull();
    // The view is asked for the key — without it every row reads null — and
    // the sibling is READ, with reversePayment's standing filter.
    const fn = fnBody(SRC(), "getHeldMoney", 800);
    expect(fn).toMatch(/receipt_no, note, idempotency_key, released_from_charge_id/);
    expect(fn).toMatch(/\.in\("idempotency_key", sibKeys\)\.is\("reversed_at", null\)\.is\("returned_at", null\)/);
    expect(fn).not.toMatch(/split: splitSiblingKey\(/);
    expect(fn).not.toMatch(/partOfSplit/);
  });

  it("a refund's day is the lake's, not the UTC date of its timestamp", async () => {
    // A card refund keyed at 7:30 in the evening on the 9th is created_at
    // 2027-01-10T00:30:00Z; the row printed "went back to the card on
    // January 10, 2027". lakeDateOf — what the statement's refund note
    // already renders this column through — reads it on the lake clock.
    db.park_payments.push({ id: "c", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "card", reference: "pi_1", received_on: "2027-01-05", reversed_at: null, returned_at: null });
    db.park_refunds.push({ id: "rf-1", park_id: "park-haven", payment_id: "c", amount: 40, created_at: "2027-01-10T00:30:00Z" });
    db.park_refunds.push({ id: "rf-2", park_id: "park-haven", payment_id: "c", amount: 10, created_at: "2027-01-12T15:00:00Z" });
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount[0]).toMatchObject({ paymentId: "c", refunded: 50, remaining: 50 });
    expect(held.onAccount[0].refunds).toEqual([{ amount: 40, on: "2027-01-09" }, { amount: 10, on: "2027-01-12" }]);
  });

  it("a row with nothing applied and nothing left (refunded in full) is not listed — nothing to take back", async () => {
    db.park_payments.push({ id: "gone", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "card", reference: "ch_1", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    // Refunded in full through the processor: the view reads remaining 0, allocated 0.
    db.park_refunds.push({ id: "rf-all", park_id: "park-haven", payment_id: "gone", amount: 100, created_at: "2027-01-09T20:00:00Z" });
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount).toHaveLength(0);
  });

  it("recordOnAccount with nothing open: the sentence promises only what the run keeps, and offers no door", async () => {
    const res = await recordOnAccount("park-haven", "renter-9", 1627.59, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    // NOT "or put it against an open bill now": this branch is reached
    // BECAUSE the settlement placed nothing, i.e. because they have no open
    // bill, and the panel it named reads "No open bill for them yet."
    expect(res.signal).toBe("$1,627.59 recorded for Household 9. It's on account and comes off the next bill you raise for them.");
    expect(res.signal).not.toMatch(/put it against an open bill now/);
    expect(res.signal).not.toMatch(/until you put it against/);
    expect(db.park_payment_allocations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MONEY RECORDED ON ACCOUNT SETTLES THE HOUSEHOLD'S OLDEST OPEN BILL, NOW (R1).
//
// "Need it applied to the months if there is a prepay" — both orderings. A
// cheque keyed on 4 January for a January bill that already exists went on
// account and waited for the office to tap Apply, while the arrears screen
// chased the household. The same helper the run calls settles the oldest
// open bill the moment the money is recorded, and the receipt says so.
// ---------------------------------------------------------------------------
describe("recordOnAccount settles the oldest open bill the moment the money is keyed", () => {
  const bill = (id: string, month: string, over: Partial<Row> = {}) => {
    db.park_charges.push({ id, park_id: "park-haven", renter_id: "renter-9", period_month: month, due_on: `${month}-01`, amount: 542.53, paid_total: 0, status: "open", ...over });
  };

  it("a quarter ahead with January and February open: both settled, the rest on account, and the paper says where it went", async () => {
    bill("feb", "2027-02"); bill("jan", "2027-01");
    const res = await recordOnAccount("park-haven", "renter-9", 1627.59, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    expect(db.park_payment_allocations.map((a) => [a.charge_id, a.amount, a.applied_via, a.applied_by])).toEqual([
      ["jan", 542.53, "office", "owner-1"],
      ["feb", 542.53, "office", "owner-1"],
    ]);
    expect(db.park_charges.map((c) => [c.id, c.status])).toEqual([["feb", "paid"], ["jan", "paid"]]);
    expect(res.signal).toBe(
      "$1,627.59 recorded for Household 9. $542.53 went against January 2027 and $542.53 against February 2027 — $542.53 stays on account and comes off the next bill you raise for them.",
    );
    // THE PAPER: kind on_account, where it went, what is still held.
    expect(res.receipt?.kind).toBe("on_account");
    expect(res.receipt?.onAccount).toEqual({
      amount: 1627.59, receiptNo: res.receiptNo,
      appliedTo: [{ periodMonth: "2027-01", amount: 542.53 }, { periodMonth: "2027-02", amount: 542.53 }],
      remaining: 542.53,
      // The fact the paper's own promise keys on — the toast had it and the
      // receipt built a moment later did not.
      nothingMoreBills: false,
    });
    expect(res.receipt?.lotNumber).toBe("9");
    expect(res.receipt?.payerName).toBe("Household 9");
    expect(res.renterEmail).toBe("nine@example.com");
    const body = receiptBody(res.receipt!);
    expect(body).toMatch(/Against\s+money on account/);
    expect(body).toContain("Where it went   $542.53 to January 2027, $542.53 to February 2027, $542.53 on account");
    expect(body).toContain("The $542.53 on account is held by the office and comes off your next");
    expect(body).toContain("/paid/");
  });

  it("oldest first: January before February, and a part-payment leaves February open", async () => {
    bill("feb", "2027-02"); bill("jan", "2027-01");
    const res = await recordOnAccount("park-haven", "renter-9", 600, "cash", "", TODAY, "", "k1");
    expect(db.park_payment_allocations.map((a) => [a.charge_id, a.amount])).toEqual([["jan", 542.53], ["feb", 57.47]]);
    expect(db.park_charges.find((c) => c.id === "feb")!.paid_total).toBe(57.47);
    expect(res.signal).toBe("$600.00 recorded for Household 9. $542.53 went against January 2027 and $57.47 against February 2027 — nothing stays on account.");
    expect(res.receipt?.onAccount?.remaining).toBe(0);
    expect(receiptBody(res.receipt!)).not.toMatch(/held by the office/);
  });

  it("a paper household gets no email address on the result; the receipt still prints", async () => {
    db.park_renters[0].contact_pref = "paper";
    const res = await recordOnAccount("park-haven", "renter-9", 100, "cash", "", TODAY, "", "k1");
    expect(res.renterEmail).toBeNull();
    expect(res.receipt?.kind).toBe("on_account");
  });

  it("a refused allocation is named — the money is recorded, the receipt says it is still on account", async () => {
    bill("jan", "2027-01");
    nextAllocationError = { code: "P0001", message: "park_payment_allocations: that bill only has 0.00 left on it, and this would apply 542.53" };
    const res = await recordOnAccount("park-haven", "renter-9", 542.53, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    expect(inserted.filter((r) => r.__table === "park_payments")).toHaveLength(1);
    // AND THE BY-HAND DOOR IS STILL NAMED. January really is still open —
    // the guard refused the row, it did not settle the bill — so applying
    // it by hand is the remedy, and this is the one sentence that needs it.
    expect(res.signal).toBe(
      "$542.53 recorded for Household 9. It's on account and comes off the next bill you raise for them — or put it against an open bill now from \"Money not against a bill\". ⚠️ $542.53 of it couldn't be put against a bill — it stays on account.",
    );
    expect(res.receipt?.onAccount).toMatchObject({ appliedTo: [], remaining: 542.53 });
  });

  it("the bills could not be read: the door stays named — a failed read is not 'no open bills'", async () => {
    bill("jan", "2027-01");
    nextReadError = { table: "park_on_account_payments", error: { code: "57P01", message: "terminating connection" } };
    const res = await recordOnAccount("park-haven", "renter-9", 542.53, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    expect(res.signal).toContain("or put it against an open bill now from \"Money not against a bill\"");
    expect(res.signal).toContain("it wasn't put against any bill");
    // Collapsed the other way: with the read working AND nothing open, the
    // clause goes — so the assertion above pins the branch, not the fixture.
    seed();
    const clean = await recordOnAccount("park-haven", "renter-9", 542.53, "check", "1042", TODAY, "", "k2");
    expect(clean.signal).not.toMatch(/put it against an open bill now/);
  });

  /**
   * THE POST-TAP SENTENCE AGREES WITH THE PRE-TAP NOTE. The ⊕ window's note
   * keys "comes off the next bill you raise for them" on lib/tenancy-facts;
   * this door said it to everybody — so a household who had moved out with
   * their final month billed read "theirs to have back" on the note and
   * "comes off the next bill you raise for them" on the toast, about the
   * same cheque. Three shapes on both branches of the toast, the fact read
   * once, and a failed read making no promise at all.
   */
  describe("the promise about what stays on account is decided on the tenancy", () => {
    const DOOR = "\"Money not against a bill\"";
    /** Moved out 27 January with January billed and paid: nothing more bills for them. */
    const departed = () => {
      db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-01-27", during: "[2027-01-01,2027-01-28)", term: "monthly" }];
      db.park_charges.push({ id: "jan-9", park_id: "park-haven", reservation_id: "stay-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    };
    const reads = () => touched.filter((t) => t === "lot_reservations").length;

    it("departed, final month billed, nothing open: theirs to have back — never 'comes off', and no by-hand door for money nothing can use", async () => {
      departed();
      const res = await recordOnAccount("park-haven", "renter-9", 57.47, "check", "1042", TODAY, "", "k1");
      expect(res.ok).toBe(true);
      expect(res.signal).toBe(`$57.47 recorded for Household 9. It's on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`);
      expect(res.signal).not.toMatch(/comes off|next bill|open bill now/);
      // One read for the fact, beside the receipt's own read of their lot (lot_reservations too).
      expect(reads()).toBe(2);
    });

    it("departed, with an old bill still open: it settles that, and what is left is theirs to have back", async () => {
      departed();
      bill("dec", "2026-12", { amount: 40, reservation_id: "stay-9" });
      const res = await recordOnAccount("park-haven", "renter-9", 100, "cash", "", TODAY, "", "k1");
      expect(res.signal).toBe(`$100.00 recorded for Household 9. $40.00 went against December 2026 — $60.00 stays on account — nothing more bills for them, so it's theirs to have back from ${DOOR} on the Rent screen.`);
      expect(res.signal).not.toMatch(/comes off/);
    });

    it("still here: comes off the next bill you raise — the window's own words — on both branches", async () => {
      const res = await recordOnAccount("park-haven", "renter-9", 57.47, "check", "1042", TODAY, "", "k1");
      expect(res.signal).toBe("$57.47 recorded for Household 9. It's on account and comes off the next bill you raise for them.");
      // A fresh household (the $57.47 above would settle January first, oldest money first).
      seed();
      bill("jan", "2027-01");
      const more = await recordOnAccount("park-haven", "renter-9", 600, "check", "1043", TODAY, "", "k2");
      expect(more.signal).toBe("$600.00 recorded for Household 9. $542.53 went against January 2027 — $57.47 stays on account and comes off the next bill you raise for them.");
      expect(more.signal).not.toMatch(/theirs to have back/);
    });

    it("the tenancy could not be read: the money is on account and NO promise is made either way", async () => {
      departed();
      nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
      const res = await recordOnAccount("park-haven", "renter-9", 57.47, "check", "1042", TODAY, "", "k1");
      expect(res.ok, "the money is recorded; a failed read of the fact cannot refuse it").toBe(true);
      expect(nextReadError, "the tenancy read happened").toBeNull();
      expect(res.signal).toBe("$57.47 recorded for Household 9. It's on account.");
      expect(res.signal).not.toMatch(/comes off|theirs to have back|nothing more bills|open bill now/);
      expect(inserted.filter((r) => r.__table === "park_payments")).toHaveLength(1);

      // The other branch, unread: where it went, what stays, and nothing promised.
      seed(); departed();
      bill("dec", "2026-12", { amount: 40, reservation_id: "stay-9" });
      nextReadError = { table: "lot_reservations", error: { code: "57P01", message: "terminating connection" } };
      const older = await recordOnAccount("park-haven", "renter-9", 100, "cash", "", TODAY, "", "k2");
      expect(older.signal).toBe("$100.00 recorded for Household 9. $40.00 went against December 2026 — $60.00 stays on account.");
    });

    it("is the shared clause, from the one helper — no private copy of the promise in this door", () => {
      const fn = fnBody(SRC(), "recordOnAccount", 800);
      expect(fn).toMatch(/nothingMoreBills\(\(await tenancyFactsFor\(admin, \[renterId\]\)\)\.get\(renterId\)\)/);
      expect(fn.match(/onAccountPromise\(nothingMore/g)).toHaveLength(2);
      expect(fn).not.toMatch(/comes off the next bill|theirs to have back|put it against an open one now/);
      expect(SRC()).toMatch(/onAccountPromise,? /);
    });
  });

  it("the settle helper is the run's — one door, the same rows, the same order", () => {
    const src = SRC();
    const fn = fnBody(src, "recordOnAccount", 800);
    expect(fn).toMatch(/await settleOnAccount\(admin, parkId, \[renterId\], "office"/);
    expect(fn, "no private plan of its own").not.toMatch(/planAllocations\(/);
    expect(src).toMatch(/from "@\/lib\/allocations"/);
  });
});

// ---------------------------------------------------------------------------
// TAKING MONEY BACK OFF A BILL (R3). The run and the office can both put a
// household's cheque against the wrong month; until now the only exit was
// reversing the whole cheque — recording as "never arrived" money that did.
// unapplyAllocation is a correction with a reason: the row is marked
// removed (never deleted), the bill owes again, the money is back on account.
// ---------------------------------------------------------------------------
describe("unapplyAllocation takes money back off a bill, with a reason, and says where things stand", () => {
  const bill = (id: string, month: string) => {
    db.park_charges.push({ id, park_id: "park-haven", renter_id: "renter-9", period_month: month, due_on: `${month}-01`, amount: 542.53, paid_total: 0, status: "open" });
  };
  const applied = (id: string, paymentId: string, chargeId: string, amount: number) => {
    db.park_payment_allocations.push({ id, park_id: "park-haven", payment_id: paymentId, charge_id: chargeId, amount, applied_via: "run", removed_at: null });
    recompute(chargeId);
  };

  it("takes February's $542.53 back off: the bill owes again, the money is back on account, the row stays", async () => {
    bill("jan", "2027-01"); bill("feb", "2027-02");
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1085.06, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    applied("al-jan", "q", "jan", 542.53); applied("al-feb", "q", "feb", 542.53);
    expect(db.park_charges.map((c) => c.status)).toEqual(["paid", "paid"]);
    const res = await unapplyAllocation("park-haven", "al-feb", "they asked for February to stay open");
    expect(res.ok).toBe(true);
    // WHAT IS TRUE — BOTH DOORS (R1), AND THE SHARP CASE NAMED: money on
    // account settles the household's oldest open bill the next time a
    // settling door runs for them — the next payment keyed for them as much
    // as the next bill the run raises — and the bill it just came off is
    // open again, so it IS that oldest bill. The sentence used to name the
    // run alone, so the office told a pay-ahead household "it'll sit until
    // March" and the next cash keyed put it straight back on February; then
    // it named both doors but not that February is where it lands. A
    // deposit or a refund recorded for them settles nothing, so "anything
    // recorded" was wider than true and is gone.
    expect(res.signal).toBe(
      "Took $542.53 off February 2027 — that bill is outstanding again, $542.53 owing. $542.53 is back on account for them — put it against the right bill now, or cancel the wrong one. Otherwise the next payment keyed for them, or the next bill the run raises for them, puts it against their oldest open bill — including the one it just came off, if that is still the oldest. The record shows why.",
    );
    expect(res.signal).not.toMatch(/the next run puts it|anything is recorded/);
    expect(res.signal).toMatch(/including the one it just came off/);
    const row = db.park_payment_allocations.find((a) => a.id === "al-feb")!;
    expect(row.removed_at).toBeTruthy();
    expect(row.removed_reason).toBe("they asked for February to stay open");
    expect(row.removed_by).toBe("owner-1");
    expect(db.park_payment_allocations, "never deleted").toHaveLength(2);
    expect(db.park_charges.find((c) => c.id === "feb")).toMatchObject({ paid_total: 0, status: "open" });
    expect(db.park_charges.find((c) => c.id === "jan")).toMatchObject({ paid_total: 542.53, status: "paid" });
    // ONE update, on that row, park-scoped, once.
    expect(updated).toHaveLength(1);
    expect(updated[0].ids).toEqual(["al-feb"]);
    expect(Object.keys(updated[0].patch).sort()).toEqual(["removed_at", "removed_by", "removed_reason"]);
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount[0]).toMatchObject({ paymentId: "q", remaining: 542.53, allocated: 542.53 });
  });

  it("…and the sentence is TRUE: the next payment keyed for them puts the money straight back on the bill it came off", async () => {
    // The door the sentence names. After February is taken off, February is
    // the household's oldest open bill again; $100 cash keyed at the window
    // settles it from the older cheque, applied_by the office, before the
    // run ever runs. Pinned so the sentence cannot drift back to "the run".
    bill("jan", "2027-01"); bill("feb", "2027-02");
    // The cheque is OLDER than the cash keyed today (oldest money first), so
    // its received_on sits before the real clock this test keys the cash on.
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1085.06, method: "check", received_on: "2026-06-28", reversed_at: null, returned_at: null });
    applied("al-jan", "q", "jan", 542.53); applied("al-feb", "q", "feb", 542.53);
    expect((await unapplyAllocation("park-haven", "al-feb", "they asked for it to sit until March")).ok).toBe(true);
    expect(db.park_charges.find((c) => c.id === "feb")).toMatchObject({ paid_total: 0, status: "open" });
    const cash = await recordOnAccount("park-haven", "renter-9", 100, "cash", "", TODAY, "", "k-100");
    expect(cash.ok).toBe(true);
    const liveLines = db.park_payment_allocations.filter((a) => a.removed_at == null).map((a) => [a.payment_id, a.charge_id, a.amount, a.applied_via]);
    expect(liveLines).toEqual([["q", "jan", 542.53, "run"], ["q", "feb", 542.53, "office"]]);
    expect(db.park_charges.find((c) => c.id === "feb")).toMatchObject({ paid_total: 542.53, status: "paid" });
    const held = new Map((await getHeldMoney("park-haven")).onAccount.map((r) => [r.paymentId, r.remaining]));
    expect(held.get("q"), "the cheque is spent again — on the bill it just came off").toBe(0);
    expect(held.get(cash.paymentId!), "the $100 keyed today is what waits").toBe(100);
    // AND THE SIGNAL SAYS SO — the older cheque's move is this act's doing,
    // said the way recordPayment says it. It used to read "$100.00 recorded
    // … It's on account" and nothing about the $542.53 that had just gone
    // back onto February.
    expect(cash.signal).toBe(
      "$100.00 recorded for Household 9. It's on account and comes off the next bill you raise for them. " +
      "And $542.53 went against February 2027 from money they already had on account.",
    );
  });

  it("the older clause is the older money's alone — a payment that settles a bill itself does not count its own lines twice", async () => {
    // Nothing older on account: no clause at all (collapsed the other way).
    bill("jan", "2027-01");
    const alone = await recordOnAccount("park-haven", "renter-9", 542.53, "cash", "", TODAY, "", "k-a");
    expect(alone.signal).toBe("$542.53 recorded for Household 9. $542.53 went against January 2027 — nothing stays on account.");
    expect(alone.signal).not.toMatch(/already had on account/);
    // An older cheque waiting AND this cash settling: each named once, on its own side.
    bill("feb", "2027-02"); bill("mar", "2027-03");
    db.park_payments.push({ id: "old", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-06-28", reversed_at: null, returned_at: null });
    const cash = await recordOnAccount("park-haven", "renter-9", 542.53, "cash", "", TODAY, "", "k-b");
    expect(cash.signal).toBe(
      "$542.53 recorded for Household 9. $542.53 went against March 2027 — nothing stays on account. " +
      "And $542.53 went against February 2027 from money they already had on account.",
    );
  });

  it("a reason is required, before anything is read", async () => {
    const res = await unapplyAllocation("park-haven", "al-feb", "   ");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Say why it's coming off the bill/);
    expect(touched).toEqual([]);
  });

  it("another park's line isn't here; a line already taken off is said so; a double tap removes nothing twice", async () => {
    bill("jan", "2027-01");
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    applied("al-jan", "q", "jan", 542.53);
    db.park_payment_allocations.push({ id: "theirs", park_id: "park-other", payment_id: "x", charge_id: "y", amount: 1, removed_at: null });
    expect((await unapplyAllocation("park-haven", "theirs", "wrong month")).error).toBe("That line isn't here.");
    expect((await unapplyAllocation("park-haven", "al-jan", "wrong month")).ok).toBe(true);
    const again = await unapplyAllocation("park-haven", "al-jan", "wrong month");
    expect(again.ok).toBe(false);
    expect(again.error).toBe("That one's already been taken off its bill.");
    expect(updated).toHaveLength(1);
  });

  it("the database's own refusal reaches the office without the table's name on it", async () => {
    bill("jan", "2027-01");
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    applied("al-jan", "q", "jan", 542.53);
    nextUpdateError = { table: "park_payment_allocations", error: { code: "P0001", message: "park_payment_allocations: that allocation was already taken off its bill" } };
    const res = await unapplyAllocation("park-haven", "al-jan", "wrong month");
    expect(res.error).toBe("Couldn't take that off — that allocation was already taken off its bill");
  });

  it("when the payment itself no longer stands, the sentence says nothing is on account", async () => {
    bill("jan", "2027-01");
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: "2027-01-09T00:00:00Z", returned_at: null });
    db.park_payment_allocations.push({ id: "al-jan", park_id: "park-haven", payment_id: "q", charge_id: "jan", amount: 542.53, applied_via: "run", removed_at: null });
    const res = await unapplyAllocation("park-haven", "al-jan", "tidying the record after the bounce");
    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/That payment isn't standing any more, so nothing of it is on account\./);
    expect(res.signal).not.toMatch(/back on account/);
    // And the bill did not move: the recompute stopped counting this line
    // the day the cheque bounced, so it has been outstanding SINCE then.
    expect(res.signal).toBe(
      "Took $542.53 off January 2027 — that bill has been outstanding since the payment was taken back, $542.53 owing. That payment isn't standing any more, so nothing of it is on account. The record shows why.",
    );
    expect(res.signal).not.toMatch(/outstanding again/);
  });

  it("the write is a removal, never a delete, and the read is park-scoped", () => {
    const fn = fnBody(SRC(), "unapplyAllocation", 800);
    expect(fn).not.toMatch(/\.delete\(/);
    expect(fn).toMatch(/\.update\(\{ removed_at:/);
    expect(fn).toMatch(/\.is\("removed_at", null\)/);
    expect(fn.match(/\.eq\("park_id", parkId\)/g)?.length, "park-scoped on the read AND the write").toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// CASH HANDED BACK ACROSS THE WINDOW (0168). A household leaves with $57.47
// of theirs still on account; nothing will bill for them again; the office
// hands it over. Until 0168 the only control on that row was Take it back —
// a reversal, which records that the cheque never arrived and reopens
// January on every screen. The hand-back is the deposit's stamp on a rent
// row: a day, an amount no more than is still on account, and a reason.
// ---------------------------------------------------------------------------
describe("handBackOnAccount — the deposit's stamp on rent on account", () => {
  const bill = (id: string, month: string, over: Partial<Row> = {}) => {
    db.park_charges.push({ id, park_id: "park-haven", renter_id: "renter-9", period_month: month, due_on: `${month}-01`, amount: 542.53, paid_total: 0, status: "open", ...over });
  };
  const split = () => {
    bill("jan", "2027-01", { paid_total: 542.53, status: "paid" });
    db.park_payments.push(
      { id: "bill-half", park_id: "park-haven", renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, method: "check", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null, idempotency_key: "form-key" },
      { id: "acct", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null, idempotency_key: "form-key:onaccount", receipt_no: 102 },
    );
  };

  it("hands the $57.47 back: the row is stamped once, remaining is 0, January stays paid, and the sentence says what it did", async () => {
    split();
    const res = await handBackOnAccount("park-haven", "acct", 57.47, TODAY, "moved out 27 January; nothing more bills");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe(`$57.47 handed back on ${new Date(`${TODAY}T12:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })} — the record shows why. Nothing of theirs is on account any more.`);
    expect(res.signal).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const row = db.park_payments.find((p) => p.id === "acct")!;
    expect(row).toMatchObject({ returned_on: TODAY, returned_amount: 57.47, return_note: "moved out 27 January; nothing more bills", reversed_at: null });
    // THE STAMP, not a reversal and not a negative row.
    expect(updated).toHaveLength(1);
    expect(Object.keys(updated[0].patch).sort()).toEqual(["return_note", "returned_amount", "returned_on"]);
    expect(inserted.filter((r) => r.__table === "park_payments")).toHaveLength(0);
    expect(db.park_charges.find((c) => c.id === "jan")).toMatchObject({ paid_total: 542.53, status: "paid" });
    // And every reader of the view agrees: remaining 0, handed back 57.47.
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount.find((r) => r.paymentId === "acct")).toMatchObject({ remaining: 0, handedBack: 57.47, handedBackOn: TODAY });
    expect(held.onAccountTotal).toBe(0);
  });

  it("part of it: $40 of $57.47 goes back and $17.47 stays for the next bill", async () => {
    split();
    const res = await handBackOnAccount("park-haven", "acct", 40, TODAY, "overpaid; $40 back");
    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/\$40\.00 handed back on .* \$17\.47 of theirs is still on account\.$/);
    expect((await getHeldMoney("park-haven")).onAccount.find((r) => r.paymentId === "acct")).toMatchObject({ remaining: 17.47, handedBack: 40 });
  });

  it("the sentence names the HOUSEHOLD's money, not this payment's: a second cheque and a deposit still held are said", async () => {
    // Handing back $57.47 across the window to a household that has left:
    // the office needs to hear about the $500 deposit while they are there.
    split();
    db.park_payments.push(
      { id: "second", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "cash", received_on: "2026-06-06", reversed_at: null, returned_at: null, returned_on: null },
      { id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null },
      // Another household's money is not theirs.
      { id: "other", park_id: "park-haven", renter_id: "renter-14", charge_id: null, kind: "rent", amount: 999, method: "cash", received_on: "2026-06-06", reversed_at: null, returned_at: null, returned_on: null },
    );
    const res = await handBackOnAccount("park-haven", "acct", 57.47, TODAY, "moved out");
    expect(res.ok).toBe(true);
    expect(res.signal).toMatch(/ — the record shows why\. \$100\.00 of theirs is still on account\. You still hold their \$500\.00 deposit\.$/);
    expect(res.signal).not.toMatch(/999/);
    // Read through the one household reader, never `remaining − amount`.
    const fn = read("app/park/money-actions.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const body = fn.slice(fn.indexOf("export async function handBackOnAccount"), fn.indexOf("export interface OnAccountRow"));
    expect(body).toMatch(/await heldOnAccountFor\(admin, parkId, pay\.renter_id as string\)/);
    expect(body).not.toMatch(/remaining - amount|remaining − amount/);
  });

  it("the ceiling is what is STILL on account — never the cheque", async () => {
    split();
    const res = await handBackOnAccount("park-haven", "acct", 57.48, TODAY, "moved out");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Only $57.47 of that payment is still on account — the rest is against bills and stays there. You can hand back up to $57.47.");
    expect(updated).toHaveLength(0);
    // A cheque part-applied: $1,085.06 of $1,627.59 on bills leaves $542.53 to hand back, not $1,627.59.
    db.park_payments.push({ id: "q", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 1627.59, method: "check", received_on: "2026-06-28", reversed_at: null, returned_at: null, returned_on: null });
    db.park_payment_allocations.push({ id: "a1", payment_id: "q", charge_id: "jan", amount: 542.53 }, { id: "a2", payment_id: "q", charge_id: "feb", amount: 542.53 });
    expect((await handBackOnAccount("park-haven", "q", 600, TODAY, "x")).error).toMatch(/Only \$542\.53 of that payment is still on account/);
    expect((await handBackOnAccount("park-haven", "q", 542.53, TODAY, "moved out")).ok).toBe(true);
  });

  it("a reason is required whatever the amount, before anything is read", async () => {
    split();
    const res = await handBackOnAccount("park-haven", "acct", 57.47, TODAY, "   ");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Say why it's going back/);
    expect(touched).toEqual([]);
  });

  it("a day it cannot read is refused as the day it WENT BACK — the receipt doors say 'arrived'", async () => {
    // dateProblem is shared by the four doors; its format refusal said
    // "Pick the day the money arrived." on the hand-back and the deposit's
    // return, about the day it left.
    split();
    expect((await handBackOnAccount("park-haven", "acct", 57.47, "next tuesday", "moved out")).error).toBe("Pick the day it went back.");
    expect((await returnDeposit("park-haven", "acct", 57.47, "next tuesday", "")).error).toBe("Pick the day it went back.");
    expect((await recordOnAccount("park-haven", "renter-9", 100, "cash", "", "next tuesday", "", "k")).error).toBe("Pick the day the money arrived.");
    expect((await recordDeposit("park-haven", "renter-9", 100, "cash", "next tuesday")).error).toBe("Pick the day the money arrived.");
    expect(touched).toEqual([]);
  });

  it("once: a second hand-back is refused by name, and a double tap reaches nothing", async () => {
    split();
    expect((await handBackOnAccount("park-haven", "acct", 20, TODAY, "first")).ok).toBe(true);
    const again = await handBackOnAccount("park-haven", "acct", 20, TODAY, "second");
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already handed back on .* — a hand-back is recorded once\./);
    expect(again.error).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(updated).toHaveLength(1);
  });

  it("refuses what is not rent on account: the bill's half, a deposit, card money, a reversed row, a spent cheque", async () => {
    split();
    expect((await handBackOnAccount("park-haven", "bill-half", 1, TODAY, "x")).error).toBe("That money is against a live bill, so it isn't on account — take it back with a reason if it was recorded wrongly.");
    db.park_payments.push({ id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
    expect((await handBackOnAccount("park-haven", "dep", 500, TODAY, "x")).error).toMatch(/That's a deposit — give it back from its own line/);
    db.park_payments.push({ id: "card", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "card", reference: "ch_1", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
    expect((await handBackOnAccount("park-haven", "card", 100, TODAY, "x")).error).toBe("That was paid by card — refund it and it goes back to their card.");
    db.park_payments.push({ id: "gone", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "cash", received_on: "2026-06-05", reversed_at: "2026-06-09T00:00:00Z", returned_at: null, returned_on: null });
    expect((await handBackOnAccount("park-haven", "gone", 100, TODAY, "x")).error).toMatch(/was reversed — there is nothing of theirs to hand back/);
    db.park_payments.push({ id: "spent", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "cash", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
    db.park_payment_allocations.push({ id: "a-spent", payment_id: "spent", charge_id: "jan", amount: 542.53 });
    expect((await handBackOnAccount("park-haven", "spent", 1, TODAY, "x")).error).toMatch(/Nothing of that payment is still on account/);
    expect((await handBackOnAccount("park-haven", "nope", 1, TODAY, "x")).error).toBe("That payment isn't here.");
    expect(updated).toHaveLength(0);
  });

  it("the database's own refusal reaches the office without the table's name on it", async () => {
    split();
    nextUpdateError = { table: "park_payments", error: { code: "P0001", message: "park_payments: only 57.47 of that payment is still on account, and this would hand back 57.48" } };
    const res = await handBackOnAccount("park-haven", "acct", 57.47, TODAY, "moved out");
    expect(res.error).toBe("Couldn't record that — only 57.47 of that payment is still on account, and this would hand back 57.48");
  });

  it("is the deposit's stamp: the same three columns, and returnDeposit is untouched", async () => {
    const fn = fnBody(SRC(), "handBackOnAccount", 800);
    expect(fn).toMatch(/\.update\(\{ returned_on: handedBackOn, returned_amount: amount, return_note: why \}\)/);
    expect(fn).toMatch(/\.is\("returned_on", null\)/);
    expect(fn).not.toMatch(/reversed_at: /);
    expect(fn).not.toMatch(/\.insert\(/);
    // The ceiling is the VIEW's figure — no subtraction here.
    expect(fn).toMatch(/\.from\("park_on_account_payments"\)\.select\("payment_id, remaining"\)/);
    expect(fn).not.toMatch(/amount - /);
    // A deposit still goes back through its own door, with its own kept-with-reason rule.
    db.park_payments.push({ id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
    const res = await returnDeposit("park-haven", "dep", 300, TODAY, "");
    expect(res.error).toMatch(/You're keeping \$200\.00 of their deposit — say why/);
    expect((await returnDeposit("park-haven", "dep", 500, TODAY, "")).signal).toBe("$500.00 returned in full.");
  });
});

// ---------------------------------------------------------------------------
// WHO HAS LEFT, AND WHETHER THEIR LAST MONTH IS BILLED. The held panel and
// Today say "this is theirs to have back" only on BOTH facts: a move-out
// recorded before the month's run still gets a prorated final bill, which the
// run settles from this very money (R1).
// ---------------------------------------------------------------------------
describe("getHeldMoney carries whether the household has left and whether their final month is billed", () => {
  const acct = (id: string, renter: string, amount: number) => {
    db.park_payments.push({ id, park_id: "park-haven", renter_id: renter, charge_id: null, kind: "rent", amount, method: "check", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
  };

  it("a household still here: not ended, and 'No open bill for them yet' stays the truth", async () => {
    acct("p9", "renter-9", 57.47);
    const [r] = (await getHeldMoney("park-haven")).onAccount;
    expect(r).toMatchObject({ tenancyEnded: false, movedOutOn: null, finalMonthBilled: false });
  });

  it("moved out with the final month billed: ended, the day, and billed", async () => {
    db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-01-27", during: "[2027-01-01,2027-01-28)" }];
    db.park_charges.push({ id: "jan-9", park_id: "park-haven", reservation_id: "stay-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    acct("p9", "renter-9", 57.47);
    const [r] = (await getHeldMoney("park-haven")).onAccount;
    expect(r).toMatchObject({ tenancyEnded: true, movedOutOn: "2027-01-27", finalMonthBilled: true });
  });

  it("moved out BEFORE the month's run: ended, but the final month is not billed yet — the run will raise it and take this money", async () => {
    db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-02-03", during: "[2027-01-01,2027-02-04)" }];
    db.park_charges.push({ id: "jan-9", park_id: "park-haven", reservation_id: "stay-9", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    acct("p9", "renter-9", 57.47);
    const [r] = (await getHeldMoney("park-haven")).onAccount;
    expect(r).toMatchObject({ tenancyEnded: true, movedOutOn: "2027-02-03", finalMonthBilled: false });
    // A cancelled (void) February bill does not count as billed.
    db.park_charges.push({ id: "feb-9", park_id: "park-haven", reservation_id: "stay-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 52.53, paid_total: 0, status: "void" });
    expect((await getHeldMoney("park-haven")).onAccount[0].finalMonthBilled).toBe(false);
    db.park_charges.push({ id: "feb-9b", park_id: "park-haven", reservation_id: "stay-9", renter_id: "renter-9", period_month: "2027-02", due_on: "2027-02-01", amount: 52.53, paid_total: 0, status: "open" });
    expect((await getHeldMoney("park-haven")).onAccount[0].finalMonthBilled).toBe(true);
  });

  it("a chain: ended January link plus a withdrawn February link is still 'ended'; a live successor is not", async () => {
    db.lot_reservations = [
      { id: "jan-link", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-01-27", during: "[2027-01-01,2027-01-28)" },
      { id: "feb-link", renter_id: "renter-9", park_lot_id: "lot-9", status: "cancelled", moved_out_on: null, during: "[2027-02-01,2027-03-01)" },
    ];
    db.park_charges.push({ id: "jan-9", park_id: "park-haven", reservation_id: "jan-link", renter_id: "renter-9", period_month: "2027-01", due_on: "2027-01-01", amount: 542.53, paid_total: 542.53, status: "paid" });
    acct("p9", "renter-9", 57.47);
    expect((await getHeldMoney("park-haven")).onAccount[0]).toMatchObject({ tenancyEnded: true, finalMonthBilled: true });
    db.lot_reservations.push({ id: "mar-link", renter_id: "renter-9", park_lot_id: "lot-9", status: "approved", moved_out_on: null, during: "[2027-03-01,2027-04-01)" });
    expect((await getHeldMoney("park-haven")).onAccount[0]).toMatchObject({ tenancyEnded: false, movedOutOn: null, finalMonthBilled: false });
  });

  it("a deposit carries the same facts, and a handed-back rent row stays listed as the record", async () => {
    db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-01-27", during: "[2027-01-01,2027-01-28)" }];
    db.park_payments.push({ id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: null });
    db.park_payments.push({ id: "back", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2026-06-05", reversed_at: null, returned_at: null, returned_on: "2027-01-28", returned_amount: 57.47, return_note: "moved out" });
    const held = await getHeldMoney("park-haven");
    expect(held.deposits[0]).toMatchObject({ tenancyEnded: true, movedOutOn: "2027-01-27" });
    expect(held.onAccount).toHaveLength(1);
    expect(held.onAccount[0]).toMatchObject({ paymentId: "back", remaining: 0, handedBack: 57.47, handedBackOn: "2027-01-28" });
    expect(held.onAccountTotal).toBe(0);
  });

  it("closed out THROUGH the renewal: the run-out January link before an ended February successor is not 'still here' — the roll's rule, not 'a held row exists'", async () => {
    // A move-out marks only the link that covered the day; the link before
    // it stays approved/active, run out, with nothing held after it. Read
    // as "still here", the panel promised their $57.47 to "the next bill"
    // — which will never come. Dates in the past against the real clock,
    // the way this suite reads today.
    db.lot_reservations = [
      { id: "jan-link", renter_id: "renter-9", park_lot_id: "lot-9", status: "active", moved_out_on: null, during: "[2026-01-01,2026-08-01)", term: "monthly", agreement_chain_id: "chain-9", agreement_seq: 1 },
      { id: "aug-link", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2026-08-10", during: "[2026-08-01,2026-08-11)", term: "monthly", agreement_chain_id: "chain-9", agreement_seq: 2 },
    ];
    db.park_charges.push({ id: "aug-9", park_id: "park-haven", reservation_id: "aug-link", renter_id: "renter-9", period_month: "2026-08", due_on: "2026-08-01", amount: 175.01, paid_total: 175.01, status: "paid" });
    acct("p9", "renter-9", 57.47);
    expect((await getHeldMoney("park-haven")).onAccount[0]).toMatchObject({ tenancyEnded: true, movedOutOn: "2026-08-10", finalMonthBilled: true });
    // The other half: the successor WITHDRAWN (never lived in) leaves the
    // run-out link a lapsed holdover — still living there, a next bill
    // will come, and the panel must not say "theirs to have back".
    db.lot_reservations[1].status = "cancelled";
    expect((await getHeldMoney("park-haven")).onAccount[0]).toMatchObject({ tenancyEnded: false, movedOutOn: null, finalMonthBilled: false });
  });

  it("the facts come from the ONE shared reader (@/lib/tenancy-facts), read through mustRead — a failed read is not 'still here'", () => {
    // The held panel carried its own copy of tenancyFactsFor, word for word
    // the resident receipt's and the resident home's; three copies of one
    // rule is how they come to disagree. The panel imports the shared one
    // and keeps no private copy — and the shared one still reads both
    // facts through mustRead.
    const here = SRC();
    expect(here).toMatch(/import \{ tenancyFactsFor, nothingMoreBills \} from "@\/lib\/tenancy-facts";/);
    expect(here).not.toMatch(/async function tenancyFactsFor/);
    expect(here).toMatch(/await tenancyFactsFor\(admin, renterIds\)/);
    const src = code("lib/tenancy-facts.ts");
    const at = src.indexOf("export async function tenancyFactsFor");
    expect(at, "tenancyFactsFor is gone from @/lib/tenancy-facts — this scan measures nothing").toBeGreaterThan(-1);
    const fn = src.slice(at);
    expect(fn.length).toBeGreaterThan(400);
    expect(fn).toMatch(/mustRead\(\s*"whether those households are still here"/);
    expect(fn).toMatch(/mustRead\(\s*"whether their final month is billed"/);
    expect(fn).toMatch(/\.neq\("status", "void"\)/);
    expect(fn).not.toMatch(/\?\? \[\]\)\.filter\(\(s\) => s\.status === "ended"\)\.length === 0/);
    // "Still here" is the roll's one rule (lapsedRowOf, which sees the
    // ended rows), never "a held row exists".
    expect(fn).toMatch(/lapsedRowOf\(shaped, todayISO\) != null/);
    expect(fn).not.toMatch(/if \(s\.status === "approved" \|\| s\.status === "active"\) \{ stillHere\.add/);
  });

  it("a refusal from the database reaches the office through the ONE strip (dbSaid), never a private regex", () => {
    const here = SRC();
    expect(here).toMatch(/import \{ dbSaid \} from "@\/lib\/db-said";/);
    expect(here).not.toMatch(/\.replace\(\/\^park_/);
    expect(here).toMatch(/Couldn't apply that — \$\{dbSaid\(error\.message, "park_payment_allocations"\)\}/);
    expect(here).toMatch(/Couldn't take that off — \$\{dbSaid\(error\.message, "park_payment_allocations"\)\}/);
    expect(here).toMatch(/Couldn't record that — \$\{dbSaid\(error\.message, "park_payments"\)\}/);
  });
});

// ---------------------------------------------------------------------------
// A CANCELLED BILL RELEASES ITS MONEY ONTO ACCOUNT (0169). A $542.53 cheque
// keyed straight against January; the household leaves on the 20th; the
// office cancels the whole-month bill and raises the part month. The payment
// row never moves — charge_id still names January — and the view now LISTS
// it, with the bill's month and the day it was cancelled appended. So "on
// account" is membership in the view: the two doors here used to refuse the
// row on `charge_id` alone ("already against a bill" — about a bill that is
// cancelled), and the held panel had no way to say where the money came from.
// ---------------------------------------------------------------------------
describe("money released from a cancelled bill is on account — by the view's word, not charge_id's", () => {
  const bill = (id: string, month: string, over: Partial<Row> = {}) => {
    db.park_charges.push({ id, park_id: "park-haven", renter_id: "renter-9", reservation_id: "stay-9", period_month: month, due_on: `${month}-01`, amount: 542.53, paid_total: 0, status: "open", ...over });
  };
  /** January paid straight against it, then cancelled; the part month raised beside it. */
  const walked = () => {
    bill("jan", "2027-01", { paid_total: 0, status: "void", voided_at: "2027-01-20T15:00:00Z", void_reason: "moved out 20 Jan; part month raised" });
    bill("jan-part", "2027-01", { amount: 472.53 });
    db.park_payments.push({ id: "direct", park_id: "park-haven", renter_id: "renter-9", charge_id: "jan", kind: "rent", amount: 542.53, method: "check", reference: "1042", received_on: "2027-01-04", reversed_at: null, returned_at: null, returned_on: null, idempotency_key: "form-jan", receipt_no: 12 });
  };
  /** The same, with a LIVE February beside it, paid the same way. */
  const live = () => {
    bill("feb", "2027-02", { paid_total: 542.53, status: "paid" });
    db.park_payments.push({ id: "feb-direct", park_id: "park-haven", renter_id: "renter-9", charge_id: "feb", kind: "rent", amount: 542.53, method: "check", received_on: "2027-02-03", reversed_at: null, returned_at: null, returned_on: null, idempotency_key: "form-feb" });
  };

  it("applyOnAccount: a released row proceeds — the $472.53 part month is settled from the cancelled January's money", async () => {
    walked();
    const res = await applyOnAccount("park-haven", "direct", "jan-part");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toBe("Applied $472.53 to January 2027 — that bill is settled. $70.00 is still on account.");
    expect(db.park_payment_allocations).toEqual([expect.objectContaining({ payment_id: "direct", charge_id: "jan-part", amount: 472.53 })]);
    // The row did not move, and the cancelled bill did not move.
    expect(db.park_payments.find((p) => p.id === "direct")!.charge_id).toBe("jan");
    expect(db.park_charges.find((c) => c.id === "jan")).toMatchObject({ status: "void", paid_total: 0 });
  });

  it("applyOnAccount: a LIVE bill's payment is refused in words — it is that bill's money", async () => {
    walked(); live();
    const res = await applyOnAccount("park-haven", "feb-direct", "jan-part");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That money is against a live bill — it is that bill's money.");
    expect(res.error).not.toMatch(/already against a bill/);
    expect(db.park_payment_allocations).toHaveLength(0);
  });

  it("handBackOnAccount: the $70.00 left of a released row goes back across the window, and the live bill's row is refused", async () => {
    walked(); live();
    db.park_payment_allocations.push({ id: "a-part", park_id: "park-haven", payment_id: "direct", charge_id: "jan-part", amount: 472.53, applied_via: "office", removed_at: null });
    recompute("jan-part");
    // Too much: the ceiling is the view's remaining, the same as any row.
    expect((await handBackOnAccount("park-haven", "direct", 70.01, TODAY, "moved out")).error).toBe(
      "Only $70.00 of that payment is still on account — the rest is against bills and stays there. You can hand back up to $70.00.",
    );
    const res = await handBackOnAccount("park-haven", "direct", 70, TODAY, "moved out; overpaid the part month");
    expect(res.ok, res.error).toBe(true);
    expect(res.signal).toMatch(/^\$70\.00 handed back on .* — the record shows why\. Nothing of theirs is on account any more\.$/);
    expect(db.park_payments.find((p) => p.id === "direct")).toMatchObject({ returned_on: TODAY, returned_amount: 70, charge_id: "jan" });
    // The live February row: refused in words, nothing written.
    const no = await handBackOnAccount("park-haven", "feb-direct", 1, TODAY, "x");
    expect(no.ok).toBe(false);
    expect(no.error).toBe("That money is against a live bill, so it isn't on account — take it back with a reason if it was recorded wrongly.");
    expect(db.park_payments.find((p) => p.id === "feb-direct")!.returned_on).toBeNull();
  });

  it("neither door reads `pay.charge_id` as the refusal — the view row is read first and the test is its absence", () => {
    const src = SRC();
    for (const name of ["applyOnAccount", "handBackOnAccount"]) {
      const fn = fnBody(src, name, 800);
      // Collapsed to the old shape — `if (pay.charge_id)`, or `|| pay.charge_id` — this fails.
      expect(fn, `${name} refuses on charge_id alone`).not.toMatch(/if \(pay\.charge_id\)/);
      expect(fn, `${name} refuses on charge_id alone`).not.toMatch(/\|\| pay\.charge_id\)/);
      expect(fn, `${name} keys the refusal on the view row's absence`).toMatch(/if \(!leftRes\.data && pay\.charge_id\)/);
      // And the view is read BEFORE that line, not after.
      expect(fn.indexOf('.from("park_on_account_payments")')).toBeGreaterThan(0);
      expect(fn.indexOf('.from("park_on_account_payments")')).toBeLessThan(fn.indexOf("!leftRes.data && pay.charge_id"));
    }
  });

  it("getHeldMoney: a released row carries where it came from, its remaining is the one figure, and split stays null", async () => {
    walked();
    db.park_payment_allocations.push({ id: "a-part", park_id: "park-haven", payment_id: "direct", charge_id: "jan-part", amount: 472.53, applied_via: "office", removed_at: null });
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount).toHaveLength(1);
    expect(held.onAccount[0]).toMatchObject({
      paymentId: "direct", renterId: "renter-9", renterName: "Household 9", amount: 542.53, allocated: 472.53, remaining: 70,
      receiptNo: 12, split: null,
      releasedFrom: { chargeId: "jan", month: "2027-01", on: "2027-01-20T15:00:00Z", sibling: null },
    });
    expect(held.onAccountTotal).toBe(70);
    // Collapsed the other way: a row keyed on account through its own door has no releasedFrom.
    db.park_payments.push({ id: "own", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "cash", received_on: "2027-01-05", reversed_at: null, returned_at: null, returned_on: null });
    const again = await getHeldMoney("park-haven");
    expect(again.onAccount.find((r) => r.paymentId === "own")!.releasedFrom).toBeNull();
    // The view is asked for the three columns — without them every row reads null.
    const fn = fnBody(SRC(), "getHeldMoney", 800);
    expect(fn).toMatch(/idempotency_key, released_from_charge_id, released_from_month, released_on"/);
  });

  it("getHeldMoney: a released $600 split — the bill's half finds its on-account sibling, and the sibling says the bill was cancelled", async () => {
    // recordPayment wrote $600 on January as $542.53 against the bill and
    // $57.47 on account under one key. January is cancelled: BOTH halves are
    // on account now. reversePayment takes both back whichever is tapped, so
    // each row's confirm must name the other — and neither may call January
    // a live bill.
    walked();
    db.park_payments.push({ id: "half", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2027-01-04", reversed_at: null, returned_at: null, returned_on: null, idempotency_key: "form-jan:onaccount" });
    const held = await getHeldMoney("park-haven");
    const by = new Map(held.onAccount.map((r) => [r.paymentId, r]));
    expect(by.get("direct")!.releasedFrom).toEqual({ chargeId: "jan", month: "2027-01", on: "2027-01-20T15:00:00Z", sibling: { onAccount: 57.47 } });
    expect(by.get("direct")!.split).toBeNull();
    expect(by.get("half")!.split).toEqual({ against: 542.53, billMonth: "2027-01", billCancelled: true });
    expect(by.get("half")!.releasedFrom).toBeNull();
    // Collapsed both ways: a reversed sibling is not standing — nothing else
    // goes back with the released row; and a split over a LIVE bill keeps
    // billCancelled false.
    db.park_payments.find((p) => p.id === "half")!.reversed_at = "2027-01-21T00:00:00Z";
    expect((await getHeldMoney("park-haven")).onAccount.find((r) => r.paymentId === "direct")!.releasedFrom!.sibling).toBeNull();
    db.park_payments.find((p) => p.id === "half")!.reversed_at = null;
    db.park_charges.find((c) => c.id === "jan")!.status = "paid";
    db.park_charges.find((c) => c.id === "jan")!.paid_total = 542.53;
    const liveSplit = await getHeldMoney("park-haven");
    expect(liveSplit.onAccount.map((r) => r.paymentId)).toEqual(["half"]);
    expect(liveSplit.onAccount[0].split).toEqual({ against: 542.53, billMonth: "2027-01", billCancelled: false });
    // The bills' status is READ for that, not inferred.
    const fn = fnBody(SRC(), "getHeldMoney", 800);
    expect(fn).toMatch(/\.from\("park_charges"\)\.select\("id, period_month, status"\)\.in\("id", sibChargeIds\)/);
  });

  it("getHeldMoney: the walked household's $70.00 carries the move-out facts, so Today's hand-back card can list it", async () => {
    db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "ended", moved_out_on: "2027-01-20", during: "[2027-01-01,2027-01-21)" }];
    walked();
    db.park_payment_allocations.push({ id: "a-part", park_id: "park-haven", payment_id: "direct", charge_id: "jan-part", amount: 472.53, applied_via: "office", removed_at: null });
    const [r] = (await getHeldMoney("park-haven")).onAccount;
    expect(r).toMatchObject({ remaining: 70, tenancyEnded: true, movedOutOn: "2027-01-20", finalMonthBilled: true, releasedFrom: expect.objectContaining({ month: "2027-01" }) });
  });
});
