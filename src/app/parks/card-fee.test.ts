import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normaliseFunding,
  mayBeSurcharged,
  surchargePct,
  cardFeeCents,
  CARD_FUNDINGS,
} from "./card-fee";

/**
 * A DEBIT CARD IS NOT A CREDIT CARD.
 *
 * The Haven has `card_fee_pct = 3.00` and `accepts_online_rent = true` in
 * production. Network rules forbid surcharging a DEBIT card at any rate in
 * every state (docs/processor-questions.md), and `payment_methods` recorded a
 * brand but never a funding type — so the day the processor switch flips,
 * every rent payment on a debit card is a rule violation.
 *
 * The dial is his and stays at 3%. What changes is WHICH cards it reaches.
 * A wrong surcharge is a violation; a missing one is lost margin, so anything
 * we cannot positively identify as credit surcharges nothing.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments would satisfy every scan below on their own. Strip them first. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("only a credit card may be surcharged", () => {
  it("names all four funding types the column can hold", () => {
    expect([...CARD_FUNDINGS].sort()).toEqual(["credit", "debit", "prepaid", "unknown"]);
  });

  it("surcharges credit at the park's own rate", () => {
    expect(surchargePct(3, "credit")).toBe(3);
    expect(mayBeSurcharged("credit")).toBe(true);
  });

  it("surcharges debit at ZERO — the network rule this whole file exists for", () => {
    expect(surchargePct(3, "debit")).toBe(0);
    expect(mayBeSurcharged("debit")).toBe(false);
  });

  it("surcharges prepaid at ZERO", () => {
    expect(surchargePct(3, "prepaid")).toBe(0);
    expect(mayBeSurcharged("prepaid")).toBe(false);
  });

  it("surcharges unknown at ZERO — the column has no writer until the SDK lands", () => {
    expect(surchargePct(3, "unknown")).toBe(0);
    expect(mayBeSurcharged("unknown")).toBe(false);
  });

  it("treats a null, a blank and a word nobody defined as unknown, not as credit", () => {
    for (const junk of [null, undefined, "", "  ", "CREDIT_CARD", "visa", 7, {}]) {
      expect(normaliseFunding(junk)).toBe("unknown");
      expect(surchargePct(3, junk)).toBe(0);
    }
  });

  it("reads the funding type however the processor cased it", () => {
    expect(normaliseFunding(" Credit ")).toBe("credit");
    expect(surchargePct(3, "CREDIT")).toBe(3);
  });

  it("charges nothing extra when the park set no fee, whatever the card is", () => {
    expect(surchargePct(0, "credit")).toBe(0);
    expect(surchargePct(null, "credit")).toBe(0);
    expect(surchargePct("not a number", "credit")).toBe(0);
    expect(surchargePct(-1, "credit")).toBe(0);
  });
});

describe("the fee is whole cents, rounded once", () => {
  it("adds 3% of The Haven's own rent, to the cent", () => {
    // $542.53 rent → $16.28 fee → $558.81 taken.
    expect(cardFeeCents(54253, 3)).toBe(1628);
    expect(54253 + cardFeeCents(54253, 3)).toBe(55881);
  });

  it("never returns a fraction of a cent onto the wire", () => {
    for (const cents of [1, 7, 99, 100, 1234, 54253, 999999]) {
      expect(Number.isInteger(cardFeeCents(cents, 3))).toBe(true);
      expect(Number.isInteger(cardFeeCents(cents, 2.5))).toBe(true);
    }
  });

  it("is zero for a zero rate, a zero balance or a nonsense one", () => {
    expect(cardFeeCents(54253, 0)).toBe(0);
    expect(cardFeeCents(0, 3)).toBe(0);
    expect(cardFeeCents(-100, 3)).toBe(0);
    expect(cardFeeCents(100.5, 3)).toBe(0);
  });
});

/**
 * THE RULE IN ONE DOORWAY OF THREE is this repo's most expensive defect. The
 * fee is resolved in two places — the screen that discloses it and the action
 * that charges it — and they must resolve it the SAME way, or the resident is
 * quoted one number and billed another.
 */
describe("every door that prices a card goes through the one gate", () => {
  it("payRent reads the card's funding type and prices through surchargePct", () => {
    const s = code("./pay-actions.ts");
    expect(s, "the card read must fetch funding").toMatch(/from\("payment_methods"\)[\s\S]{0,120}funding/);
    expect(s, "and the rate must come from the gate").toMatch(/surchargePct\(/);
    expect(s, "never straight off the park row").not.toMatch(/Number\(park\.card_fee_pct/);
  });

  it("the resident's screen discloses the SAME resolved rate", () => {
    const s = code("./my-data.ts");
    expect(s, "the card read must fetch funding").toMatch(/from\("payment_methods"\)[\s\S]{0,160}funding/);
    expect(s, "and the disclosed rate must come from the gate").toMatch(/surchargePct\(/);
    expect(s, "never straight off the park row").not.toMatch(/Number\(park\?\.card_fee_pct/);
  });

  it("both doors pick the same card — the default one", () => {
    // payRent charges `.order("is_default", …).limit(1)`. If the screen priced
    // a different card, the confirm panel would quote a fee the charge never
    // uses. Same order, same limit, both sides.
    for (const f of ["./pay-actions.ts", "./my-data.ts"]) {
      const s = code(f);
      const at = s.indexOf('from("payment_methods")');
      expect(at, `${f} must still read payment_methods`).toBeGreaterThan(-1);
      expect(s.slice(at, at + 260)).toMatch(/order\("is_default", \{ ascending: false \}\)/);
    }
  });
});

describe("the resident sees the fee before they commit", () => {
  // Stripped, because the comment recording the removed sentence quotes it.
  const btn = code("../../components/PayRentButton.tsx");

  it("states the absence of a fee too, not only its presence", () => {
    // "Whatever the fee resolves to, including zero, it is on screen before
    // the button is pressed." A silent zero is indistinguishable from a fee
    // nobody mentioned.
    const confirm = btn.slice(btn.indexOf("confirming ?"));
    expect(confirm).toMatch(/No card fee/i);
    expect(confirm, "the zero case must not be hidden behind fee > 0")
      .not.toMatch(/\{fee > 0 && \(/);
  });

  it("does not promise a bank-transfer rail that does not exist", () => {
    // PayRentButton offered "Paying by bank transfer costs nothing extra".
    // There is no ACH tender path anywhere — payRent hard-codes method 'card'
    // — so that sentence sent a resident looking for a button nobody built.
    expect(btn).not.toMatch(/bank transfer/i);
    expect(btn, "say the thing that is actually true today").toMatch(/office/i);
  });
});
