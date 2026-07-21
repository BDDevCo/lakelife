import { describe, it, expect } from "vitest";
import {
  isEligible,
  marginPct,
  rankCrews,
  decideDispatch,
  remainingCapacity,
  type CrewCandidate,
  type DispatchInput,
} from "./dispatch";

const crew = (over: Partial<CrewCandidate> = {}): CrewCandidate => ({
  vendorId: over.vendorId ?? "v1",
  status: "active",
  coiExpiry: "2027-01-01",
  serviceTypes: ["Housekeeping"],
  workDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  dailyCapacity: 5,
  assignedThatDay: 0,
  blockedThatDay: false,
  crewRate: 70,
  score: 0,
  ...over,
});

const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  date: "2026-07-22",
  weekday: "Wed",
  serviceName: "Housekeeping",
  menuPrice: 100,
  todayISO: "2026-07-20",
  marginFloor: 0.25,
  preferredVendorId: null,
  crews: [],
  ...over,
});

describe("isEligible — hard gates", () => {
  it("passes a clean active crew", () => {
    expect(isEligible(crew(), input())).toBe(true);
  });
  it("blocks suspended / invited crews", () => {
    expect(isEligible(crew({ status: "suspended" }), input())).toBe(false);
    expect(isEligible(crew({ status: "invited" }), input())).toBe(false);
  });
  it("blocks expired or missing COI (no COI, no jobs)", () => {
    expect(isEligible(crew({ coiExpiry: "2026-07-19" }), input())).toBe(false); // < today
    expect(isEligible(crew({ coiExpiry: null }), input())).toBe(false);
  });
  it("blocks a crew that doesn't do the service", () => {
    expect(isEligible(crew({ serviceTypes: ["Lawn mowing & trim"] }), input())).toBe(false);
  });
  it("blocks a crew that doesn't work that weekday", () => {
    expect(isEligible(crew({ workDays: ["Sat", "Sun"] }), input())).toBe(false);
  });
  it("blocks a crew that blocked the day", () => {
    expect(isEligible(crew({ blockedThatDay: true }), input())).toBe(false);
  });
  it("blocks a full crew and a zero-capacity crew", () => {
    expect(isEligible(crew({ dailyCapacity: 3, assignedThatDay: 3 }), input())).toBe(false);
    expect(isEligible(crew({ dailyCapacity: 0 }), input())).toBe(false);
  });
});

describe("marginPct", () => {
  it("computes margin fraction", () => {
    expect(marginPct(100, 70)).toBeCloseTo(0.3);
    expect(marginPct(100, 80)).toBeCloseTo(0.2);
  });
  it("guards zero/invalid menu price", () => {
    expect(marginPct(0, 70)).toBe(0);
  });
});

describe("rankCrews — order of tie-breakers", () => {
  it("score wins first", () => {
    const a = crew({ vendorId: "a", score: 10 });
    const b = crew({ vendorId: "b", score: 50 });
    expect(rankCrews([a, b], 100)[0].vendorId).toBe("b");
  });
  it("route density beats margin at equal score", () => {
    const dense = crew({ vendorId: "dense", assignedThatDay: 3, crewRate: 80 }); // 20% margin
    const empty = crew({ vendorId: "empty", assignedThatDay: 0, crewRate: 60 }); // 40% margin
    expect(rankCrews([empty, dense], 100)[0].vendorId).toBe("dense");
  });
  it("margin breaks ties at equal score + density", () => {
    const lo = crew({ vendorId: "lo", crewRate: 80 });
    const hi = crew({ vendorId: "hi", crewRate: 55 });
    expect(rankCrews([lo, hi], 100)[0].vendorId).toBe("hi");
  });
  it("is deterministic when everything ties", () => {
    const a = crew({ vendorId: "aaa" });
    const b = crew({ vendorId: "bbb" });
    expect(rankCrews([b, a], 100).map((c) => c.vendorId)).toEqual(["aaa", "bbb"]);
  });
});

