import { describe, it, expect } from "vitest";
import { learnedEstimate, median } from "./learning";

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
  // UPDATED for audit bug 10c (was: expected 50 — one damped step down from
  // the substituted 60). A degenerate dial is not a number a human chose, so
  // it no longer gets damping's protection: it lands on the evidence at once.
  // See the "INVALID stored dial heals" block below.
  it("degenerate current estimate lands on the samples, not one step off a fiction", () => {
    const r = learnedEstimate(0, [30, 30, 30, 30, 30]);
    expect(r.next).toBe(30);
    expect(r.moved).toBe(true);
  });
});

describe("median", () => {
  it("odd/even/empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AUDIT BUG 10c: a stored dial of 0 could never heal. learnedEstimate(0, …)
// substituted 60 internally and then compared 60 to 60 — moved=false, so
// learnServiceDurations never wrote and the row stayed 0 forever. The seeded
// 'Storage overstay (per-diem)' row ships with est_minutes = 0, and a 0 dial
// means the router budgets no time at all for that work.
// ---------------------------------------------------------------------------
describe("learnedEstimate — an INVALID stored dial heals from real samples", () => {
  it("a 0 dial whose samples sit right at the old 60-minute substitute still moves", () => {
    const r = learnedEstimate(0, [60, 60, 60, 60, 60]);
    expect(r.moved).toBe(true); // was false: 60 (substituted) === 60 (target)
    expect(r.next).toBe(60);
  });
  it("an invalid dial lands ON the samples, not one damped step from a fiction", () => {
    // Damping protects a dial someone chose; 0 (or negative) is not a choice.
    expect(learnedEstimate(0, [30, 30, 30, 30, 30]).next).toBe(30);
    expect(learnedEstimate(-15, [95, 100, 100, 100, 105]).next).toBe(100);
  });
  it("still rounds to 5s and floors at 10 when healing", () => {
    expect(learnedEstimate(0, [11, 12, 12, 12, 13]).next).toBe(10);
    expect(learnedEstimate(0, [42, 43, 43, 44, 44]).next).toBe(45);
  });
  it("no evidence, no heal — an invalid dial with too few samples stands still", () => {
    const r = learnedEstimate(0, [30, 30, 30]);
    expect(r.moved).toBe(false);
  });
  it("a VALID dial is still damped — healing must not un-damp normal learning", () => {
    expect(learnedEstimate(45, [85, 90, 90, 95, 100]).next).toBe(50);
  });
});
