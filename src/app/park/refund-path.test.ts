import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ORDER MONEY MOVES IN, AND THE GUARDS AROUND IT.
 *
 * These are source scans, for the same reason `cost-actions.test.ts` is: the
 * properties below are about the SHAPE of a server action — which call happens
 * before which, and whether a failed read is checked — and every behavioural
 * path needs a live Postgres, a park, a household, a charge and a payment.
 *
 * A source scan earns its keep only if it would go red when the property
 * breaks, so each one asserts the thing it is measuring actually exists first.
 */
const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");
/** Comments are prose and can name anything; only code counts. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const fnBody = (src: string, name: string, min = 400) => {
  const fn = src.match(new RegExp(`export async function ${name}[\\s\\S]*?\\n}`))?.[0] ?? "";
  expect(fn.length, `${name} not found — this scan is measuring nothing`).toBeGreaterThan(min);
  return fn;
};

// The processor call is now `giveRefund` (src/lib/charge-gate.ts) rather than
// LakeLifePayments.refund directly — a mock must not be able to record a
// refund nobody made. The ORDERING invariant these scans hold is unchanged.
describe("refundParkPayment moves money before it records it", () => {
  const body = () => fnBody(code("app/park/ledger-actions.ts"), "refundParkPayment");

  it("asks the processor BEFORE inserting the refund row", () => {
    const fn = body();
    const processor = fn.indexOf("giveRefund(");
    const insert = fn.indexOf('.from("park_refunds")');
    expect(processor, "no processor call — this would file refunds that never happened")
      .toBeGreaterThan(-1);
    expect(insert, "no park_refunds insert found — scan is stale").toBeGreaterThan(-1);
    // Record-first leaves a ledger claiming a household got money it never
    // got, and nobody finds out until they ring. Refund-first leaves money
    // that reached the card and needs filing by hand — recoverable.
    expect(processor, "the refund must reach the card before the row is written")
      .toBeLessThan(insert);
  });

  it("proves the park is yours on the first line", () => {
    const fn = body();
    const park = fn.indexOf("assertMyPark");
    const processor = fn.indexOf("giveRefund(");
    expect(park, "no membership check").toBeGreaterThan(-1);
    expect(park, "membership is checked before any money moves").toBeLessThan(processor);
  });

  it("refuses to move money without an idempotency key", () => {
    const fn = body();
    expect(fn, "no idempotency key guard — a double submit is two refunds")
      .toMatch(/idempotencyKey/);
    const guard = fn.search(/if \(!String\(input\.idempotencyKey/);
    const processor = fn.indexOf("giveRefund(");
    expect(guard, "the key is not checked at all").toBeGreaterThan(-1);
    expect(guard, "an unkeyed refund must be refused before the processor is called")
      .toBeLessThan(processor);
  });

  it("carries that key onto the row, so a replay collides", () => {
    const fn = body();
    expect(fn, "the key must be stored or the unique index cannot catch a twin")
      .toMatch(/idempotency_key:/);
  });

  it("treats the unique-index collision as success, not failure", () => {
    const fn = body();
    // A twin submit already filed this refund. Reporting a failure invites a
    // third attempt against a card that has already been credited.
    expect(fn).toMatch(/23505/);
    const dup = fn.indexOf("23505");
    const okAfter = fn.slice(dup, dup + 260);
    expect(okAfter, "a 23505 must resolve to ok:true").toMatch(/ok: true/);
  });

  it("puts the processor reference in the sentence when filing fails", () => {
    const fn = body();
    // Money left and we could not record it. The reference is the only thread
    // back to it, so it has to reach a person.
    const tail = fn.slice(fn.indexOf("23505"));
    expect(tail, "the failure message must carry done.ref").toMatch(/\$\{done\.ref\}/);
    expect(tail, "and must tell them not to try again").toMatch(/do not refund again/i);
  });

  it("never asks the processor for a refund it has not validated", () => {
    const fn = body();
    const refusal = fn.indexOf("refundAmountRefusal");
    const processor = fn.indexOf("giveRefund(");
    expect(refusal, "the typed amounts are not checked").toBeGreaterThan(-1);
    expect(refusal, "amounts must be validated before money moves").toBeLessThan(processor);
  });
});

describe("refundableOn does not read a failure as nothing-refunded-yet", () => {
  const body = () => fnBody(code("app/park/ledger-actions.ts"), "refundableOn");

  it("checks the error on the refunds read", () => {
    const fn = body();
    const from = fn.indexOf('.from("park_refunds")');
    expect(from, "no refunds read found — scan is stale").toBeGreaterThan(-1);
    // supabase-js resolves a failed read to {data:null,error}, which is
    // indistinguishable from "no refunds yet". Treated as zero it offers the
    // whole payment back a second time.
    expect(fn.slice(from), "a failed refunds read must be caught, not defaulted to []")
      .toMatch(/givenRes\.error/);
  });

  it("returns an error rather than a remaining amount when it could not look", () => {
    const fn = body();
    const guard = fn.indexOf("givenRes.error");
    const ret = fn.indexOf("remainingRefundable");
    expect(guard).toBeGreaterThan(-1);
    expect(ret, "no remaining calculation found — scan is stale").toBeGreaterThan(-1);
    expect(guard, "the guard must come before any arithmetic on what came back")
      .toBeLessThan(ret);
  });
});

describe("reversePayment no longer offers itself for card money", () => {
  const body = () => fnBody(code("app/park/ledger-actions.ts"), "reversePayment");

  it("refuses card and ACH before writing anything", () => {
    const fn = body();
    const guard = fn.search(/pay\.method === "card"/);
    const update = fn.indexOf("reversed_at: new Date()");
    expect(guard, "no card guard — this is the lie 0142 exists to end")
      .toBeGreaterThan(-1);
    expect(update, "no reversal write found — scan is stale").toBeGreaterThan(-1);
    expect(guard, "the refusal must precede the write").toBeLessThan(update);
    expect(fn.slice(guard, guard + 200), "ACH moved real money too").toMatch(/"ach"/);
  });

  it("actually selects the column that guard reads", () => {
    const fn = body();
    // A guard on a field the query never fetched is a guard on `undefined` —
    // the exact "column with no writer" shape, inverted.
    const sel = fn.match(/\.select\("([^"]*park_id[^"]*)"\)/)?.[1] ?? "";
    expect(sel, "reversePayment's select not found — scan is stale").not.toBe("");
    expect(sel, "method must be fetched or the card guard reads undefined")
      .toMatch(/\bmethod\b/);
  });

  it("points the person at the refund instead of just saying no", () => {
    const fn = body();
    const guard = fn.search(/pay\.method === "card"/);
    expect(fn.slice(guard, guard + 400), "a refusal with no next step is a dead end")
      .toMatch(/[Rr]efund it instead/);
  });
});

describe("0142 is on disk, not only in the database", () => {
  it("has a migration file matching what was applied", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/0142_a_refund_that_reaches_the_card.sql"),
      "utf8",
    );
    expect(sql).toMatch(/create table if not exists public\.park_refunds/);
    // The two rules that make the record trustworthy.
    expect(sql, "refunds must be revoked from the client roles").toMatch(
      /revoke insert, update, delete on public\.park_refunds from authenticated, anon/,
    );
    expect(sql, "a refund with no processor reference is a rumour").toMatch(
      /processor_ref\s+text not null/,
    );
    // The balance has to know. Without this the bill still reads PAID.
    expect(sql, "sync must subtract refunds").toMatch(/given_back/);
  });
});