describe("decideDispatch", () => {
  it("assigns the best-ranked eligible crew and computes margin", () => {
    const d = decideDispatch(input({ crews: [crew({ vendorId: "v1", crewRate: 70, score: 5 }), crew({ vendorId: "v2", crewRate: 65, score: 9 })] }));
    expect(d.ok).toBe(true);
    expect(d.result?.vendorId).toBe("v2"); // higher score
    expect(d.result?.margin).toBe(35);
    expect(d.result?.marginPct).toBeCloseTo(0.35);
  });

  it("preferred crew gets first right of refusal even over a higher score", () => {
    const d = decideDispatch(
      input({
        preferredVendorId: "mine",
        crews: [crew({ vendorId: "mine", crewRate: 75, score: 1 }), crew({ vendorId: "star", crewRate: 60, score: 99 })],
      }),
    );
    expect(d.result?.vendorId).toBe("mine");
    expect(d.result?.preferred).toBe(true);
  });

  it("preferred crew is SKIPPED when ineligible — waterfalls to next", () => {
    const d = decideDispatch(
      input({
        preferredVendorId: "mine",
        crews: [crew({ vendorId: "mine", blockedThatDay: true }), crew({ vendorId: "backup", crewRate: 70 })],
      }),
    );
    expect(d.ok).toBe(true);
    expect(d.result?.vendorId).toBe("backup");
    expect(d.result?.preferred).toBe(false);
  });

  it("preferred crew skipped when their rate is below the floor", () => {
    const d = decideDispatch(
      input({
        preferredVendorId: "mine",
        crews: [crew({ vendorId: "mine", crewRate: 90 }), crew({ vendorId: "ok", crewRate: 70 })], // 10% vs 30%
      }),
    );
    expect(d.result?.vendorId).toBe("ok");
  });

  it("no crew does the service -> no_crew_for_service", () => {
    const d = decideDispatch(input({ crews: [crew({ serviceTypes: ["Lawn mowing & trim"] })] }));
    expect(d.ok).toBe(false);
    expect(d.reasonNoFit).toBe("no_crew_for_service");
  });

  it("service crews exist but all full/blocked -> all_full_or_blocked", () => {
    const d = decideDispatch(input({ crews: [crew({ dailyCapacity: 2, assignedThatDay: 2 })] }));
    expect(d.reasonNoFit).toBe("all_full_or_blocked");
  });

  it("eligible but no rate set -> no_qualifying_rate", () => {
    const d = decideDispatch(input({ crews: [crew({ crewRate: null })] }));
    expect(d.reasonNoFit).toBe("no_qualifying_rate");
  });

  it("a $0 rate does NOT qualify (never ranks first at 100% margin)", () => {
    const d = decideDispatch(input({ crews: [crew({ vendorId: "zero", crewRate: 0 }), crew({ vendorId: "real", crewRate: 70 })] }));
    expect(d.ok).toBe(true);
    expect(d.result?.vendorId).toBe("real");
  });
  it("all crews at $0 -> no_qualifying_rate", () => {
    const d = decideDispatch(input({ crews: [crew({ crewRate: 0 })] }));
    expect(d.reasonNoFit).toBe("no_qualifying_rate");
  });

  it("eligible + rated but all below floor -> below_floor (price signal to ops)", () => {
    const d = decideDispatch(input({ menuPrice: 100, marginFloor: 0.25, crews: [crew({ crewRate: 85 }), crew({ crewRate: 90 })] }));
    expect(d.reasonNoFit).toBe("below_floor");
    expect(d.eligibleCount).toBe(2);
  });

  it("never leaks below-floor assignments — filters the sub-floor crew, picks the affordable one", () => {
    const d = decideDispatch(
      input({ menuPrice: 100, marginFloor: 0.3, crews: [crew({ vendorId: "hi", crewRate: 71 }), crew({ vendorId: "lo", crewRate: 60 })] }),
    ); // 71 -> 29% (rejected), 60 -> 40% (kept)
    expect(d.ok).toBe(true);
    expect(d.result?.marginPct).toBeGreaterThanOrEqual(0.3);
    expect(d.result?.vendorId).toBe("lo");
  });
});

describe("remainingCapacity — booking calendar", () => {
  it("sums open slots across eligible crews only", () => {
    const cap = remainingCapacity(
      input({
        crews: [
          crew({ vendorId: "a", dailyCapacity: 5, assignedThatDay: 2 }), // 3 open
          crew({ vendorId: "b", dailyCapacity: 4, assignedThatDay: 4 }), // 0 open
          crew({ vendorId: "c", dailyCapacity: 3, assignedThatDay: 0, status: "suspended" }), // ineligible
          crew({ vendorId: "d", dailyCapacity: 2, assignedThatDay: 0 }), // 2 open
        ],
      }) as unknown as Parameters<typeof remainingCapacity>[0],
    );
    expect(cap).toBe(5); // 3 + 0 + 0 + 2
  });
  it("returns 0 when nobody is eligible (date must not be offered)", () => {
    const cap = remainingCapacity(input({ crews: [crew({ coiExpiry: null })] }) as unknown as Parameters<typeof remainingCapacity>[0]);
    expect(cap).toBe(0);
  });
});
