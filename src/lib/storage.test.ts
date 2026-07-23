import { describe, it, expect } from "vitest";
import { seasonEndFor, overstayDays, perdiemCharge } from "./storage";

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
