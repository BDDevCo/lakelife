import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
