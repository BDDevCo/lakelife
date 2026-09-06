import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  remainingRefundable,
  refundRefusal,
  refundAmountRefusal,
  refundCents,
  refundSignal,
  type RefundablePayment,
} from "./refund-helpers";

/** A card payment of $400 rent with a $12 surcharge on top. */
const CARD: RefundablePayment = {
  amount: 400,
  fee_amount: 12,
  method: "card",
  reference: "ch_mock_abc",
  reversed_at: null,
};

describe("what is still refundable", () => {
  it("is the whole payment when nothing has gone back", () => {
    expect(remainingRefundable(CARD, [])).toEqual({ amount: 400, fee: 12 });
  });

  it("subtracts the refunds actually recorded", () => {
    expect(remainingRefundable(CARD, [{ amount: 142.53, fee_amount: 0 }]))
      .toEqual({ amount: 257.47, fee: 12 });
  });

  it("subtracts several partials", () => {
    const left = remainingRefundable(CARD, [
      { amount: 142.53, fee_amount: 4 },
      { amount: 57.47, fee_amount: 0 },
      { amount: 100, fee_amount: 8 },
    ]);
    expect(left).toEqual({ amount: 100, fee: 0 });
  });

  it("does not drift on repeated cent arithmetic", () => {
    // Three thirds of a dollar amount that does not divide cleanly. Done in
    // floats without rounding this leaves a fraction of a cent behind, and the
    // screen then offers a refund of $0.0000000001.
    const p = { ...CARD, amount: 100, fee_amount: null };
    const left = remainingRefundable(p, [
      { amount: 33.33, fee_amount: null },
      { amount: 33.33, fee_amount: null },
      { amount: 33.34, fee_amount: null },
    ]);
    expect(left.amount).toBe(0);
  });

  it("treats a missing fee as no fee rather than NaN", () => {
    const p = { ...CARD, fee_amount: null };
    expect(remainingRefundable(p, [{ amount: 1, fee_amount: null }]))
      .toEqual({ amount: 399, fee: 0 });
  });

  it("never reports a negative remaining", () => {
    // Should be unreachable — 0142 refuses refunds beyond the payment — but if
    // bad data ever produced one it must not read as money owed to the park.
    expect(remainingRefundable(CARD, [{ amount: 500, fee_amount: 50 }]))
      .toEqual({ amount: 0, fee: 0 });
  });
});

describe("why a payment cannot be refunded", () => {
  it("says nothing when it can", () => {
    expect(refundRefusal(CARD, { amount: 400, fee: 12 })).toBeNull();
  });

  it("refuses a reversed payment, and says so before anything else", () => {
    // A reversed CASH payment trips two rules. The reversal is the more
    // specific truth and must be the one the person reads.
    const p = { ...CARD, method: "cash", reversed_at: "2026-08-01T00:00:00Z" };
    expect(refundRefusal(p, { amount: 400, fee: 0 })).toMatch(/never having arrived/);
  });

  it("refuses cash and cheques, naming the method", () => {
    const p = { ...CARD, method: "check", reference: null };
    expect(refundRefusal(p, { amount: 400, fee: 0 })).toMatch(/paid by check/);
  });

  it("allows ACH, not just card", () => {
    const p = { ...CARD, method: "ach", fee_amount: null };
    expect(refundRefusal(p, { amount: 400, fee: 0 })).toBeNull();
  });

  it("refuses a card payment with no processor reference", () => {
    const p = { ...CARD, reference: "   " };
    expect(refundRefusal(p, { amount: 400, fee: 12 })).toMatch(/no processor reference/);
  });

  it("refuses only when BOTH the rent and the fee have gone back", () => {
    expect(refundRefusal(CARD, { amount: 0, fee: 0 })).toMatch(/already gone back/);
  });

  it("still allows a refund when only the RENT is exhausted", () => {
    // The surcharge is separate money charged on top. A household surcharged
    // in error whose rent has already gone back must still be made whole.
    expect(refundRefusal(CARD, { amount: 0, fee: 12 })).toBeNull();
  });

  it("refuses a payment the bank took back, before anything else", () => {
    // A return is not a refund. The money never settled, so sending it back
    // would send it out a second time.
    const p = { ...CARD, returned_at: "2026-09-04T00:00:00Z" };
    expect(refundRefusal(p, { amount: 400, fee: 12 })).toMatch(/never settled/);
  });

  it("still allows a refund when only the FEE is exhausted", () => {
    // The rent and the surcharge are separate money. Having returned all the
    // fee must not close the door on returning rent.
    expect(refundRefusal(CARD, { amount: 257.47, fee: 0 })).toBeNull();
  });
});

