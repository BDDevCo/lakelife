import { describe, it, expect } from "vitest";
import { withinSunset, customerReferralAccrual, crewShareAccrual, creditToApply } from "./referrals";

const NOW = Date.parse("2026-07-23T12:00:00Z");

describe("withinSunset — customer-spend arms stop after a year", () => {
  it("inside and outside the window", () => {
    expect(withinSunset("2026-01-01T00:00:00Z", NOW, 365)).toBe(true);
    expect(withinSunset("2025-07-01T00:00:00Z", NOW, 365)).toBe(false);
  });
  it("null/garbage attribution never accrues", () => {
    expect(withinSunset(null, NOW, 365)).toBe(false);
    expect(withinSunset("not-a-date", NOW, 365)).toBe(false);
  });
});

describe("customerReferralAccrual — % of collected spend", () => {
  it("5% of the collected price, to cents", () => {
    expect(customerReferralAccrual(85, 0.05)).toBe(4.25);
    expect(customerReferralAccrual(495, 0.05)).toBe(24.75);
  });
  it("degenerate inputs accrue nothing; pct is safety-clamped", () => {
    expect(customerReferralAccrual(0, 0.05)).toBe(0);
    expect(customerReferralAccrual(85, 0)).toBe(0);
    expect(customerReferralAccrual(100, 0.9)).toBe(50); // clamp at 50% — a fat-fingered dial can't give the store away
  });
});

describe("crewShareAccrual — self-financing, hard-capped (the landscaper test)", () => {
  it("takes the share of margin while under the cap", () => {
    expect(crewShareAccrual(120, 0.25, 250, 0)).toBe(30); // $40-lawn landscaper: $30, not $250
    expect(crewShareAccrual(500, 0.25, 250, 0)).toBe(125);
  });
  it("never exceeds the remaining cap room", () => {
    expect(crewShareAccrual(1000, 0.25, 250, 200)).toBe(50); // room = 50 < 250 share
    expect(crewShareAccrual(1000, 0.25, 250, 250)).toBe(0); // capped out forever
    expect(crewShareAccrual(1000, 0.25, 250, 400)).toBe(0); // over-accrued edge: still 0
  });
  it("nothing on zero/negative margin (never pay on money we didn't make)", () => {
    expect(crewShareAccrual(0, 0.25, 250, 0)).toBe(0);
    expect(crewShareAccrual(-50, 0.25, 250, 0)).toBe(0);
  });
});

describe("creditToApply — never more than the bill, never negative", () => {
  it("applies the smaller of balance and price", () => {
    expect(creditToApply(30, 85)).toBe(30);
    expect(creditToApply(200, 85)).toBe(85);
    expect(creditToApply(84.999, 85)).toBe(85); // cents rounding
  });
  it("zero/negative balances apply nothing", () => {
    expect(creditToApply(0, 85)).toBe(0);
    expect(creditToApply(-10, 85)).toBe(0);
  });
});
