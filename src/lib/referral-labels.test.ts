import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TWO NUMBERS ABOUT THE SAME MONEY, NEITHER LABELLED.
 *
 * Found walking the season as a seasonal homeowner. /book said "You've earned
 * $150.00 so far"; /billing showed a $50.00 credit balance. Both true:
 * earnedTotal is LIFETIME, every non-void accrual including credits already
 * spent, and the balance is what is left. Nothing on either screen said which
 * was which, so the pair read as a discrepancy in the customer's own money.
 *
 * The crew's card had it right all along — "$X earned · $Y maturing · $Z ready
 * for your next payout batch", every figure named. This brings the customer's
 * up to it.
 *
 * And `available` means DIFFERENT MONEY for the two: spendable credit for a
 * homeowner, a matured payout awaiting a bank batch for a crew. That was a
 * comment on the interface; a crew who also owns a lake house sees the
 * customer card, where it would have been captioned "left to spend on your
 * bills". Now the ticker says which it is.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the ticker", () => {
  it("says which kind of money `available` is", () => {
    const s = src("./referral-data.ts");
    expect(s).toMatch(/isCrew: boolean/);
    expect(s).toMatch(/isCrew: !!vendorRow/);
  });

  it("still sums lifetime earnings, spent or not", () => {
    // earnedTotal is deliberately lifetime — the fix is the label, not the sum.
    const s = src("./referral-data.ts");
    expect(s).toMatch(/earnedTotal \+= a;/);
    expect(s).toMatch(/lifetime, all non-void accruals/);
  });
});

describe("the customer's card", () => {
  const card = () => src("../components/ShareLakeLife.tsx");

  it("names what is left, not just what was earned", () => {
    const s = card();
    expect(s).toMatch(/earned so far/);
    expect(s).toMatch(/left to spend on your bills/);
  });

  it("shows maturing money rather than hiding it", () => {
    // Not spendable, and not nothing either.
    expect(card()).toMatch(/still maturing/);
  });

  it("captions a crew's payout as a payout, not as credit", () => {
    const s = card();
    expect(s).toMatch(/availableIsPayout \? "ready for your next payout batch" : "left to spend on your bills"/);
  });

  it("and the one screen using it passes all three", () => {
    const s = src("../app/book/page.tsx");
    for (const prop of ["earnedToDate=", "creditAvailable=", "maturing=", "availableIsPayout="]) {
      expect(s, `ShareLakeLife is missing ${prop}`).toContain(prop);
    }
  });
});

describe("the crew's card still names its three", () => {
  it("earned, maturing, ready", () => {
    const s = src("../app/vendor/earnings/page.tsx");
    expect(s).toMatch(/earned/);
    expect(s).toMatch(/maturing/);
    expect(s).toMatch(/ready for your next payout batch/);
  });
});
