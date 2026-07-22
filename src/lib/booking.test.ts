import { describe, it, expect } from "vitest";
import { dayStatus, toISODate, isRecurring, todayLakeDate, type DayContext } from "./booking";

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
  it("todayLakeDate returns Indiana-time YYYY-MM-DD regardless of server TZ", () => {
    expect(todayLakeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Must match what Intl computes for Indiana right now (self-consistent check)
    const indiana = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Indiana/Indianapolis" }).format(new Date());
    expect(todayLakeDate()).toBe(indiana);
  });
  it("recurring detection", () => {
    expect(isRecurring("Weekly")).toBe(true);
    expect(isRecurring("Before each arrival")).toBe(true);
    expect(isRecurring("Install (spring)")).toBe(false);
  });
});

describe("dayStatus — same-day rush (⚡)", () => {
  const base: DayContext = {
    today: "2026-07-22", isWaterWork: false, seasonStart: null, seasonEnd: null, fullDates: new Set<string>(),
  };

  it("today is 'rush' inside the window, 'past' outside it", () => {
    expect(dayStatus("2026-07-22", { ...base, rushNowHour: 9, rushCutoffHour: 14 })).toBe("rush");
    expect(dayStatus("2026-07-22", { ...base, rushNowHour: 14, rushCutoffHour: 14 })).toBe("past"); // at cutoff
    expect(dayStatus("2026-07-22", { ...base, rushNowHour: 3, rushCutoffHour: 14 })).toBe("past"); // pre-6am
  });

  it("rush disabled entirely when the hours aren't provided (pre-rush behavior)", () => {
    expect(dayStatus("2026-07-22", base)).toBe("past");
  });

  it("rush is exempt from fullDates — the claiming crew judges their own day", () => {
    const full = new Set(["2026-07-22"]);
    expect(dayStatus("2026-07-22", { ...base, fullDates: full, rushNowHour: 9, rushCutoffHour: 14 })).toBe("rush");
  });

  it("rush still respects the water-work season gate (rule 7 outranks urgency)", () => {
    const water: DayContext = { ...base, isWaterWork: true, seasonStart: "2026-08-01", seasonEnd: "2026-10-20", rushNowHour: 9, rushCutoffHour: 14 };
    expect(dayStatus("2026-07-22", water)).toBe("off-season"); // ice-out not until Aug
  });

  it("future days are untouched by rush context", () => {
    expect(dayStatus("2026-07-23", { ...base, rushNowHour: 9, rushCutoffHour: 14 })).toBe("available");
  });
});
