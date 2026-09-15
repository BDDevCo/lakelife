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
/** park_payment_remaining and the view, modelled (0167). */
function onAccountView(): Row[] {
  return (db.park_payments ?? [])
    .filter((p) => (p.kind ?? "rent") === "rent" && p.charge_id == null && p.reversed_at == null && p.returned_at == null)
    .map((p) => {
      const allocated = (db.park_payment_allocations ?? []).filter((a) => a.payment_id === p.id && live(a)).reduce((t, a) => t + cents(a.amount), 0);
      return { payment_id: p.id, park_id: p.park_id, renter_id: p.renter_id, amount: p.amount, received_on: p.received_on,
        created_at: p.created_at ?? null,
        allocated: allocated / 100, refunded: 0, remaining: Math.max(0, cents(p.amount) - allocated) / 100, method: p.method,
        reference: p.reference ?? null, receipt_no: p.receipt_no ?? null, note: p.note ?? null, idempotency_key: p.idempotency_key ?? null };
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
class Q {
  private fs: Array<(r: Row) => boolean> = [];
  private pending: Row[] | null = null;
  private failed: { code: string; message: string } | null = null;
  private patch: Row | null = null;
  constructor(private t: string) { touched.push(this.t); }
  select() { return this; }
  eq(c: string, v: unknown) { this.fs.push((r) => r[c] === v); return this; }
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
    if (this.t === "park_payment_allocations"
        && (db[this.t] ?? []).some((a) => a.payment_id === w.payment_id && a.charge_id === w.charge_id)) {
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
      for (const r of hit) Object.assign(r, this.patch);
      updated.push({ table: this.t, patch: this.patch, ids: hit.map((r) => String(r.id)) });
      // sync_charge_paid_from_allocation fires on UPDATE too: the bill gives it back.
      if (this.t === "park_payment_allocations") for (const r of hit) recompute(r.charge_id as string);
      return Promise.resolve({ data: hit, error: null });
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
const { recordOnAccount, recordDeposit, applyOnAccount, getHeldMoney, unapplyAllocation } = await import("./money-actions");
const { receiptBody } = await import("./receipt-helpers");
const TODAY = todayLakeDate();

function seed() {
  for (const k of Object.keys(db)) delete db[k];
  inserted.length = 0; touched.length = 0; updated.length = 0; nextAllocationError = null; nextUpdateError = null;
  db.parks = [{ id: "park-haven", name: "The Haven", address: "9085 E 500 S" }];
  db.park_renters = [{ id: "renter-9", display_name: "Household 9", park_id: "park-haven", merged_into: null, email: "nine@example.com", contact_pref: "email" }];
  db.lot_reservations = [{ id: "stay-9", renter_id: "renter-9", park_lot_id: "lot-9", status: "active" }];
  db.park_lots = [{ id: "lot-9", lot_number: "9" }];
  db.park_payments = [];
  db.park_charges = [];
  db.park_payment_allocations = [];
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
    expect((await applyOnAccount("park-haven", "moved", "jan")).error).toBe("That one is already against a bill.");
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

  it("the on-account half of a split cheque says so — 'Take it back' on it reverses the bill's half too", async () => {
    // recordPayment writes $600 on a $542.53 bill as two rows under one key
    // and key + ":onaccount"; reversePayment takes both back whichever half
    // is tapped. The panel's confirm must not say "Reverse $57.47" about an
    // act that reverses $600, so the row carries the fact.
    db.park_payments.push(
      { id: "half", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 57.47, method: "check", received_on: "2027-01-04", reversed_at: null, returned_at: null, idempotency_key: "form-key:onaccount" },
      { id: "own", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 542.53, method: "check", received_on: "2026-12-28", reversed_at: null, returned_at: null, idempotency_key: "form-own" },
      { id: "old", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 100, method: "cash", received_on: "2026-12-20", reversed_at: null, returned_at: null },
      { id: "dep", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "deposit", amount: 500, method: "cash", received_on: "2026-12-20", reversed_at: null, returned_at: null, idempotency_key: "dep-key:onaccount" },
    );
    const held = await getHeldMoney("park-haven");
    const by = new Map(held.onAccount.map((r) => [r.paymentId, r.partOfSplit]));
    expect(by.get("half")).toBe(true);
    expect(by.get("own"), "a cheque keyed through its own door has no other half").toBe(false);
    expect(by.get("old"), "a row with no key at all has no other half").toBe(false);
    expect(held.deposits[0].partOfSplit, "a deposit is never half of a split").toBe(false);
    // The view is asked for the key — without it every row reads false.
    expect(fnBody(SRC(), "getHeldMoney", 800)).toMatch(/receipt_no, note, idempotency_key"/);
  });

  it("a row with nothing applied and nothing left (refunded in full) is not listed — nothing to take back", async () => {
    db.park_payments.push({ id: "gone", park_id: "park-haven", renter_id: "renter-9", charge_id: null, kind: "rent", amount: 0.01, method: "card", reference: "ch_1", received_on: "2026-12-28", reversed_at: null, returned_at: null });
    // The fake's view has no refunds; a fully refunded row reads remaining 0, allocated 0.
    db.park_payments[0].amount = 0;
    const held = await getHeldMoney("park-haven");
    expect(held.onAccount).toHaveLength(0);
  });

  it("recordOnAccount with nothing open: the sentence promises only what the run keeps", async () => {
    const res = await recordOnAccount("park-haven", "renter-9", 1627.59, "check", "1042", TODAY, "", "k1");
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("$1,627.59 recorded for Household 9. It's on account — it comes off the next bill you raise for them, or put it against an open one now.");
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
    expect(res.signal).toBe(
      "$542.53 recorded for Household 9. It's on account — it comes off the next bill you raise for them, or put it against an open one now. ⚠️ $542.53 of it couldn't be put against a bill — it stays on account.",
    );
    expect(res.receipt?.onAccount).toMatchObject({ appliedTo: [], remaining: 542.53 });
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
    // WHAT IS TRUE, not "the next run puts it against their oldest open
    // bill": the run settles only the households it raises a bill for that
    // morning, so a household it skips — or has raised its final bill for —
    // is never touched by it. The money waits for the next bill raised for
    // THEM, and then goes oldest-first.
    expect(res.signal).toBe(
      "Took $542.53 off February 2027 — that bill is outstanding again, $542.53 owing. $542.53 is back on account for them — put it against the right bill now, or cancel the wrong one; the next bill the run raises for them takes it, oldest open bill first. The record shows why.",
    );
    expect(res.signal).not.toMatch(/the next run puts it/);
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
