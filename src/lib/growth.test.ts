import { describe, it, expect } from "vitest";
import { isLastDayOfMonth, nudgeCooling, nearMilestone } from "./growth";

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

describe("nearMilestone — the honest tease band", () => {
  it("fires inside the band with the exact dollar gap", () => {
    expect(nearMilestone(20, 15, 50)).toEqual({ gap: 15, projected: 35 });
  });
  it("silent when not close enough", () => {
    expect(nearMilestone(10, 5, 50)).toBeNull(); // 15 < 60% of 50
  });
  it("hands off to covers-visit once the balance itself crosses", () => {
    expect(nearMilestone(50, 0, 50)).toBeNull();
    expect(nearMilestone(60, 10, 50)).toBeNull();
  });
  it("gap 0 when maturing money alone will cross the line", () => {
    expect(nearMilestone(30, 25, 50)).toEqual({ gap: 0, projected: 55 });
  });
  it("cents round instead of drifting", () => {
    expect(nearMilestone(29.995, 0.01, 50)).toEqual({ gap: 19.99, projected: 30.01 });
  });
  it("garbage thresholds and negative inputs never tease", () => {
    expect(nearMilestone(40, 5, 0)).toBeNull();
    // negative balance clamps to 0 — the tease is computed on real money only
    expect(nearMilestone(-40, 45, 50)).toEqual({ gap: 5, projected: 45 });
  });
});
