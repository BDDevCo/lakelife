import { describe, it, expect } from "vitest";
import { seasonEndFor, overstayDays, perdiemCharge, trueLegsToQuote } from "./storage";

describe("seasonEndFor — the season end rolls to the year AFTER intake", () => {
  it("October intake ends the following May 31", () => {
    expect(seasonEndFor("2026-10-15", 5, 31)).toBe("2027-05-31");
  });
  it("an early-year intake before the end date ends the SAME year", () => {
    expect(seasonEndFor("2027-02-10", 5, 31)).toBe("2027-05-31");
  });
  it("intake exactly on the end date counts as that season", () => {
    expect(seasonEndFor("2027-05-31", 5, 31)).toBe("2027-05-31");
  });
  it("dial garbage clamps instead of crashing", () => {
    expect(seasonEndFor("2026-10-01", 15, 40)).toBe("2026-12-31");
  });
});

describe("overstayDays + perdiemCharge — the polite meter", () => {
  it("out on time (or early) costs nothing", () => {
    expect(overstayDays("2027-05-20", "2027-05-31")).toBe(0);
    expect(overstayDays("2027-05-31", "2027-05-31")).toBe(0);
  });
  it("ten days late is ten days, across the month boundary", () => {
    expect(overstayDays("2027-06-10", "2027-05-31")).toBe(10);
  });
  it("$10/day dial → $100 for ten days", () => {
    expect(perdiemCharge(10, 10)).toBe(100);
  });
  it("zero/garbage never charges", () => {
    expect(perdiemCharge(0, 10)).toBe(0);
    expect(perdiemCharge(5, 0)).toBe(0);
    expect(perdiemCharge(-3, 10)).toBe(0);
  });
});

describe("trueLegsToQuote — the booking promise wins, no leg goes negative", () => {
  it("unchanged when the sum already matches", () => {
    expect(trueLegsToQuote([{ id: "a", price: 198 }, { id: "b", price: 285 }], 483))
      .toEqual([{ id: "a", price: 198 }, { id: "b", price: 285 }]);
  });
  it("scales proportionally when dials moved, summing exactly to the quote", () => {
    const out = trueLegsToQuote([{ id: "a", price: 400 }, { id: "b", price: 150 }], 483);
    expect(out.reduce((t, l) => t + l.price, 0)).toBe(483);
    expect(out.every((l) => l.price >= 0)).toBe(true);
  });
  it("a quote far below the recomputed sum never yields a negative leg", () => {
    const out = trueLegsToQuote([{ id: "dew", price: 400 }, { id: "ret", price: 150 }], 100);
    expect(out.reduce((t, l) => t + l.price, 0)).toBe(100);
    expect(out.every((l) => l.price >= 0)).toBe(true);
  });
  it("zero-priced recompute puts the quote on one leg, not NaN everywhere", () => {
    const out = trueLegsToQuote([{ id: "a", price: 0 }, { id: "b", price: 0 }], 250);
    expect(out.reduce((t, l) => t + l.price, 0)).toBe(250);
  });
});
