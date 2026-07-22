import { describe, it, expect } from "vitest";
import { rushPrice, fillInRate, rushWindowOpen, validRushFallback, RUSH_OPEN_HOUR } from "./rush";

describe("rushPrice — customer premium, whole dollars up", () => {
  it("adds the surcharge and rounds up", () => {
    expect(rushPrice(85, 0.25)).toBe(107); // 106.25 → 107
    expect(rushPrice(100, 0.25)).toBe(125);
    expect(rushPrice(495, 0.25)).toBe(619); // 618.75 → 619
  });
  it("0% surcharge = menu price", () => {
    expect(rushPrice(85, 0)).toBe(85);
  });
  it("degenerate inputs never price", () => {
    expect(rushPrice(0, 0.25)).toBe(0);
    expect(rushPrice(-10, 0.25)).toBe(0);
    expect(rushPrice(85, -1)).toBe(85); // negative surcharge clamps to 0
  });
});

describe("fillInRate — crew's discounted take-home, to cents", () => {
  it("applies the fill-in discount", () => {
    expect(fillInRate(59, 0.15)).toBe(50.15);
    expect(fillInRate(100, 0.15)).toBe(85);
  });
  it("clamps the discount to a sane band (never below half their rate)", () => {
    expect(fillInRate(100, 0.9)).toBe(50);
    expect(fillInRate(100, -0.2)).toBe(100);
  });
  it("no rate → no fill-in", () => {
    expect(fillInRate(0, 0.15)).toBe(0);
  });
});

describe("rushWindowOpen — 6am to the cutoff, lake time", () => {
  it("open mid-morning, closed at/after the cutoff", () => {
    expect(rushWindowOpen(9, 14)).toBe(true);
    expect(rushWindowOpen(13, 14)).toBe(true);
    expect(rushWindowOpen(14, 14)).toBe(false);
    expect(rushWindowOpen(17, 14)).toBe(false);
  });
  it("closed before the open hour (no 3am blasts)", () => {
    expect(rushWindowOpen(2, 14)).toBe(false);
    expect(rushWindowOpen(RUSH_OPEN_HOUR, 14)).toBe(true); // opens exactly at 6
  });
});

describe("validRushFallback", () => {
  it("defaults anything unexpected to the gentler 'roll'", () => {
    expect(validRushFallback("cancel")).toBe("cancel");
    expect(validRushFallback("roll")).toBe("roll");
    expect(validRushFallback("delete-everything")).toBe("roll");
    expect(validRushFallback(undefined)).toBe("roll");
  });
});
