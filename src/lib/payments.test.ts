import { describe, it, expect } from "vitest";
import { detectBrand, luhnValid, LakeLifePayments } from "./payments";

describe("card brand detection", () => {
  it("Visa starts with 4", () => expect(detectBrand("4242424242424242")).toBe("Visa"));
  it("Mastercard", () => expect(detectBrand("5555555555554444")).toBe("Mastercard"));
  it("Amex", () => expect(detectBrand("378282246310005")).toBe("Amex"));
  it("Discover", () => expect(detectBrand("6011111111111117")).toBe("Discover"));
});

describe("Luhn validity", () => {
  it("accepts a valid test card", () => expect(luhnValid("4242424242424242")).toBe(true));
  it("rejects a bad number", () => expect(luhnValid("4242424242424241")).toBe(false));
  it("rejects non-digits / short", () => expect(luhnValid("1234")).toBe(false));
});

describe("tokenize (mock) — never returns the raw card number", () => {
  it("returns a token + safe display details, and no full PAN", async () => {
    const res = await LakeLifePayments.tokenize({
      number: "4242 4242 4242 4242",
      exp: "12/28",
      cvc: "123",
    });
    expect(res.ok).toBe(true);
    expect(res.token!.brand).toBe("Visa");
    expect(res.token!.last4).toBe("4242");
    expect(res.token!.exp_month).toBe(12);
    expect(res.token!.exp_year).toBe(2028);
    // the token must not contain the full card number
    expect(res.token!.token).not.toContain("4242424242424242");
    // ...and beyond the "tok_mock_4242_" head, no long digit run that could
    // ever be mistaken for (or hide) a PAN by the server-side guard
    const tail = res.token!.token.replace(/^tok_[a-z0-9]+_\d{4}_/, "");
    expect(/\d{13,19}/.test(tail)).toBe(false);
  });

  it("rejects an invalid card number", async () => {
    const res = await LakeLifePayments.tokenize({ number: "1234 5678", exp: "12/28", cvc: "123" });
    expect(res.ok).toBe(false);
  });

  it("rejects a bad expiry", async () => {
    const res = await LakeLifePayments.tokenize({ number: "4242424242424242", exp: "13/28", cvc: "123" });
    expect(res.ok).toBe(false);
  });
});
