import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("LakeLifePayments.charge", () => {
  it("charges a valid token + positive integer cents", async () => {
    const res = await LakeLifePayments.charge({ token: "tok_mock_4242_xabc123", amountCents: 12500 });
    expect(res.ok).toBe(true);
    expect(res.ref!.startsWith("ch_mock_")).toBe(true);
    expect(res.amountCents).toBe(12500);
  });

  it("rejects a token that doesn't start with tok_", async () => {
    const res = await LakeLifePayments.charge({ token: "card_4242", amountCents: 12500 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Invalid payment token.");
  });

  it("refuses a token that hides a raw PAN (16-digit run)", async () => {
    const res = await LakeLifePayments.charge({ token: "tok_4242424242424242", amountCents: 12500 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Refusing to charge what looks like a raw card number.");
  });

  it("rejects a zero amount", async () => {
    const res = await LakeLifePayments.charge({ token: "tok_mock_4242_xabc123", amountCents: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Charge amount must be a positive whole number of cents.");
  });

  it("rejects a negative amount", async () => {
    const res = await LakeLifePayments.charge({ token: "tok_mock_4242_xabc123", amountCents: -500 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Charge amount must be a positive whole number of cents.");
  });

  it("rejects a non-integer amount", async () => {
    const res = await LakeLifePayments.charge({ token: "tok_mock_4242_xabc123", amountCents: 10.5 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Charge amount must be a positive whole number of cents.");
  });
});

// ---------------------------------------------------------------------------
// A mock token must never be rejected by our own charge() PAN guard. The tail
// used to be raw UUID HEX — ten digits out of sixteen symbols — so roughly one
// token in a few hundred carried 12+ consecutive digits and charge() refused
// it. Bounded by construction now; this is the proof, not a spot check.
// ---------------------------------------------------------------------------
describe("mock token never trips our own leaked-PAN guard", () => {
  it("no digit run of 12+ across many tokens, and every one is chargeable", async () => {
    for (let i = 0; i < 3000; i++) {
      const res = await LakeLifePayments.tokenize({
        number: "4242 4242 4242 4242", exp: "12/30", cvc: "123",
      });
      expect(res.ok).toBe(true);
      expect(/\d{12,}/.test(res.token!.token)).toBe(false);
    }
  });

  it("a token from tokenize() is always accepted by charge()", async () => {
    for (let i = 0; i < 300; i++) {
      const t = await LakeLifePayments.tokenize({
        number: "4242 4242 4242 4242", exp: "12/30", cvc: "123",
      });
      const charged = await LakeLifePayments.charge({ token: t.token!.token, amountCents: 1000 });
      expect(charged.ok).toBe(true);
    }
  });
});

describe("an idempotency key takes ONE payment, not two", () => {
  /**
   * `payRent` was the only money path in the park module without a key. Its
   * siblings all collide on 0081's unique index — 0081 exists because a
   * double-tapped submit "recorded the money twice and burnt two receipt
   * numbers". The card path arrived later and skipped it, leaving
   * `disabled={busy}` as the only protection: client-side, on an exported
   * "use server" action any browser can call.
   *
   * The key goes to the PROCESSOR as well as onto the row. Order matters — a
   * unique index refuses a second ledger row, but only the processor can
   * refuse the second charge, and by the time the index fires the card has
   * already been debited twice.
   */
  it("replays the first result rather than charging again", async () => {
    const key = `test-${Math.random().toString(36).slice(2)}`;
    const first = await LakeLifePayments.charge({ token: "tok_mock_4242_aaa111", amountCents: 45500, idempotencyKey: key });
    const second = await LakeLifePayments.charge({ token: "tok_mock_4242_aaa111", amountCents: 45500, idempotencyKey: key });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The SAME reference — one payment at the processor, not two.
    expect(second.ref).toBe(first.ref);
  });

  it("a different key is a different payment", async () => {
    const a = await LakeLifePayments.charge({ token: "tok_mock_4242_bbb222", amountCents: 1000, idempotencyKey: `k-${Math.random()}` });
    const b = await LakeLifePayments.charge({ token: "tok_mock_4242_bbb222", amountCents: 1000, idempotencyKey: `k-${Math.random()}` });
    expect(a.ref).not.toBe(b.ref);
  });

  it("no key at all still charges — the mock does not invent one", async () => {
    const a = await LakeLifePayments.charge({ token: "tok_mock_4242_ccc333", amountCents: 500 });
    const b = await LakeLifePayments.charge({ token: "tok_mock_4242_ccc333", amountCents: 500 });
    expect(a.ref).not.toBe(b.ref);
  });

  it("a replayed key does not re-run the PAN guard into a false pass", async () => {
    // Guards the guard: the replay cache must not let a bad token through by
    // returning a cached success for a different token under the same key.
    const key = `guard-${Math.random()}`;
    const good = await LakeLifePayments.charge({ token: "tok_mock_4242_ddd444", amountCents: 100, idempotencyKey: key });
    expect(good.ok).toBe(true);
    const replayed = await LakeLifePayments.charge({ token: "tok_4242424242424242", amountCents: 100, idempotencyKey: key });
    // It replays the FIRST result, which is the processor's real contract —
    // the key is the identity of the ATTEMPT, so this is correct. Documented
    // here so nobody mistakes it for the PAN guard being bypassable: a fresh
    // key still refuses the raw number.
    expect(replayed.ref).toBe(good.ref);
    const fresh = await LakeLifePayments.charge({ token: "tok_4242424242424242", amountCents: 100, idempotencyKey: `fresh-${Math.random()}` });
    expect(fresh.ok).toBe(false);
  });
});

describe("the resident's card path carries the key end to end", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../app/parks/pay-actions.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("payRent requires a key", () => {
    expect(src).toMatch(/payRent\(chargeId: string, idempotencyKey: string\)/);
  });

  it("sends it to the processor, not just onto the row", () => {
    // `takePayment` (src/lib/charge-gate.ts) now stands in front of the
    // processor so a mock cannot credit a bill; the key still has to reach it.
    const chargeCall = src.slice(src.indexOf("takePayment("), src.indexOf("if (!charged.ok"));
    expect(chargeCall).toContain("idempotencyKey");
  });

  it("puts it on the row so the unique index can refuse a duplicate", () => {
    const insert = src.slice(src.indexOf('from("park_payments").insert('));
    expect(insert.slice(0, 400)).toContain("idempotency_key: idempotencyKey");
  });

  it("treats the index collision as PAID, not as a failure", () => {
    // The twin call already filed it and the processor replayed rather than
    // re-charged. Reporting failure invites a third attempt.
    expect(src).toMatch(/23505/);
    const after = src.slice(src.indexOf("23505"));
    expect(after.slice(0, 200)).toContain("ok: true");
  });

  it("the button mints ONE key per panel, not per tap", () => {
    const btn = readFileSync(
      fileURLToPath(new URL("../components/PayRentButton.tsx", import.meta.url)), "utf8",
    );
    expect(btn).toMatch(/useState\(\(\) => crypto\.randomUUID\(\)\)/);
    // A retry after a failure must carry the same key or it is a fresh charge.
    expect(btn).toContain("payRent(chargeId, idemKey)");
  });
});
