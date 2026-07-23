import { describe, it, expect } from "vitest";
import { abaValid, accountPlausible, earlyFee } from "./payouts";

describe("abaValid — the checksum keeps typos out of the vault", () => {
  it("accepts real routing numbers", () => {
    expect(abaValid("011000015")).toBe(true); // Federal Reserve Boston
    expect(abaValid("021000021")).toBe(true); // JPMorgan Chase
  });
  it("rejects transposed digits and garbage", () => {
    expect(abaValid("011000051")).toBe(false);
    expect(abaValid("123456789")).toBe(false);
    expect(abaValid("00000000")).toBe(false);
    expect(abaValid("000000000")).toBe(false); // sum 0 is not a bank
  });
});

describe("earlyFee — 2% now beats waiting for month-end", () => {
  it("the GreenEdge example: $1,432 early costs $28.64, lands $1,403.36", () => {
    expect(earlyFee(1432, 0.02)).toEqual({ fee: 28.64, net: 1403.36 });
  });
  it("cents round instead of drifting", () => {
    expect(earlyFee(33.33, 0.02)).toEqual({ fee: 0.67, net: 32.66 });
  });
  it("zero fee dial = full net (month-end path)", () => {
    expect(earlyFee(500, 0)).toEqual({ fee: 0, net: 500 });
  });
});

describe("accountPlausible", () => {
  it("4–17 digits only", () => {
    expect(accountPlausible("1234")).toBe(true);
    expect(accountPlausible("12345678901234567")).toBe(true);
    expect(accountPlausible("123")).toBe(false);
    expect(accountPlausible("12a4")).toBe(false);
  });
});
