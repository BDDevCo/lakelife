import { describe, it, expect } from "vitest";
import { dayStatus, toISODate, isRecurring, type DayContext } from "./booking";

// Big Long Lake 2026: ice-out Mar 21, pull deadline Nov 14.
const waterCtx = (fullDates: string[] = []): DayContext => ({
  today: "2026-07-16",
  isWaterWork: true,
  seasonStart: "2026-03-21",
  seasonEnd: "2026-11-14",
  fullDates: new Set(fullDates),
});

const landCtx = (fullDates: string[] = []): DayContext => ({
  today: "2026-07-16",
  isWaterWork: false,
  seasonStart: null,
  seasonEnd: null,
  fullDates: new Set(fullDates),
});

describe("dayStatus — past days", () => {
  it("today is not bookable", () => expect(dayStatus("2026-07-16", waterCtx())).toBe("past"));
  it("yesterday is past", () => expect(dayStatus("2026-07-15", waterCtx())).toBe("past"));
});

describe("dayStatus — water-work season window (rule 7)", () => {
  it("before ice-out is off-season (when today is still early)", () =>
    expect(dayStatus("2026-03-10", { ...waterCtx(), today: "2026-02-01" })).toBe("off-season"));
  it("after the pull deadline is off-season", () => expect(dayStatus("2026-11-20", waterCtx())).toBe("off-season"));
  it("on the pull deadline is still allowed", () => expect(dayStatus("2026-11-14", waterCtx())).toBe("available"));
  it("mid-season is available", () => expect(dayStatus("2026-08-01", waterCtx())).toBe("available"));
});

describe("dayStatus — land work ignores the season window", () => {
  it("mowing in December is fine (still available, not off-season)", () =>
    expect(dayStatus("2026-12-05", landCtx())).toBe("available"));
});

describe("dayStatus — capacity", () => {
  it("a full day is not bookable", () =>
    expect(dayStatus("2026-08-01", waterCtx(["2026-08-01"]))).toBe("full"));
  it("season beats capacity — off-season shows first", () =>
    expect(dayStatus("2026-12-01", waterCtx(["2026-12-01"]))).toBe("off-season"));
});

describe("helpers", () => {
  it("toISODate has no timezone drift", () => expect(toISODate(new Date(2026, 10, 14))).toBe("2026-11-14"));
  it("recurring detection", () => {
    expect(isRecurring("Weekly")).toBe(true);
    expect(isRecurring("Before each arrival")).toBe(true);
    expect(isRecurring("Install (spring)")).toBe(false);
  });
});
