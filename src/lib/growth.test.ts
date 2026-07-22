import { describe, it, expect } from "vitest";
import { isLastDayOfMonth, nudgeCooling } from "./growth";

describe("isLastDayOfMonth — the month-end batch trigger", () => {
  it("true only on the last day, incl. leap February", () => {
    expect(isLastDayOfMonth("2026-07-31")).toBe(true);
    expect(isLastDayOfMonth("2026-07-30")).toBe(false);
    expect(isLastDayOfMonth("2026-02-28")).toBe(true); // 2026: not a leap year
    expect(isLastDayOfMonth("2028-02-28")).toBe(false); // 2028: leap
    expect(isLastDayOfMonth("2028-02-29")).toBe(true);
    expect(isLastDayOfMonth("2026-12-31")).toBe(true);
  });
  it("garbage never triggers a payout", () => {
    expect(isLastDayOfMonth("")).toBe(false);
    expect(isLastDayOfMonth("nope")).toBe(false);
  });
});

describe("nudgeCooling — per-kind quiet period", () => {
  const now = Date.parse("2026-07-23T12:00:00Z");
  it("cooling inside the window, clear after it", () => {
    expect(nudgeCooling("2026-07-10T00:00:00Z", 30, now)).toBe(true);
    expect(nudgeCooling("2026-06-01T00:00:00Z", 30, now)).toBe(false);
  });
  it("never-nudged users are always clear", () => {
    expect(nudgeCooling(null, 30, now)).toBe(false);
  });
});
