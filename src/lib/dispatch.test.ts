import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isEligible,
  marginPct,
  rankCrews,
  decideDispatch,
  remainingCapacity,
  milesBetween,
  canClaim,
  scarcityOffer,
  type CrewCandidate,
  type DispatchInput,
  gapTakeHome,
  gapOfferFor,
  gapJitter,
} from "./dispatch";

const crew = (over: Partial<CrewCandidate> = {}): CrewCandidate => ({
  vendorId: over.vendorId ?? "v1",
  status: "active",
  coiExpiry: "2027-01-01",
  serviceTypes: ["Housekeeping"],
  serviceLakes: ["lake-1"],
  workDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  dailyCapacity: 5,
  assignedThatDay: 0,
  blockedThatDay: false,
  crewRate: 70,
  score: 0,
  baseLat: null,
  baseLng: null,
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
  lakeId: null,
  jobLat: null,
  jobLng: null,
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

describe("isEligible — geo gate (Phase B)", () => {
  it("passes a crew that services the job's lake", () => {
    expect(isEligible(crew({ serviceLakes: ["lake-1", "lake-2"] }), input({ lakeId: "lake-1" }))).toBe(true);
  });
  it("blocks a crew that does NOT service the job's lake (far-away crew)", () => {
    expect(isEligible(crew({ serviceLakes: ["lake-2"] }), input({ lakeId: "lake-1" }))).toBe(false);
  });
  it("blocks a crew that services no lakes at all", () => {
    expect(isEligible(crew({ serviceLakes: [] }), input({ lakeId: "lake-1" }))).toBe(false);
  });
  it("applies no geo gate when the job has no lake (lakeId null)", () => {
    expect(isEligible(crew({ serviceLakes: [] }), input({ lakeId: null }))).toBe(true);
  });
  it("excludes an off-lake crew from the whole decision", () => {
    const d = decideDispatch(input({ lakeId: "lake-1", crews: [crew({ vendorId: "off", serviceLakes: ["lake-9"] })] }));
    expect(d.ok).toBe(false);
  });
});

describe("milesBetween", () => {
  it("is ~0 for the same point", () => {
    expect(milesBetween(41.6, -85.3, 41.6, -85.3)).toBeCloseTo(0, 5);
  });
  it("returns Infinity when any coordinate is null (unknown base)", () => {
    expect(milesBetween(41.6, -85.3, null, -85.3)).toBe(Infinity);
    expect(milesBetween(null, null, 41.6, -85.3)).toBe(Infinity);
  });
  it("computes a sane distance (~1 deg latitude ≈ 69 mi)", () => {
    expect(milesBetween(41, -85, 42, -85)).toBeGreaterThan(68);
    expect(milesBetween(41, -85, 42, -85)).toBeLessThan(70);
  });
});

describe("rankCrews — proximity (Phase B, scenario 3)", () => {
  const near = { baseLat: 41.60, baseLng: -85.30 }; // ~2 mi from job
  const far = { baseLat: 41.20, baseLng: -85.80 };  // ~40 mi from job
  const JOB_LAT = 41.62, JOB_LNG = -85.30;

  it("a NEARER crew beats a FARTHER one when score & density tie", () => {
    const a = crew({ vendorId: "far", ...far });
    const b = crew({ vendorId: "near", ...near });
    expect(rankCrews([a, b], 100, JOB_LAT, JOB_LNG)[0].vendorId).toBe("near");
  });

  it("a far, CHEAPER crew does NOT win over a local one on margin alone", () => {
    const local = crew({ vendorId: "local", crewRate: 70, ...near }); // 30% margin
    const distant = crew({ vendorId: "distant", crewRate: 60, ...far }); // 40% margin but 40 mi
    expect(rankCrews([distant, local], 100, JOB_LAT, JOB_LNG)[0].vendorId).toBe("local");
  });

  it("falls through to margin when bases are unknown (no regression pre-base)", () => {
    const lo = crew({ vendorId: "lo", crewRate: 80 }); // null base, 20% margin
    const hi = crew({ vendorId: "hi", crewRate: 55 }); // null base, 45% margin
    expect(rankCrews([lo, hi], 100, JOB_LAT, JOB_LNG)[0].vendorId).toBe("hi");
  });

  it("route density still outranks proximity (already-there crew wins)", () => {
    const dense = crew({ vendorId: "dense", assignedThatDay: 3, ...far });
    const idle = crew({ vendorId: "idle", assignedThatDay: 0, ...near });
    expect(rankCrews([idle, dense], 100, JOB_LAT, JOB_LNG)[0].vendorId).toBe("dense");
  });
});

describe("canClaim — claim board gate (Phase D)", () => {
  const claimInput = { serviceName: "Housekeeping", weekday: "Wed", todayISO: "2026-07-20", menuPrice: 100, marginFloor: 0.25 };

  it("a clean crew with a floor-clearing rate can claim", () => {
    expect(canClaim(crew({ crewRate: 70 }), claimInput)).toEqual({ ok: true });
  });

  it("SKIPS the lake gate — an off-lake crew can claim (that's the cold-start opt-in)", () => {
    // serviceLakes doesn't include any lake for this job — still claimable.
    expect(canClaim(crew({ serviceLakes: [] }), claimInput).ok).toBe(true);
    expect(canClaim(crew({ serviceLakes: ["some-other-lake"] }), claimInput).ok).toBe(true);
  });

  it("still enforces every other hard gate, with a named blocker", () => {
    expect(canClaim(crew({ status: "suspended" }), claimInput).blocker).toBe("not_active");
    expect(canClaim(crew({ coiExpiry: "2026-07-19" }), claimInput).blocker).toBe("no_coi");
    expect(canClaim(crew({ coiExpiry: null }), claimInput).blocker).toBe("no_coi");
    expect(canClaim(crew({ serviceTypes: ["Pier install / removal"] }), claimInput).blocker).toBe("wrong_service");
    expect(canClaim(crew({ workDays: ["Sat"] }), claimInput).blocker).toBe("off_day");
    expect(canClaim(crew({ blockedThatDay: true }), claimInput).blocker).toBe("day_blocked");
    expect(canClaim(crew({ dailyCapacity: 2, assignedThatDay: 2 }), claimInput).blocker).toBe("day_full");
    expect(canClaim(crew({ dailyCapacity: 0 }), claimInput).blocker).toBe("day_full");
  });

  it("requires the crew's OWN rate: none/zero = no_rate, floor-busting = rate_too_high", () => {
    expect(canClaim(crew({ crewRate: null }), claimInput).blocker).toBe("no_rate");
    expect(canClaim(crew({ crewRate: 0 }), claimInput).blocker).toBe("no_rate");
    expect(canClaim(crew({ crewRate: 80 }), claimInput).blocker).toBe("rate_too_high"); // 20% < 25% floor
    expect(canClaim(crew({ crewRate: 75 }), claimInput).ok).toBe(true); // exactly at floor
  });
});

describe("scarcityOffer — customer price bump to clear the floor (Phase C)", () => {
  it("computes the smallest whole-dollar price that clears the floor", () => {
    // rate 80, floor 25% → need ceil(80 / 0.75) = 107; menu 100 → +7
    expect(scarcityOffer(100, 80, 0.25, 0.25)).toEqual({ newPrice: 107, uplift: 7 });
  });

  it("the offered price actually clears the floor", () => {
    const o = scarcityOffer(100, 80, 0.25, 0.25)!;
    expect(marginPct(o.newPrice, 80)).toBeGreaterThanOrEqual(0.25);
  });

  it("no offer when the floor already clears at menu price", () => {
    expect(scarcityOffer(100, 70, 0.25, 0.25)).toBeNull(); // 30% ≥ 25%
    expect(scarcityOffer(100, 75, 0.25, 0.25)).toBeNull(); // exactly at floor
  });

  it("no offer past the surge cap — honest dead end instead", () => {
    // rate 110, floor 25% → need 147 > cap 125 → null
    expect(scarcityOffer(100, 110, 0.25, 0.25)).toBeNull();
    // widen the cap and the same job becomes offerable
    expect(scarcityOffer(100, 110, 0.25, 0.5)).toEqual({ newPrice: 147, uplift: 47 });
  });

  it("no offer on degenerate inputs (no rate, no price, absurd floor)", () => {
    expect(scarcityOffer(100, 0, 0.25, 0.25)).toBeNull();
    expect(scarcityOffer(0, 80, 0.25, 0.25)).toBeNull();
    expect(scarcityOffer(100, 80, 1, 0.25)).toBeNull();
  });

  it("cap of 0 means never offer above menu", () => {
    expect(scarcityOffer(100, 80, 0.25, 0)).toBeNull();
  });
});

describe("S2 storage-package gates — legs are capabilities, custody is guarded", () => {
  const base = crew();
  
  it("a package visit demands EVERY component name", () => {
    const c = { ...base, serviceTypes: ["Boat winterization (shop)", "Boat haul-out (we pick it up)"] };
    expect(isEligible(c, input({ serviceName: "Boat winterization (shop)", componentNames: ["Boat winterization (shop)", "Boat haul-out (we pick it up)", "Winter storage — outdoor"] }))).toBe(false);
    expect(isEligible({ ...c, serviceTypes: [...c.serviceTypes, "Winter storage — outdoor"], garagekeepersExpiry: "2027-01-01", storageTypes: ["outdoor"], storageCapacityFeet: 100, storageCommittedFeet: 0 },
      input({ serviceName: "Boat winterization (shop)", componentNames: ["Boat winterization (shop)", "Boat haul-out (we pick it up)", "Winter storage — outdoor"], storage: { tier: "outdoor", boatFeet: 22 } }))).toBe(true);
  });
  it("storage demands unexpired garagekeepers — a plain COI is not custody insurance", () => {
    const c = { ...base, storageTypes: ["outdoor"], storageCapacityFeet: 100, storageCommittedFeet: 0, garagekeepersExpiry: "2026-01-01" };
    expect(isEligible(c, input({ storage: { tier: "outdoor", boatFeet: 20 } }))).toBe(false);
  });
  it("the feet pool is seasonal: committed feet block the barn", () => {
    const c = { ...base, garagekeepersExpiry: "2027-01-01", storageTypes: ["indoor"], storageCapacityFeet: 100, storageCommittedFeet: 90 };
    expect(isEligible(c, input({ storage: { tier: "indoor", boatFeet: 22 } }))).toBe(false);
    expect(isEligible({ ...c, storageCommittedFeet: 60 }, input({ storage: { tier: "indoor", boatFeet: 22 } }))).toBe(true);
  });
  it("wrong building: outdoor-only crew never gets an indoor stay", () => {
    const c = { ...base, garagekeepersExpiry: "2027-01-01", storageTypes: ["outdoor"], storageCapacityFeet: 100 };
    expect(isEligible(c, input({ storage: { tier: "indoor", boatFeet: 20 } }))).toBe(false);
  });
  it("custody jobs are never claim-board prizes", () => {
    const r = canClaim({ ...base, crewRate: 50 }, { serviceName: base.serviceTypes[0], weekday: "Mon", todayISO: "2026-07-22", menuPrice: 100, marginFloor: 0.25, storage: { tier: "outdoor", boatFeet: 20 } });
    expect(r).toEqual({ ok: false, blocker: "custody_job" });
  });
});

describe("no_custody_crew — a missing barn is a recruiting gap, not a full day", () => {
  it("crews fine except the custody gates → no_custody_crew (never 'day full')", () => {
    const c = crew({ crewRate: 500, serviceTypes: ["Winter storage — outdoor"] }); // no garagekeepers
    const r = decideDispatch(input({ serviceName: "Winter storage — outdoor", menuPrice: 1000, storage: { tier: "outdoor", boatFeet: 22 }, crews: [c] }));
    expect(r.ok).toBe(false);
    expect(r.reasonNoFit).toBe("no_custody_crew");
  });
  it("genuinely blocked day stays all_full_or_blocked even with storage", () => {
    const c = crew({ crewRate: 500, serviceTypes: ["Winter storage — outdoor"], blockedThatDay: true, garagekeepersExpiry: "2099-01-01", storageTypes: ["outdoor"], storageCapacityFeet: 100 });
    const r = decideDispatch(input({ serviceName: "Winter storage — outdoor", menuPrice: 1000, storage: { tier: "outdoor", boatFeet: 22 }, crews: [c] }));
    expect(r.reasonNoFit).toBe("all_full_or_blocked");
  });
});

describe("no_full_coverage_crew — a partial crew on the lake is a gap, not a ghost town", () => {
  it("crew on the lake covering some legs → no_full_coverage_crew, not no_crew_on_lake", () => {
    const partial = crew({ serviceTypes: ["Boat winterization (shop)", "Winter storage — outdoor"], serviceLakes: ["lake-9"] });
    const fullElsewhere = crew({ vendorId: "v2", serviceTypes: ["Boat winterization (shop)", "Winter storage — outdoor", "Shrink wrap"], serviceLakes: ["lake-1"] });
    const r = decideDispatch(input({ serviceName: "Boat winterization (shop)", lakeId: "lake-9", componentNames: ["Boat winterization (shop)", "Winter storage — outdoor", "Shrink wrap"], crews: [partial, fullElsewhere] }));
    expect(r.reasonNoFit).toBe("no_full_coverage_crew");
  });
  it("truly no crew on the lake stays no_crew_on_lake", () => {
    const fullElsewhere = crew({ serviceTypes: ["Boat winterization (shop)", "Shrink wrap"], serviceLakes: ["lake-1"] });
    const r = decideDispatch(input({ serviceName: "Boat winterization (shop)", lakeId: "lake-9", componentNames: ["Boat winterization (shop)", "Shrink wrap"], crews: [fullElsewhere] }));
    expect(r.reasonNoFit).toBe("no_crew_on_lake");
  });
});

describe("gapTakeHome — the fill-in ceiling clears the floor and hides the menu", () => {
  it("rounds DOWN to $5 so margin is always ≥ the floor", () => {
    expect(gapTakeHome(120, 0.3)).toBe(80); // 84 → 80; margin 40/120 = 33%
    expect(gapTakeHome(485, 0.3)).toBe(335); // 339.5 → 335; margin 30.9%
  });
  it("÷0.70 of the offer never reproduces the menu (inversion broken)", () => {
    const t = gapTakeHome(485, 0.3)!;
    expect(t / 0.7).not.toBe(485);
  });
  it("degenerate inputs are null, tiny offers are null", () => {
    expect(gapTakeHome(0, 0.3)).toBeNull();
    expect(gapTakeHome(100, 1)).toBeNull();
    expect(gapTakeHome(25, 0.3)).toBeNull(); // 17.5 → 15 < $20
  });
  it("jitter only ever lowers the ceiling — margin ≥ floor survives any jitter", () => {
    for (const menu of [120, 485, 2067, 95]) {
      for (const jit of [0, 5, 10]) {
        const t = gapTakeHome(menu, 0.3, jit);
        if (t != null) expect((menu - t) / menu).toBeGreaterThanOrEqual(0.3);
      }
    }
    expect(gapTakeHome(120, 0.3, 10)).toBe(70); // 80 − 10
  });
  it("a jittered ceiling under the minimum offer dies instead of shrinking the dust guard", () => {
    expect(gapTakeHome(35, 0.3, 0)).toBe(20); // 24.5 → 20, right at the guard
    expect(gapTakeHome(35, 0.3, 5)).toBeNull(); // 15 < $20
  });
});

describe("gapJitter — deterministic, bounded, and actually varies across jobs", () => {
  it("returns only $0/$5/$10 and the same value for the same id", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `job-${i}-c0ffee`);
    const steps = new Set(ids.map((id) => gapJitter(id)));
    for (const s of steps) expect([0, 5, 10]).toContain(s);
    expect(gapJitter("job-7-c0ffee")).toBe(gapJitter("job-7-c0ffee"));
    // Board and claim hash the same id — and across many jobs the steps
    // genuinely differ, so equal menu prices don't print equal offers.
    expect(steps.size).toBeGreaterThan(1);
  });
});

