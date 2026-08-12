import { describe, it, expect } from "vitest";
import {
  planRecovery, rescheduleDeadline, proposedFee, crewIsOutOfPocket,
  deadlinePassed, recoveryHeadline, RESCHEDULE_DAYS, tripFeeFor,
} from "./recovery";
import type { CancelDials } from "./cancellation";

const DIALS: CancelDials = { cancelFeePct: 0.25, cancelRoutineHours: 48, cancelWaterDays: 7 };

const job = (o: Partial<Parameters<typeof proposedFee>[0]> = {}) => ({
  hasCrew: true, customerPrice: 95, vendorCost: 60, ...o,
});

describe("the window to pick another day", () => {
  it("gives a week, which spans a weekend on purpose", () => {
    expect(RESCHEDULE_DAYS).toBe(7);
    expect(rescheduleDeadline("2026-08-12")).toBe("2026-08-19");
  });

  it("crosses a month end without drifting", () => {
    expect(rescheduleDeadline("2026-08-28")).toBe("2026-09-04");
  });

  it("crosses a year end without drifting", () => {
    expect(rescheduleDeadline("2026-12-29")).toBe("2027-01-05");
  });
});

describe("NO ACCESS — the case Brendon's rule is about", () => {
  const plan = planRecovery("no_access", "2026-08-12", { serviceName: "Housekeeping" });

  it("a fee may be proposed, because the household controlled the door", () => {
    expect(plan.feeEligible).toBe(true);
  });

  it("asks for another day first — reschedule before charge", () => {
    expect(plan.ask).toContain("Pick another day");
    expect(plan.ask).toContain("couldn't get in");
  });

  it("SAYS UP FRONT what silence costs, rather than letting them find out", () => {
    expect(plan.ifNothingHappens).toContain("Wednesday, August 19");
    expect(plan.ifNothingHappens).toContain("cancellation policy");
  });
});

describe("STOOD DOWN — our record was wrong, so nobody is charged", () => {
  const plan = planRecovery("stood_down", "2026-08-12", { serviceName: "Pier install / removal" });

  it("is NEVER fee-eligible", () => {
    // Charging somebody for declining to pay more than they agreed to would be
    // indefensible — and we already told them in writing nothing would be.
    expect(plan.feeEligible).toBe(false);
  });

  it("offers the crew back with the right details, and says so", () => {
    expect(plan.ask).toContain("send the crew");
    expect(plan.ask).toContain("right details this time");
  });

  it("makes walking away a stated option, not a trap", () => {
    expect(plan.ifNothingHappens).toContain("rather leave it");
    expect(plan.ifNothingHappens).toContain("Nothing is charged either way");
  });
});

describe("what the policy says the fee would be", () => {
  it("uses the SAME dial as a late cancellation — one policy, one number", () => {
    // 25% of $95.
    expect(proposedFee(job(), DIALS)).toEqual({ fee: 23.75, crewShare: 15, free: false });
  });

  it("pays the crew their share, because they held the slot AND drove", () => {
    // 25% of the crew's own $60 rate.
    expect(proposedFee(job(), DIALS).crewShare).toBe(15);
  });

  it("a job with no crew reserved is free — nobody was out of pocket", () => {
    expect(proposedFee(job({ hasCrew: false }), DIALS).free).toBe(true);
  });

  it("a zeroed dial means no fee, ever — the switch works", () => {
    expect(proposedFee(job(), { ...DIALS, cancelFeePct: 0 }).free).toBe(true);
  });

  it("a bigger job scales by the same share — no separate table of numbers", () => {
    const q = proposedFee(job({ customerPrice: 604, vendorCost: 400 }), DIALS);
    expect(q.fee).toBe(151);
    expect(q.crewShare).toBe(100);
  });
});

describe("THE CREW DROVE THERE — say so out loud", () => {
  it("a stand-down always leaves the crew out of pocket", () => {
    // Our bad record, their fuel. This is surfaced, not silently accepted.
    expect(crewIsOutOfPocket("rescheduled", "stood_down")).toBe(true);
    expect(crewIsOutOfPocket("fee_waived", "stood_down")).toBe(true);
  });

  it("a waived no-show leaves them out of pocket too", () => {
    expect(crewIsOutOfPocket("fee_waived", "no_access")).toBe(true);
  });

  it("a rescheduled no-show leaves them out of pocket for the first trip", () => {
    expect(crewIsOutOfPocket("rescheduled", "no_access")).toBe(true);
  });

  it("a charged fee is the one case they are made whole", () => {
    expect(crewIsOutOfPocket("fee_charged", "no_access")).toBe(false);
  });
});

