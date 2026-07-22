import { describe, it, expect } from "vitest";
import { warningDue, isExpired } from "./waitlist";

const today = "2026-07-22";

describe("warningDue — exact-boundary warning (one send, no spam)", () => {
  it("fires exactly warnDays before the date", () => {
    expect(warningDue("2026-07-24", today, 2)).toBe(true);
  });
  it("silent the day before and the day after the boundary", () => {
    expect(warningDue("2026-07-25", today, 2)).toBe(false); // 3 days out
    expect(warningDue("2026-07-23", today, 2)).toBe(false); // 1 day out
  });
  it("crosses month boundaries without drift", () => {
    expect(warningDue("2026-08-01", "2026-07-30", 2)).toBe(true);
  });
  it("null date or zero/negative dial never fires", () => {
    expect(warningDue(null, today, 2)).toBe(false);
    expect(warningDue("2026-07-24", today, 0)).toBe(false);
  });
});

describe("isExpired — the honest floor", () => {
  it("true once the date has passed, false today and ahead", () => {
    expect(isExpired("2026-07-21", today)).toBe(true);
    expect(isExpired("2026-07-22", today)).toBe(false); // day-of: still fillable
    expect(isExpired("2026-07-23", today)).toBe(false);
  });
  it("null date never expires", () => {
    expect(isExpired(null, today)).toBe(false);
  });
});
