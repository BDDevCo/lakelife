import { describe, it, expect } from "vitest";
import { shouldDemote, isCoolingDown, median, healBase } from "./lake-standing";

describe("shouldDemote — net strikes on one lake", () => {
  it("demotes at the limit (2 misses, 0 completions)", () => {
    expect(shouldDemote(2, 0, 2)).toBe(true);
  });
  it("completions offset strikes (a working crew survives a bad week)", () => {
    expect(shouldDemote(2, 1, 2)).toBe(false);
    expect(shouldDemote(5, 4, 2)).toBe(false);
    expect(shouldDemote(6, 4, 2)).toBe(true);
  });
  it("one miss never demotes at the default dial", () => {
    expect(shouldDemote(1, 0, 2)).toBe(false);
  });
  it("a zero/invalid limit disables demotion (kill-switch)", () => {
    expect(shouldDemote(10, 0, 0)).toBe(false);
  });
});

describe("isCoolingDown", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  it("true inside the window, false after it", () => {
    expect(isCoolingDown("2026-07-01T12:00:00Z", 30, now)).toBe(true); // 21 days in
    expect(isCoolingDown("2026-06-01T12:00:00Z", 30, now)).toBe(false); // 51 days in
  });
  it("null/garbage timestamps never block", () => {
    expect(isCoolingDown(null, 30, now)).toBe(false);
    expect(isCoolingDown("not-a-date", 30, now)).toBe(false);
  });
});

describe("median", () => {
  it("odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("empty/invalid → null", () => {
    expect(median([])).toBeNull();
    expect(median([NaN])).toBeNull();
  });
});

describe("healBase — pin from where the crew actually works", () => {
  const cluster = [
    { lat: 41.60, lng: -85.30 }, { lat: 41.61, lng: -85.31 }, { lat: 41.59, lng: -85.29 },
    { lat: 41.62, lng: -85.30 }, { lat: 41.60, lng: -85.32 },
  ];

  it("keeps quiet under the minimum job count (not enough signal)", () => {
    expect(healBase(cluster.slice(0, 3), null, null).action).toBe("keep");
  });

  it("sets a missing base from the centroid", () => {
    const d = healBase(cluster, null, null);
    expect(d.action).toBe("set");
    expect(d.lat).toBeCloseTo(41.60, 2);
    expect(d.lng).toBeCloseTo(-85.30, 2);
  });

  it("corrects a wildly wrong pin (>25 mi off the centroid)", () => {
    const d = healBase(cluster, 42.5, -86.5); // ~90 mi away — typo'd town
    expect(d.action).toBe("correct");
    expect(d.lat).toBeCloseTo(41.60, 2);
  });

  it("leaves a sane pin alone (the crew knows where they live)", () => {
    const d = healBase(cluster, 41.65, -85.35); // a few miles off — fine
    expect(d.action).toBe("keep");
    expect(d.lat).toBe(41.65);
  });

  it("ignores null-coordinate jobs when counting signal", () => {
    const sparse = [...cluster.slice(0, 4), { lat: null, lng: null }];
    expect(healBase(sparse, null, null).action).toBe("keep"); // only 4 usable
  });
});