describe("whether these particular numbers are allowed", () => {
  const left = { amount: 257.47, fee: 12 };

  it("accepts a refund inside what is left", () => {
    expect(refundAmountRefusal(100, 0, left)).toBeNull();
  });

  it("accepts exactly what is left", () => {
    expect(refundAmountRefusal(257.47, 12, left)).toBeNull();
  });

  it("refuses a penny more than is left, and says the ceiling", () => {
    expect(refundAmountRefusal(257.48, 0, left)).toMatch(/at most \$257\.47/);
  });

  it("refuses zero and negative amounts when nothing else is going back", () => {
    expect(refundAmountRefusal(0, 0, left)).toMatch(/how much/);
    expect(refundAmountRefusal(-5, 0, left)).toMatch(/how much/);
  });

  it("lets the card surcharge go back on its own", () => {
    // THE WRONGLY SURCHARGED HOUSEHOLD. Network rules forbid surcharging a
    // debit card, so the fee is the part that has to come back by itself —
    // and a refund of $0.00 rent plus $12.00 of fee is a real refund.
    expect(refundAmountRefusal(0, 12, left)).toBeNull();
    expect(refundAmountRefusal(0, 12, { amount: 0, fee: 12 })).toBeNull();
  });

  it("still refuses a negative rent, whatever the fee", () => {
    expect(refundAmountRefusal(-5, 12, left)).toMatch(/how much/);
  });

  it("refuses more fee than is left even when the rent is zero", () => {
    expect(refundAmountRefusal(0, 12.01, left)).toMatch(/Only \$12\.00 of card fee/);
  });

  it("refuses a non-number rather than sending NaN to the processor", () => {
    expect(refundAmountRefusal(Number.NaN, 0, left)).toMatch(/how much/);
    expect(refundAmountRefusal(10, Number.NaN, left)).toMatch(/has to be a number/);
  });

  it("refuses more fee than was charged", () => {
    expect(refundAmountRefusal(10, 12.01, left)).toMatch(/Only \$12\.00 of card fee/);
  });

  it("says there was no fee at all rather than offering $0.00 of one", () => {
    expect(refundAmountRefusal(10, 1, { amount: 400, fee: 0 }))
      .toMatch(/No card fee was charged/);
  });
});

describe("what the processor is asked for", () => {
  it("asks for rent and surcharge as one refund, in whole cents", () => {
    // They left the card as a single charge, so they come back as one refund.
    expect(refundCents(400, 12)).toBe(41200);
  });

  it("does not emit a fractional cent", () => {
    expect(Number.isInteger(refundCents(33.33, 0.01))).toBe(true);
    expect(refundCents(0.1, 0.2)).toBe(30);
  });

  it("asks for the fee alone when only the fee is going back", () => {
    // Not zero. A processor asked for $0.00 either declines or, worse,
    // succeeds — and then a refund row exists for money that never moved.
    expect(refundCents(0, 12)).toBe(1200);
  });
});

describe("what the office is told", () => {
  it("mentions the fee only when some went back", () => {
    expect(refundSignal(400, 0, true)).not.toMatch(/card fee/);
    expect(refundSignal(400, 12, true)).toMatch(/plus \$12\.00 of card fee/);
  });

  it("only claims a bill reopened when there is a bill", () => {
    // Money with no charge has no balance to become outstanding again. Saying
    // it does sends somebody looking for a number that never moved.
    expect(refundSignal(50, 0, false)).not.toMatch(/outstanding/);
    expect(refundSignal(50, 0, true)).toMatch(/outstanding again/);
  });

  it("does not announce $0.00 of rent when only the fee went back", () => {
    // "$0.00 plus $12.00 of card fee sent back" reads as a bug to the person
    // who just pressed the button, and it is the sentence they will quote
    // back to the household.
    const s = refundSignal(0, 12, true);
    expect(s).not.toMatch(/\$0\.00/);
    expect(s).toMatch(/\$12\.00 card fee/);
  });
});

/**
 * THE MIGRATION HAS TO EXIST ON DISK, AND HAS TO SAY THESE THINGS.
 *
 * The helpers above decide what the office is allowed to type. The database
 * decides what is allowed to be TRUE, and four of these rules live only there
 * — no unit test can reach them. Scanning the file is how they stay reviewed.
 */
describe("0155 is on disk, not only in somebody's head", () => {
  // Read per-test, not once in the describe body: a missing file thrown during
  // collection takes the whole suite down with one unreadable error, and this
  // file's other 30 assertions are about the helpers, not the migration.
  const sql = () =>
    readFileSync(
      join(process.cwd(), "supabase/migrations/0155_a_return_is_not_a_refund.sql"),
      "utf8",
    );

  it("relaxes the refund ceiling so a fee can go back alone", () => {
    // 0142 shipped `check ((amount > (0)::numeric))`, verified on production
    // before this was written. A fee-only refund has amount 0 and would be
    // refused by the database even once the app allows it.
    expect(sql()).toMatch(/amount >= 0/);
    expect(sql()).toMatch(/amount \+ fee_amount > 0/);
    expect(sql(), "the old > 0 check has to be dropped, not merely added to")
      .toMatch(/drop constraint if exists park_refunds_amount_check/);
  });

  it("gives a bank return its own columns, separate from a deposit return", () => {
    expect(sql()).toMatch(/add column if not exists returned_at/);
    expect(sql()).toMatch(/add column if not exists return_code/);
  });

  it("stops a returned payment counting toward a bill", () => {
    const fn = sql().match(/create or replace function public\.recompute_charge_paid[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(fn.length, "recompute_charge_paid is not in this migration").toBeGreaterThan(400);
    expect(fn).toMatch(/p\.returned_at is null/);
  });

  it("refuses a refund against a payment the bank took back", () => {
    const fn = sql().match(/create or replace function public\.guard_park_refund[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(fn.length, "guard_park_refund is not in this migration").toBeGreaterThan(400);
    expect(fn).toMatch(/pay\.returned_at is not null/);
  });

  it("leaves no client role able to stamp a return by hand", () => {
    // returned_at reduces a bill's paid_total. A resident who could write it
    // could erase their own rent.
    expect(sql()).toMatch(/has_table_privilege\('authenticated', 'public\.park_payments', 'UPDATE'\)/);
  });
});
