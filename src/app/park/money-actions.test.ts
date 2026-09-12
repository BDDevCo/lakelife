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
    expect(paymentReads(SRC()).length).toBeGreaterThanOrEqual(4);
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
    const filters = fn.match(/\.is\("returned_at", null\)/g) ?? [];
    expect(filters.length, "one filter for money on account, one for deposits")
      .toBeGreaterThanOrEqual(2);
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
class Q {
  constructor(private t: string) { touched.push(this.t); }
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  insert() { touched.push(`${this.t}:insert`); return this; }
  single() { return Promise.resolve({ data: { id: "p1", receipt_no: 1 }, error: null }); }
  maybeSingle() { return Promise.resolve({ data: { id: "renter-9", display_name: "Household 9", park_id: "park-haven" }, error: null }); }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/app/park/data", () => ({ assertMyPark: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));
const { recordOnAccount, recordDeposit } = await import("./money-actions");
const TODAY = todayLakeDate();

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