describe("gapOfferFor — hiking your card can never raise your offer", () => {
  it("anchored below the ceiling when the crew's trailing rate is low", () => {
    // ceiling $335, but their 90d-low rate prices this job at $300 → offer 300×.95=285
    expect(gapOfferFor(335, 300)).toBe(285);
  });
  it("the ceiling clips a fat anchor — the floor is never crossed", () => {
    expect(gapOfferFor(335, 900)).toBe(335);
  });
  it("no anchor → the fuzzed ceiling; dust anchors → null", () => {
    expect(gapOfferFor(335, null)).toBe(335);
    expect(gapOfferFor(335, 15)).toBeNull();
  });
  it("anchorPct and minOffer are dials", () => {
    expect(gapOfferFor(335, 300, 0.9)).toBe(270); // 270 exactly at 90%
    expect(gapOfferFor(335, 60, 0.95, 60)).toBeNull(); // 55 < $60 min
  });
});

// ---------------------------------------------------------------------------

describe("why there is no crew, when there is none", () => {
  /**
   * `pool` filters on lake AND service, so an empty pool says nothing about
   * which of the two is missing — and the banner said "no regular crew on your
   * lake yet" for both. A customer whose mow-and-blow runs every Tuesday on
   * Pretty Lake was told his lake had no crew, because nobody there does pier
   * work yet. The lake was fine. The sentence was not.
   */
  const src = readFileSync(
    fileURLToPath(new URL("../app/book/dispatch.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const grid = readFileSync(
    fileURLToPath(new URL("../components/BookingGrid.tsx", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("reads the files it thinks it reads", () => {
    expect(src).toContain("findingCrew");
    expect(grid).toContain("findingCrew");
  });

  it("the cold-start branch says which gap it is", () => {
    const branch = src.slice(src.indexOf("const routable ="), src.indexOf("maxDailyCap"));
    expect(branch.length, "the cold-start branch moved — this scan is measuring nothing")
      .toBeGreaterThan(200);
    expect(branch).toContain("crewGap");
    // and it decides by asking the LAKE on its own, not by reusing `pool`
    expect(branch).toMatch(/crewGap: anyOnThisLake \? "service" : "lake"/);
  });

  /**
   * THE CALENDAR ASKS THE ROUTER'S QUESTION, NOT A SHORTER ONE.
   *
   * Cold start used to be decided on `status === "active"` alone while every
   * date below it went through canEverDo. One active crew with a lapsed
   * certificate therefore passed the cold-start check and failed all 31 dates:
   * a month of squares titled "Crew at capacity" with nobody at capacity, and
   * the honest "we're finding you a crew" banner suppressed. The gap
   * derivation needs the same rule or it answers "service" about the very crew
   * who does the service.
   */
  it("cold start and the gap it names both use canEverDo", () => {
    const branch = src.slice(src.indexOf("const routable ="), src.indexOf("maxDailyCap"));
    expect((branch.match(/canEverDo\(/g) ?? []).length, "both questions must ask the shared rule")
      .toBeGreaterThanOrEqual(2);
    expect(branch, "standing alone cannot decide either question")
      .not.toMatch(/v\.status === "active"/);
    expect(branch).toMatch(/todayISO: today/);
  });

  it("the banner no longer blames the lake unconditionally", () => {
    // The old sentence must not be reachable when the lake is served.
    const banner = grid.slice(grid.indexOf("findingCrew && ("), grid.indexOf("unavailable && ("));
    expect(banner).toContain('crewGap === "service"');
    expect(banner).toContain("New water for us");
    // the service-gap wording names the service rather than the water
    expect(banner).toContain("crews work your lake");
  });

  it("the availability action carries the reason to the browser", () => {
    const actions = readFileSync(
      fileURLToPath(new URL("../app/book/actions.ts", import.meta.url)), "utf8",
    );
    expect(actions).toContain('crewGap?: "lake" | "service" | null');
  });
});

/**
 * CUSTODY (0145) — the gates run because the SERVICE holds property, not
 * because its price happened to be shaped a certain way.
 *
 * Before 0145 `input.storage` was only ever set inside `if (job.group_id)`,
 * and only when a package leg was priced `seasonal_plus_perdiem`. Three ACTIVE
 * standalone services — Boat storage & winterize, Jet ski winterize & store,
 * Water toy prep & storage — took custody through the single-service path and
 * met none of the three gates. Nothing was ever booked through them only
 * because every vendor on the platform is a fixture dispatch skips.
 */
describe("the custody gates", () => {
  const storer = (over: Partial<CrewCandidate> = {}) =>
    crew({
      serviceTypes: ["Boat storage & winterize"],
      garagekeepersExpiry: "2027-04-01",
      storageTypes: ["indoor"],
      storageCapacityFeet: 100,
      storageCommittedFeet: 0,
      ...over,
    });
  const custody = (over: Partial<DispatchInput> = {}) =>
    input({
      serviceName: "Boat storage & winterize",
      storage: { tier: null, boatFeet: 22 },
      ...over,
    });

  it("refuses a crew with no garagekeepers policy", () => {
    // The whole reason the gate exists: general liability excludes damage to
    // property in the vendor's own care, custody and control.
    const c = storer({ garagekeepersExpiry: null });
    expect(isEligible(c, custody({ crews: [c] }))).toBe(false);
  });

  it("refuses a crew whose garagekeepers policy has expired", () => {
    const c = storer({ garagekeepersExpiry: "2026-07-19" }); // todayISO is 2026-07-20
    expect(isEligible(c, custody({ crews: [c] }))).toBe(false);
  });

  it("checks the insurance even when the visit names no barn type", () => {
    // A standalone custody service declares no indoor/outdoor tier. That must
    // stand the TIER gate down, never the insurance one.
    const c = storer({ garagekeepersExpiry: null, storageTypes: [] });
    expect(isEligible(c, custody({ storage: { tier: null, boatFeet: 22 }, crews: [c] })))
      .toBe(false);
  });

  it("does NOT demand a barn type the visit never asked for", () => {
    // tier null + a crew declaring only outdoor: eligible. Refusing here would
    // shut the gate on the wrong thing and strand every standalone booking.
    const c = storer({ storageTypes: ["outdoor"] });
    expect(isEligible(c, custody({ storage: { tier: null, boatFeet: 22 }, crews: [c] })))
      .toBe(true);
  });

  it("still matches the barn type when the visit DOES name one", () => {
    // The package path derives the tier from band_pricing and must keep
    // putting the boat in the right building.
    const c = storer({ storageTypes: ["outdoor"] });
    expect(isEligible(c, custody({ storage: { tier: "indoor", boatFeet: 22 }, crews: [c] })))
      .toBe(false);
  });

  it("refuses a barn without the feet, tier or no tier", () => {
    const c = storer({ storageCapacityFeet: 30, storageCommittedFeet: 20 }); // 10 free
    expect(isEligible(c, custody({ storage: { tier: null, boatFeet: 22 }, crews: [c] })))
      .toBe(false);
    expect(isEligible(c, custody({ storage: { tier: "indoor", boatFeet: 22 }, crews: [c] })))
      .toBe(false);
  });

  it("leaves non-custody work alone — no policy needed to mow a lawn", () => {
    const c = crew({ serviceTypes: ["Housekeeping"], garagekeepersExpiry: null });
    expect(isEligible(c, input({ crews: [c] }))).toBe(true);
  });
});

describe("0145 wiring: custody is read from the service, not guessed", () => {
  const src = (p: string) =>
    readFileSync(new URL(p, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("dispatch sets the custody gates from takes_custody", () => {
    const d = src("../app/book/dispatch.ts");
    expect(d, "the flag must be selected or it is always undefined")
      .toMatch(/takes_custody/);
    expect(d, "a standalone custody service must set input.storage")
      .toMatch(/if \(!storage && svc\.takes_custody\)/);
  });

  it("keeps the seasonal package path as the way a tier is chosen", () => {
    // The package route has to pick the right BUILDING, so it still reads
    // band_pricing.storage_type. The flag only adds a second way in.
    const d = src("../app/book/dispatch.ts");
    expect(d).toMatch(/seasonal_plus_perdiem/);
    expect(d).toMatch(/storage_type/);
  });

  it("BOTH claim-board callers pass the flag — a gate nobody calls is not a gate", () => {
    // canClaim's first line refuses custody, and for as long as neither caller
    // passed `storage` it was dead code: the board listed a standalone custody
    // job as claimable and the action wrote the claim. The behaviour is proved
    // in src/app/vendor/custody-claim-board.test.ts; this is the cheap scan
    // that catches the field being dropped from either select() later.
    for (const f of ["../app/vendor/open-data.ts", "../app/vendor/open-actions.ts"]) {
      const d = src(f);
      expect(d, `${f}: takes_custody must be SELECTED or it is always undefined`)
        .toMatch(/services\([^)]*takes_custody/);
      expect(d, `${f}: the flag must reach canClaim as storage`)
        .toMatch(/storage:\s*svc\??\.takes_custody/);
    }
  });

  it("never makes the insurance check conditional on the tier", () => {
    const g = src("./dispatch.ts");
    const gate = g.match(/if \(input\.storage\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(gate.length, "the custody block was not found — this scan is stale")
      .toBeGreaterThan(120);
    const ins = gate.indexOf("garagekeepersExpiry");
    const tier = gate.indexOf("input.storage.tier &&");
    expect(ins, "no garagekeepers check inside the custody block").toBeGreaterThan(-1);
    expect(tier, "the tier check should be the conditional one").toBeGreaterThan(-1);
    expect(ins, "insurance must be checked before, and independently of, the tier")
      .toBeLessThan(tier);
  });
});

/**
 * "THAT DAY JUST FILLED UP" WHEN NOTHING IS FULL.
 *
 * `all_full_or_blocked` is the one reason the booking flow acts on: it DELETES
 * the job row and tells the customer to pick another date (book/actions.ts and
 * book/storage/actions.ts). It used to be the catch-all for an empty eligible
 * pool, so a lake whose only crew was still onboarding — or suspended, or
 * carrying a lapsed certificate, or a certificate naming another business —
 * answered "full" on every date, and no date could ever be different. The
 * demand was erased instead of becoming a Finding-a-crew waitlist row.
 *
 * Every case below is the NORMAL day-one state of a lake: onboarding writes
 * trades and lakes and activation refuses to run until both are set, so
 * "invited, capable on paper" is where every real crew must sit.
 */
describe("a crew who cannot be sent is not a full calendar", () => {
  const onLake = (over: Partial<CrewCandidate> = {}) =>
    input({ lakeId: "lake-1", crews: [crew({ serviceLakes: ["lake-1"], ...over })] });

  it("the only crew is still onboarding -> not 'day full'", () => {
    const d = decideDispatch(onLake({ status: "invited" }));
    expect(d.reasonNoFit).toBe("no_routable_crew");
  });

  it("suspended, lapsed, absent and misnamed certificates all read the same way", () => {
    expect(decideDispatch(onLake({ status: "suspended" })).reasonNoFit).toBe("no_routable_crew");
    expect(decideDispatch(onLake({ coiExpiry: "2026-01-01" })).reasonNoFit).toBe("no_routable_crew");
    expect(decideDispatch(onLake({ coiExpiry: null })).reasonNoFit).toBe("no_routable_crew");
    expect(decideDispatch(onLake({ coiNamedInsured: "Somebody Else LLC", company: "Our Crew LLC" })).reasonNoFit)
      .toBe("no_routable_crew");
  });

  it("and no date can rescue any of them — the gates have nothing to do with the day", () => {
    for (const weekday of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      expect(decideDispatch({ ...onLake({ status: "invited" }), weekday }).reasonNoFit).toBe("no_routable_crew");
    }
  });

  /* THE OTHER HALF OF THE BRANCH. Collapse the new guard and this case starts
     passing too — an absence-only assertion above would be satisfied by a
     fixture frozen on the safe side of the condition. A genuinely full day,
     and a day the crew does not work, must still delete the booking. */
  it("a genuinely full day is STILL all_full_or_blocked", () => {
    expect(decideDispatch(onLake({ dailyCapacity: 2, assignedThatDay: 2 })).reasonNoFit)
      .toBe("all_full_or_blocked");
    expect(decideDispatch(onLake({ blockedThatDay: true })).reasonNoFit).toBe("all_full_or_blocked");
    expect(decideDispatch(onLake({ workDays: ["Mon"] })).reasonNoFit).toBe("all_full_or_blocked");
  });

  it("one routable crew who is full still answers 'full' even beside an invited one", () => {
    const d = decideDispatch(input({
      lakeId: "lake-1",
      crews: [
        crew({ vendorId: "green", serviceLakes: ["lake-1"], dailyCapacity: 1, assignedThatDay: 1 }),
        crew({ vendorId: "newbie", serviceLakes: ["lake-1"], status: "invited" }),
      ],
    }));
    expect(d.reasonNoFit).toBe("all_full_or_blocked");
  });

  it("the narrower custody reason still wins ahead of it", () => {
    // A crew who clears standing and insurance but no barn is a recruiting gap
    // with its own name; the new guard must not swallow it.
    const d = decideDispatch(input({
      lakeId: "lake-1",
      storage: { tier: "indoor", boatFeet: 20 },
      crews: [crew({ serviceLakes: ["lake-1"], garagekeepersExpiry: null })],
    }));
    expect(d.reasonNoFit).toBe("no_custody_crew");
  });
});

/**
 * 0174 — THE CREW SETS THE PRICE.
 *
 * Brendon, 23 September 2026: "Lake life doesnt set the pricing, crew does
 * still... crew prices 2 acre yard at $50, we add on 12% to the home owner and
 * take 12% from the Crew." One optional field on the input decides which money
 * model runs, so the first thing these tests pin is that the field being ABSENT
 * changes nothing at all.
 */
describe("0174: the menu path is untouched when no fee is passed", () => {
  /* THE OTHER HALF OF THE BRANCH. Every assertion below this one is about the
     new path; on its own that is an absence-only test, satisfied by a fixture
     frozen on the safe side. This crew prices at 85 against a 100 menu — 15%,
     under the 25% floor — and must STILL be refused, by name. Collapse the
     `input.platformFee ?` ternary in decideDispatch to always-skip and this
     goes red. */
  it("a crew under the floor is still refused, with the same reason", () => {
    const d = decideDispatch(input({ crews: [crew({ vendorId: "pricey", crewRate: 85 })] }));
    expect(d.ok).toBe(false);
    expect(d.reasonNoFit).toBe("below_floor");
  });

  it("and the derived numbers restate what the menu path has always done", () => {
    const d = decideDispatch(input({ menuPrice: 100, crews: [crew({ crewRate: 70 })] }));
    expect(d.result?.crewRate).toBe(70);
    expect(d.result?.customerPrice).toBe(100); // the menu price, billed as-is
    expect(d.result?.crewPayout).toBe(70);     // the crew is paid their rate
    expect(d.result?.platformTake).toBe(30);
    expect(d.result?.margin).toBe(30);
    expect(d.result?.marginPct).toBeCloseTo(0.30);
  });

  it("canClaim still refuses a card the menu cannot pay for", () => {
    expect(canClaim(crew({ crewRate: 85 }), {
      serviceName: "Housekeeping", weekday: "Wed", todayISO: "2026-07-20",
      menuPrice: 100, marginFloor: 0.25,
    })).toEqual({ ok: false, blocker: "rate_too_high" });
  });
});

describe("0174: a crew-priced job is priced FROM the crew's card", () => {
  const fee = { customerPct: 0.12, crewPct: 0.12 };
  /* A crew-priced service HAS no menu price — that is the whole point — so the
     caller has nothing to put in menuPrice at dispatch time and passes 0. */
  const crewPriced = (over: Partial<DispatchInput> = {}) =>
    input({ menuPrice: 0, platformFee: fee, ...over });

  it("his own example: a $50 quote bills $56 and pays the crew $44", () => {
    const d = decideDispatch(crewPriced({ crews: [crew({ vendorId: "v1", crewRate: 50 })] }));
    expect(d.ok).toBe(true);
    expect(d.result?.crewRate).toBe(50);       // what they typed
    expect(d.result?.customerPrice).toBe(56);
    expect(d.result?.crewPayout).toBe(44);     // NOT what they typed
    expect(d.result?.platformTake).toBe(12);
    expect(d.result?.margin).toBe(12);         // margin still means "what LakeLife keeps"
  });

  it("THE THREE TIE on awkward cents — $416 is 465.92 / 366.08 / 99.84", () => {
    // Hand-computed, not recomputed from the code: 416 × 0.12 = 49.92, so the
    // customer pays 465.92, the crew is paid 366.08, and 465.92 − 366.08 = 99.84.
    const d = decideDispatch(crewPriced({ crews: [crew({ crewRate: 416 })] }));
    expect(d.result?.customerPrice).toBe(465.92);
    expect(d.result?.crewPayout).toBe(366.08);
    expect(d.result?.platformTake).toBe(99.84);
    expect((d.result as { customerPrice: number }).customerPrice - (d.result as { crewPayout: number }).crewPayout)
      .toBeCloseTo(99.84, 9);
    expect(d.result?.margin).toBe(d.result?.platformTake);
  });

  it("marginPct is the SAME number on a $50 job and a $2,500 job", () => {
    const cheap = decideDispatch(crewPriced({ crews: [crew({ crewRate: 50 })] }));
    const dear = decideDispatch(crewPriced({ crews: [crew({ crewRate: 2500 })] }));
    expect(cheap.result?.marginPct).toBe(dear.result?.marginPct);
    expect(cheap.result?.marginPct).toBeCloseTo(0.2142857142857143, 12); // (0.12+0.12)/1.12
  });
});

describe("0174: the ranker picks the cheapest crew for the customer", () => {
  const fee = { customerPct: 0.12, crewPct: 0.12 };

  /* THIS TEST BITES. The ids are chosen so the OLD fourth key cannot pass it:
     a crew-priced service has no menu price, marginPct(0, rate) returns 0 for
     everybody, the money key ties, and the winner falls through to the stable
     id tie-break — "aaa", the $70 crew. Restore `marginPct(menuPrice, …)` as
     key 4 and this goes red on the vendorId. */
  const dear = crew({ vendorId: "aaa-dear", crewRate: 70 });
  const cheap = crew({ vendorId: "zzz-cheap", crewRate: 50 });

  it("rankCrews sorts by the crew's quote ASCENDING when a fee is passed", () => {
    expect(rankCrews([dear, cheap], 0, null, null, fee).map((c) => c.vendorId))
      .toEqual(["zzz-cheap", "aaa-dear"]);
  });

  it("decideDispatch hands the job to the $50 crew, not the $70 one", () => {
    const d = decideDispatch(input({ menuPrice: 0, platformFee: fee, crews: [dear, cheap] }));
    expect(d.result?.vendorId).toBe("zzz-cheap");
    expect(d.result?.customerPrice).toBe(56); // and the customer is billed the cheaper bill
  });

  it("without a fee the same pool ranks the old way — the key is not global", () => {
    // Against a real 100 menu the old key still means what it always meant.
    expect(rankCrews([dear, cheap], 100).map((c) => c.vendorId))
      .toEqual(["zzz-cheap", "aaa-dear"]);
    // And with no menu price to compare against, the old key ties and the
    // stable id order wins — which is exactly the arbitrariness the new key
    // replaces, and why this one asserts "aaa" rather than "cheapest".
    expect(rankCrews([dear, cheap], 0).map((c) => c.vendorId))
      .toEqual(["aaa-dear", "zzz-cheap"]);
  });

  it("keys 1-3 still outrank money: a better-scored dear crew wins", () => {
    const good = crew({ vendorId: "good", crewRate: 90, score: 9 });
    const cheapLowScore = crew({ vendorId: "cheap", crewRate: 40, score: 0 });
    expect(rankCrews([cheapLowScore, good], 0, null, null, fee)[0].vendorId).toBe("good");
  });
});

describe("0174: the floor stops being a platform-wide off switch", () => {
  /* At 11% each way LakeLife keeps (0.11+0.11)/1.11 = 19.82% of every bill,
     under the live 0.20 dial. If the floor still ran on this path it would not
     refuse SOME crews — it would refuse EVERY job on the platform, with
     `below_floor`, a reason no screen prints. */
  const thin = { customerPct: 0.11, crewPct: 0.11 };

  it("a job still dispatches at 11/11 under a 0.20 floor", () => {
    const d = decideDispatch(input({
      menuPrice: 0, marginFloor: 0.20, platformFee: thin,
      crews: [crew({ vendorId: "v1", crewRate: 50 })],
    }));
    expect(d.ok).toBe(true);
    expect(d.reasonNoFit).toBeUndefined();
    expect(d.result?.marginPct).toBeLessThan(0.20); // it really is under the dial
  });

  it("the SAME shortfall on the menu path is still refused", () => {
    // 85 against a 100 menu is 15% — under 0.20 — and stays below_floor.
    const d = decideDispatch(input({ menuPrice: 100, marginFloor: 0.20, crews: [crew({ crewRate: 85 })] }));
    expect(d.reasonNoFit).toBe("below_floor");
  });

  it("no crew-priced quote can be 'too high' on the claim board", () => {
    const board = {
      serviceName: "Housekeeping", weekday: "Wed", todayISO: "2026-07-20",
      menuPrice: 0, marginFloor: 0.20,
    };
    expect(canClaim(crew({ crewRate: 500 }), { ...board, platformFee: thin })).toEqual({ ok: true });
    // Every OTHER blocker still bites on the crew-priced path.
    expect(canClaim(crew({ crewRate: 0 }), { ...board, platformFee: thin }))
      .toEqual({ ok: false, blocker: "no_rate" });
    expect(canClaim(crew({ crewRate: 500, status: "invited" }), { ...board, platformFee: thin }))
      .toEqual({ ok: false, blocker: "not_active" });
  });

  it("a $0 card is still not a rate, fee or no fee", () => {
    const d = decideDispatch(input({
      menuPrice: 0, platformFee: { customerPct: 0.12, crewPct: 0.12 },
      crews: [crew({ crewRate: 0 })],
    }));
    expect(d.reasonNoFit).toBe("no_qualifying_rate");
  });
});
