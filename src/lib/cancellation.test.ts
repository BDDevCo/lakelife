import { describe, it, expect } from "vitest";
import { cancellationQuote, hoursUntilStart, type CancelDials } from "./cancellation";

const dials: CancelDials = { cancelFeePct: 0.25, cancelRoutineHours: 48, cancelWaterDays: 7 };

// Now = Wed 2026-07-22, 9:00am lake time.
const NOW = { nowDateISO: "2026-07-22", nowMinutes: 9 * 60 };

const base = {
  status: "scheduled",
  hasCrew: true,
  isWaterWork: false,
  jobDateISO: "2026-07-25", // Sat
  slot: "10a",
  customerPrice: 120,
  vendorCost: 59,
  ...NOW,
};

describe("hoursUntilStart", () => {
  it("computes wall-clock hours to the slot start", () => {
    // Wed 9:00 → Sat 10:00 = 73 hours
    expect(hoursUntilStart("2026-07-25", "10a", "2026-07-22", 9 * 60)).toBe(73);
  });
  it("defaults unknown/missing slots to 8am", () => {
    expect(hoursUntilStart("2026-07-23", null, "2026-07-22", 8 * 60)).toBe(24);
    expect(hoursUntilStart("2026-07-23", "weird", "2026-07-22", 8 * 60)).toBe(24);
  });
  it("crosses month boundaries without drift", () => {
    expect(hoursUntilStart("2026-08-01", "8a", "2026-07-31", 8 * 60)).toBe(24);
  });
});

describe("cancellationQuote — routine services (48h window)", () => {
  it("free outside the window (73h out)", () => {
    const q = cancellationQuote(base, dials);
    expect(q).toMatchObject({ allowed: true, free: true, fee: 0, reason: "outside_window" });
  });

  it("charges 25% inside the window, and the crew gets their rate share", () => {
    const q = cancellationQuote({ ...base, jobDateISO: "2026-07-23" }, dials); // 25h out < 48h
    expect(q.allowed).toBe(true);
    expect(q.free).toBe(false);
    expect(q.fee).toBe(30); // 25% of $120
    expect(q.crewShare).toBe(14.75); // 25% of $59
    expect(q.reason).toBe("inside_window");
  });

  it("fee lands exactly at the window boundary edge (47.99h = fee, 48h = free)", () => {
    // Job Fri 8a; now Wed 8:00 → exactly 48h → free
    const at = cancellationQuote({ ...base, jobDateISO: "2026-07-24", slot: "8a", nowMinutes: 8 * 60 }, dials);
    expect(at.free).toBe(true);
    // now Wed 8:01 → 47.98h → fee
    const inside = cancellationQuote({ ...base, jobDateISO: "2026-07-24", slot: "8a", nowMinutes: 8 * 60 + 1 }, dials);
    expect(inside.free).toBe(false);
  });
});

describe("cancellationQuote — water work (7-day window)", () => {
  it("uses the day-based window (5 days out = fee, 8 days out = free)", () => {
    const water = { ...base, isWaterWork: true };
    expect(cancellationQuote({ ...water, jobDateISO: "2026-07-27" }, dials).free).toBe(false); // ~5d
    expect(cancellationQuote({ ...water, jobDateISO: "2026-07-30" }, dials).free).toBe(true); // 8d
  });
});

describe("cancellationQuote — who owes nothing", () => {
  it("a requested (unclaimed) job is always free — nobody reserved the slot", () => {
    const q = cancellationQuote({ ...base, status: "requested", jobDateISO: "2026-07-22" }, dials);
    expect(q).toMatchObject({ allowed: true, free: true, reason: "no_crew_reserved" });
  });

  it("scheduled-but-unassigned never charges", () => {
    const q = cancellationQuote({ ...base, hasCrew: false, jobDateISO: "2026-07-23" }, dials);
    expect(q).toMatchObject({ allowed: true, free: true, reason: "no_crew_reserved" });
  });

  it("day-of / past / in-progress are not self-serve (call us)", () => {
    expect(cancellationQuote({ ...base, jobDateISO: "2026-07-22" }, dials).allowed).toBe(false);
    expect(cancellationQuote({ ...base, jobDateISO: "2026-07-20" }, dials).allowed).toBe(false);
    expect(cancellationQuote({ ...base, status: "in_progress" }, dials).allowed).toBe(false);
    expect(cancellationQuote({ ...base, status: "complete" }, dials).allowed).toBe(false);
  });

  it("a 0% fee dial makes every allowed cancel free (beta kill-switch)", () => {
    const q = cancellationQuote({ ...base, jobDateISO: "2026-07-23" }, { ...dials, cancelFeePct: 0 });
    expect(q).toMatchObject({ allowed: true, free: true, fee: 0, reason: "zero_fee_dial" });
  });

  it("never charges negative amounts on degenerate prices", () => {
    const q = cancellationQuote({ ...base, jobDateISO: "2026-07-23", customerPrice: -50, vendorCost: -10 }, dials);
    expect(q.fee).toBe(0);
    expect(q.crewShare).toBe(0);
  });
});
