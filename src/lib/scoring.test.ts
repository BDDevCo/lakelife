import { describe, it, expect } from "vitest";
import { computeScore, tierLabel } from "./scoring";

const inb = (o: Partial<Parameters<typeof computeScore>[0]> = {}) => ({
  completedCount: 0,
  onTimeCount: 0,
  ratedCount: 0,
  flagsApproved: 0,
  flagsDeclined: 0,
  noShows: 0,
  ...o,
});

describe("computeScore", () => {
  it("a brand-new crew (no history) is 'new' with a moderate score, not zero and not top", () => {
    const s = computeScore(inb());
    expect(s.tier).toBe("new");
    expect(s.score).toBe(50); // 0.5 confidence-floor × rawQuality(1)
  });

  it("a proven, perfect crew reaches Priority with a high score", () => {
    const s = computeScore(inb({ completedCount: 30, onTimeCount: 30, ratedCount: 30 }));
    expect(s.tier).toBe("priority");
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(s.onTimeRate).toBe(1);
  });

  it("a proven crew that runs late is NOT Priority", () => {
    const s = computeScore(inb({ completedCount: 30, onTimeCount: 18, ratedCount: 30 })); // 60% on-time
    expect(s.tier).toBe("building");
    expect(s.onTimeRate).toBeCloseTo(0.6);
    expect(s.score).toBeLessThan(85);
  });

  it("proven quality outranks a new crew (score ordering)", () => {
    const proven = computeScore(inb({ completedCount: 25, onTimeCount: 24, ratedCount: 25 }));
    const fresh = computeScore(inb());
    expect(proven.score).toBeGreaterThan(fresh.score);
  });

  it("declined flags drag flag accuracy and the score down", () => {
    const clean = computeScore(inb({ completedCount: 15, onTimeCount: 15, ratedCount: 15, flagsApproved: 5, flagsDeclined: 0 }));
    const sloppy = computeScore(inb({ completedCount: 15, onTimeCount: 15, ratedCount: 15, flagsApproved: 1, flagsDeclined: 4 }));
    expect(sloppy.flagAccuracy).toBeCloseTo(0.2);
    expect(sloppy.score).toBeLessThan(clean.score);
  });

  it("no flags = full flag accuracy (benefit of the doubt)", () => {
    expect(computeScore(inb({ completedCount: 12, onTimeCount: 12, ratedCount: 12 })).flagAccuracy).toBe(1);
  });

  it("on-time rate uses only jobs we have completion data for", () => {
    const s = computeScore(inb({ completedCount: 20, onTimeCount: 5, ratedCount: 5 })); // only 5 rated, all on time
    expect(s.onTimeRate).toBe(1);
  });

  it("volume gates Priority: high score but few jobs stays 'building'/'new'", () => {
    const s = computeScore(inb({ completedCount: 4, onTimeCount: 4, ratedCount: 4 }));
    expect(s.completedCount).toBeLessThan(10);
    expect(s.tier).toBe("building"); // >=3 jobs but <10, cannot be priority
  });

  it("clamps garbage inputs (negative / over-count) safely", () => {
    const s = computeScore(inb({ completedCount: -5, onTimeCount: 99, ratedCount: 3 }));
    expect(s.onTimeRate).toBe(1); // onTime clamped to ratedCount
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.tier).toBe("new");
  });

  it("tier < 3 jobs is 'new' regardless of quality", () => {
    expect(computeScore(inb({ completedCount: 2, onTimeCount: 2, ratedCount: 2 })).tier).toBe("new");
  });

  it("a no-show drops reliability and the score vs an otherwise-identical clean crew", () => {
    const clean = computeScore(inb({ completedCount: 20, onTimeCount: 20, ratedCount: 20 }));
    const ghost = computeScore(inb({ completedCount: 20, onTimeCount: 20, ratedCount: 20, noShows: 2 }));
    expect(clean.reliabilityRate).toBe(1);
    expect(ghost.reliabilityRate).toBeCloseTo(20 / 22);
    expect(ghost.score).toBeLessThan(clean.score);
  });

  it("2+ no-shows blocks Priority even with an otherwise top record", () => {
    const s = computeScore(inb({ completedCount: 40, onTimeCount: 40, ratedCount: 40, noShows: 2 }));
    expect(s.noShows).toBe(2);
    expect(s.tier).not.toBe("priority");
  });

  it("one historical no-show doesn't alone bar Priority if the record is strong", () => {
    const s = computeScore(inb({ completedCount: 40, onTimeCount: 40, ratedCount: 40, noShows: 1 }));
    // reliability 40/41 ≈ 0.976, still a high score; one slip is forgiven for tier.
    expect(s.tier).toBe("priority");
  });

  it("reliability recovers as a crew completes more good jobs after a miss", () => {
    const fresh = computeScore(inb({ completedCount: 3, onTimeCount: 3, ratedCount: 3, noShows: 1 }));
    const recovered = computeScore(inb({ completedCount: 30, onTimeCount: 30, ratedCount: 30, noShows: 1 }));
    expect(recovered.reliabilityRate).toBeGreaterThan(fresh.reliabilityRate);
  });
});

describe("tierLabel", () => {
  it("gives crew-facing labels with no peer comparison", () => {
    expect(tierLabel("priority").label).toContain("Priority");
    expect(tierLabel("building").label).toBe("Building");
    expect(tierLabel("new").label).toBe("New");
  });
});
