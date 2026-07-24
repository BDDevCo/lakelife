import { describe, it, expect } from "vitest";
import { learnedEstimate, median, MIN_SAMPLES } from "./learning";

describe("learnedEstimate — dials walk toward reality, damped", () => {
  it("stands still under the sample minimum", () => {
    expect(learnedEstimate(45, [50, 55, 60]).moved).toBe(false);
  });
  it("moves toward the median, capped at 15% (min one 5-min step)", () => {
    // median 90 vs current 45 → max step max(5, round(6.75/5)*5=5)=5... 45*0.15=6.75 → round(6.75/5)*5 = 5
    const r = learnedEstimate(45, [85, 90, 90, 95, 100]);
    expect(r.moved).toBe(true);
    expect(r.next).toBe(50); // one damped step, not a leap to 90
  });
  it("lands exactly on a nearby median within the step", () => {
    const r = learnedEstimate(60, [55, 55, 55, 55, 55]);
    expect(r.next).toBe(55);
  });
  it("filters stamp noise (couch uploads, double-starts)", () => {
    // 2-minute and 900-minute samples are noise; only 5 real ones remain
    const r = learnedEstimate(60, [2, 900, 55, 55, 55, 55, 55]);
    expect(r.samples).toBe(5);
    expect(r.next).toBe(55);
  });
  it("never drops below 10 and rounds to 5s", () => {
    const r = learnedEstimate(15, [10, 10, 10, 10, 10]);
    expect(r.next).toBe(10);
  });
  it("degenerate current estimate defaults to 60 before learning", () => {
    const r = learnedEstimate(0, [30, 30, 30, 30, 30]);
    expect(r.next).toBe(50); // 60 - max step (round(9/5)*5=10) = 50
  });
});

describe("median", () => {
  it("odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