describe("the deadline", () => {
  it("has not passed on the day itself", () => {
    expect(deadlinePassed("2026-08-19", "2026-08-19")).toBe(false);
  });

  it("has passed the day after", () => {
    expect(deadlinePassed("2026-08-19", "2026-08-20")).toBe(true);
  });

  it("a job with no deadline is never late", () => {
    expect(deadlinePassed(null, "2026-08-20")).toBe(false);
  });
});

describe("the line an ops screen shows while triaging", () => {
  const base = { outcome: "no_access" as const, deadline: "2026-08-19", todayISO: "2026-08-13" };

  it("waiting, inside the window", () => {
    expect(recoveryHeadline("awaiting_customer", base)).toBe("Waiting on the customer to pick a day");
  });

  it("waiting, window closed — names the decision to make", () => {
    expect(recoveryHeadline("awaiting_customer", { ...base, todayISO: "2026-08-25" }))
      .toBe("Window closed — decide on the fee");
  });

  it("a stood-down one past its window has nothing to charge, and says so", () => {
    expect(recoveryHeadline("awaiting_customer", {
      ...base, outcome: "stood_down", todayISO: "2026-08-25",
    })).toBe("No reply — close it off, nothing to charge");
  });

  it("names the money on a proposed fee", () => {
    expect(recoveryHeadline("fee_proposed", { ...base, fee: 23.75 }))
      .toBe("Fee proposed — $23.75, waiting on you");
  });

  it("a waived fee says who ate the cost", () => {
    expect(recoveryHeadline("fee_waived", base)).toBe("Fee waived — crew got nothing for the trip");
  });

  it("a job that never needed recovery says so rather than showing blank", () => {
    expect(recoveryHeadline(null, base)).toBe("No recovery needed");
  });
});

describe("THE TRIP FEE — the crew drove there", () => {
  it("pays the floor when the customer's fee falls short of it", () => {
    // 25% of a $60 crew rate is $15. The trip still cost them $35 of fuel.
    const t = tripFeeFor({ outcome: "no_access", collectedCrewShare: 15 });
    expect(t.owed).toBe(35);
    expect(t.fundedBy).toBe("customer");
    expect(t.why).toContain("Topped up");
  });

  it("IS A FLOOR, NOT A CAP — a big job's share is not docked to $35", () => {
    const t = tripFeeFor({ outcome: "no_access", collectedCrewShare: 100 });
    expect(t.owed).toBe(100);
    expect(t.why).toContain("doesn't dock them");
  });

  it("LAKELIFE pays when no fee was collected at all", () => {
    const t = tripFeeFor({ outcome: "no_access", collectedCrewShare: 0 });
    expect(t.owed).toBe(35);
    expect(t.fundedBy).toBe("lakelife");
  });

  it("a stand-down is ALWAYS ours — our profile was wrong, their fuel", () => {
    const t = tripFeeFor({ outcome: "stood_down", collectedCrewShare: 0 });
    expect(t.owed).toBe(35);
    expect(t.fundedBy).toBe("lakelife");
    expect(t.why).toContain("Our profile was wrong");
  });

  it("honours the dial, including a park-sized one", () => {
    expect(tripFeeFor({ outcome: "no_access", collectedCrewShare: 0, tripFee: 60 }).owed).toBe(60);
  });

  it("a zeroed dial switches it off — the crew gets only what was collected", () => {
    const off = tripFeeFor({ outcome: "stood_down", collectedCrewShare: 0, tripFee: 0 });
    expect(off.owed).toBe(0);
    expect(off.why).toContain("No trip fee is set");
  });

  it("never returns a negative, whatever it is handed", () => {
    expect(tripFeeFor({ outcome: "no_access", collectedCrewShare: -50, tripFee: -10 }).owed).toBe(0);
  });
});

describe("out of pocket, after the trip fee exists", () => {
  it("a crew who got a trip fee is NOT out of pocket, whatever the branch", () => {
    expect(crewIsOutOfPocket("fee_waived", "stood_down", 35)).toBe(false);
    expect(crewIsOutOfPocket("rescheduled", "no_access", 35)).toBe(false);
  });

  it("still says so when the dial is off and nothing reached them", () => {
    // The check survives so a zeroed dial, or a trip fee that failed to raise,
    // does not quietly put us back where we started.
    expect(crewIsOutOfPocket("fee_waived", "stood_down", 0)).toBe(true);
  });
});
