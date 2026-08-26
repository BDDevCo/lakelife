import { describe, it, expect } from "vitest";
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

  it("refuses when it has all already gone back", () => {
    expect(refundRefusal(CARD, { amount: 0, fee: 12 })).toMatch(/already gone back/);
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

  it("refuses zero and negative amounts", () => {
    expect(refundAmountRefusal(0, 0, left)).toMatch(/how much/);
    expect(refundAmountRefusal(-5, 0, left)).toMatch(/how much/);
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
});
