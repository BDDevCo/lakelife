import { describe, it, expect } from "vitest";
import {
  planFleetDay,
  planTruckRoute,
  fleetJobCap,
  fleetMinuteBudget,
  fitsTimeBudget,
  DEFAULT_JOB_MINUTES,
  type TruckIn,
  type FleetStop,
} from "./fleet";

// Same haversine formula as fleet.ts's private kmBetween — replicated here
// so a couple of tests can assert an EXACT driveKm, not just "bigger than."
const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const mkTruck = (over: Partial<TruckIn> = {}): TruckIn => ({
  id: over.id ?? "t1",
  name: over.name ?? "Truck 1",
  phone: over.phone ?? null,
  capacity: over.capacity ?? 4,
  workStart: over.workStart ?? 7,
  workEnd: over.workEnd ?? 19,
  baseLat: over.baseLat ?? null,
  baseLng: over.baseLng ?? null,
  ...over,
});

const mkStop = (over: Partial<FleetStop> & { id: string }): FleetStop => ({
  lat: over.lat ?? null,
  lng: over.lng ?? null,
  lake_name: over.lake_name ?? null,
  estMinutes: over.estMinutes ?? 30,
  ...over,
});

describe("planFleetDay — partition across trucks", () => {
  it("two lakes x two trucks: each truck gets ONE whole lake, no criss-cross", () => {
    const bigLong = [
      mkStop({ id: "a1", lat: 41.60, lng: -85.24, lake_name: "Big Long Lake" }),
      mkStop({ id: "a2", lat: 41.61, lng: -85.24, lake_name: "Big Long Lake" }),
      mkStop({ id: "a3", lat: 41.62, lng: -85.24, lake_name: "Big Long Lake" }),
    ];
    const pretty = [
      mkStop({ id: "b1", lat: 41.50, lng: -85.35, lake_name: "Pretty Lake" }),
      mkStop({ id: "b2", lat: 41.51, lng: -85.35, lake_name: "Pretty Lake" }),
      mkStop({ id: "b3", lat: 41.52, lng: -85.35, lake_name: "Pretty Lake" }),
    ];
    const trucks = [mkTruck({ id: "t1", capacity: 3 }), mkTruck({ id: "t2", capacity: 3 })];
    const plan = planFleetDay([...bigLong, ...pretty], trucks, null);

    expect(plan.trucks).toHaveLength(2);
    expect(plan.overflow).toEqual([]);
    // Truck 1 (most remaining room on ties, so first in creation order) took
    // the first cluster whole; truck 2 took the second cluster whole.
    expect(plan.trucks[0].truck.id).toBe("t1");
    expect(plan.trucks[0].ordered.every((s) => s.lake_name === "Big Long Lake")).toBe(true);
    expect(plan.trucks[0].ordered).toHaveLength(3);
    expect(plan.trucks[1].truck.id).toBe("t2");
    expect(plan.trucks[1].ordered.every((s) => s.lake_name === "Pretty Lake")).toBe(true);
    expect(plan.trucks[1].ordered).toHaveLength(3);
  });

  it("a 7-stop lake with two 4-capacity trucks splits CONTIGUOUSLY along drive order", () => {
    // Monotonic north->south line so nearest-neighbor order is s1..s7.
    const stops = Array.from({ length: 7 }, (_, i) =>
      mkStop({ id: `s${i + 1}`, lat: 41.70 - i * 0.01, lng: -85.24, lake_name: "Big Long Lake" }),
    );
    const trucks = [mkTruck({ id: "t1", capacity: 4 }), mkTruck({ id: "t2", capacity: 4 })];
    const plan = planFleetDay(stops, trucks, null);

    expect(plan.overflow).toEqual([]);
    expect(plan.trucks[0].truck.id).toBe("t1");
    expect(plan.trucks[0].ordered.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(plan.trucks[1].truck.id).toBe("t2");
    expect(plan.trucks[1].ordered.map((s) => s.id)).toEqual(["s5", "s6", "s7"]);
  });

  it("overflow only happens once ALL trucks are full, and preserves the un-taken stops", () => {
    const stops = Array.from({ length: 10 }, (_, i) =>
      mkStop({ id: `s${i + 1}`, lat: 41.80 - i * 0.01, lng: -85.24, lake_name: "Big Long Lake" }),
    );
    const trucks = [mkTruck({ id: "t1", capacity: 4 }), mkTruck({ id: "t2", capacity: 4 })];
    const plan = planFleetDay(stops, trucks, null);

    // Both trucks fully loaded (4 + 4 = 8) before anything overflows.
    expect(plan.trucks[0].ordered.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(plan.trucks[1].ordered.map((s) => s.id)).toEqual(["s5", "s6", "s7", "s8"]);
    // The 2 stops beyond total fleet capacity surface as overflow, in order.
    expect(plan.overflow.map((s) => s.id)).toEqual(["s9", "s10"]);
  });
});

describe("planFleetDay — determinism", () => {
  it("same inputs twice -> identical truck assignments, stop order, and drive stats", () => {
    const stops = Array.from({ length: 10 }, (_, i) =>
      mkStop({ id: `s${i + 1}`, lat: 41.80 - i * 0.01, lng: -85.24, lake_name: "Big Long Lake" }),
    );
    const trucks = [mkTruck({ id: "t1", capacity: 4 }), mkTruck({ id: "t2", capacity: 4 })];

    const summarize = (p: ReturnType<typeof planFleetDay>) => ({
      trucks: p.trucks.map((tp) => ({ id: tp.truck.id, ids: tp.ordered.map((s) => s.id), driveKm: tp.driveKm })),
      overflow: p.overflow.map((s) => s.id),
      totalKm: p.totalKm,
    });

    const run1 = planFleetDay(stops, trucks, null);
    const run2 = planFleetDay(stops, trucks, null);
    expect(summarize(run1)).toEqual(summarize(run2));
  });
});

describe("planTruckRoute — base-seeded ordering", () => {
  const A = mkStop({ id: "A", lat: 41.70, lng: -85.30 }); // northernmost
  const B = mkStop({ id: "B", lat: 41.55, lng: -85.30 }); // middle
  const C = mkStop({ id: "C", lat: 41.40, lng: -85.30 }); // southernmost, near the base

  it("picks the stop NEAREST THE BASE first, even when a v1 (no-base) plan would start elsewhere", () => {
    const truckWithBase = mkTruck({ baseLat: 41.41, baseLng: -85.30 }); // ~1.1km from C
    const withBase = planTruckRoute(truckWithBase, [A, B, C], null);
    expect(withBase.ordered.map((s) => s.id)).toEqual(["C", "B", "A"]);

    // Contrast: no base at all falls back to v1 (nearest-neighbor from the
    // NORTHERNMOST stop) — proof the northernmost-seeded order would differ.
    const truckNoBase = mkTruck({ baseLat: null, baseLng: null });
    const noBase = planTruckRoute(truckNoBase, [A, B, C], null);
    expect(noBase.ordered.map((s) => s.id)).toEqual(["A", "B", "C"]);
  });

  it("driveKm includes the base->first and last->base legs (v1 plan of the same stops does not)", () => {
    const base = { lat: 41.50, lng: -85.30 };
    const stop1 = mkStop({ id: "stop1", lat: 41.55, lng: -85.30 });
    const stop2 = mkStop({ id: "stop2", lat: 41.60, lng: -85.30 });

    const truckWithBase = mkTruck({ baseLat: base.lat, baseLng: base.lng });
    const withBase = planTruckRoute(truckWithBase, [stop1, stop2], null);
    expect(withBase.ordered.map((s) => s.id)).toEqual(["stop1", "stop2"]); // nearest-to-base first

    const expectedRaw =
      haversineKm(base.lat, base.lng, stop1.lat!, stop1.lng!) +
      haversineKm(stop1.lat!, stop1.lng!, stop2.lat!, stop2.lng!) +
      haversineKm(stop2.lat!, stop2.lng!, base.lat, base.lng);
    expect(withBase.driveKm).toBe(Math.round(expectedRaw * 10) / 10);

    const truckNoBase = mkTruck({ baseLat: null, baseLng: null });
    const noBase = planTruckRoute(truckNoBase, [stop1, stop2], null);
    // No base legs at all -> strictly less distance for the identical pair of stops.
    expect(noBase.driveKm).toBeLessThan(withBase.driveKm);
  });

  it("stops without coordinates always go last (base branch and v1-fallback branch alike)", () => {
    const located1 = mkStop({ id: "loc1", lat: 41.55, lng: -85.30 });
    const located2 = mkStop({ id: "loc2", lat: 41.60, lng: -85.30 });
    const unlocated = mkStop({ id: "nowhere", lat: null, lng: null });

    const truckWithBase = mkTruck({ baseLat: 41.50, baseLng: -85.30 });
    const withBase = planTruckRoute(truckWithBase, [unlocated, located1, located2], null);
    expect(withBase.ordered[withBase.ordered.length - 1].id).toBe("nowhere");
    expect(withBase.ordered.map((s) => s.id)).toEqual(["loc1", "loc2", "nowhere"]);

    const truckNoBase = mkTruck({ baseLat: null, baseLng: null });
    const noBase = planTruckRoute(truckNoBase, [unlocated, located1, located2], null);
    expect(noBase.ordered[noBase.ordered.length - 1].id).toBe("nowhere");
  });

  it("fitsHours flips false once Sigma est_minutes + drive busts the window, stays true just under it", () => {
    // Single stop -> zero drive legs (no base, no pairs), so workMinutes ==
    // estMinutes exactly. Window = max(60, (9-8)*60) = 60 minutes.
    const truck = mkTruck({ workStart: 8, workEnd: 9, baseLat: null, baseLng: null });

    const underWindow = planTruckRoute(truck, [mkStop({ id: "s1", lat: 41.6, lng: -85.2, estMinutes: 59 })], null);
    expect(underWindow.workMinutes).toBe(59);
    expect(underWindow.fitsHours).toBe(true);

    const overWindow = planTruckRoute(truck, [mkStop({ id: "s1", lat: 41.6, lng: -85.2, estMinutes: 61 })], null);
    expect(overWindow.workMinutes).toBe(61);
    expect(overWindow.fitsHours).toBe(false);
  });

  it("estMinutes 0 or negative falls back to DEFAULT_JOB_MINUTES", () => {
    const truck = mkTruck({ baseLat: null, baseLng: null });

    const zero = planTruckRoute(truck, [mkStop({ id: "s1", lat: 41.6, lng: -85.2, estMinutes: 0 })], null);
    expect(zero.workMinutes).toBe(DEFAULT_JOB_MINUTES);

    const negative = planTruckRoute(truck, [mkStop({ id: "s1", lat: 41.6, lng: -85.2, estMinutes: -30 })], null);
    expect(negative.workMinutes).toBe(DEFAULT_JOB_MINUTES);
  });
});

describe("fleetJobCap", () => {
  it("no units -> legacy vendors.daily_capacity", () => {
    expect(fleetJobCap([], 5)).toBe(5);
  });
  it("units present -> sum of capacities (legacy capacity ignored), negatives clamped to 0", () => {
    expect(fleetJobCap([{ capacity: 5 }, { capacity: -3 }, { capacity: 2 }], 999)).toBe(7);
  });
});

describe("fleetMinuteBudget", () => {
  it("no units -> null (time-budget check disabled, legacy behavior)", () => {
    expect(fleetMinuteBudget([])).toBeNull();
  });
  it("units present -> sum of (end - start) x 60", () => {
    expect(
      fleetMinuteBudget([
        { workStart: 8, workEnd: 17 }, // 9h -> 540 min
        { workStart: 9, workEnd: 12 }, // 3h -> 180 min
      ]),
    ).toBe(720);
  });
  it("a negative span clamps to 0 rather than subtracting from the budget", () => {
    expect(fleetMinuteBudget([{ workStart: 10, workEnd: 8 }])).toBe(0);
  });
});

describe("fitsTimeBudget", () => {
  it("null budget is ALWAYS true — the legacy invariant, no trucks means the check is off", () => {
    expect(fitsTimeBudget(999_999, 999_999, null)).toBe(true);
    expect(fitsTimeBudget(0, 0, null)).toBe(true);
  });

  it("applies the drive-overhead share on top of assigned + new job minutes", () => {
    // default overhead share 0.15: 100 * 1.15 = 115 exactly at a 115 budget.
    expect(fitsTimeBudget(50, 50, 115)).toBe(true);
    // custom overhead share dials change the outcome for the same minutes.
    expect(fitsTimeBudget(50, 50, 100, 0)).toBe(true); // no overhead -> exactly fits
    expect(fitsTimeBudget(50, 50, 100, 0.5)).toBe(false); // 100 * 1.5 = 150 > 100
  });

  it("boundary exactly-equal passes; one minute over fails", () => {
    expect(fitsTimeBudget(50, 50, 115)).toBe(true); // 100 * 1.15 = 115.0 <= 115
    expect(fitsTimeBudget(50, 51, 115)).toBe(false); // 101 * 1.15 = 116.15 > 115
  });
});

describe("planFleetDay — zero trucks", () => {
  it("no trucks at all -> everything in overflow, no crash", () => {
    const stops = [
      mkStop({ id: "s1", lat: 41.6, lng: -85.2, lake_name: "Big Long Lake" }),
      mkStop({ id: "s2", lat: 41.61, lng: -85.2, lake_name: "Big Long Lake" }),
    ];
    const plan = planFleetDay(stops, [], null);
    expect(plan.trucks).toEqual([]);
    expect(plan.overflow).toEqual(stops);
    expect(plan.totalKm).toBe(0);
  });

  it("trucks exist but all have zero capacity -> same as no trucks (none are 'active')", () => {
    const stops = [mkStop({ id: "s1", lat: 41.6, lng: -85.2, lake_name: "Big Long Lake" })];
    const trucks = [mkTruck({ id: "t1", capacity: 0 }), mkTruck({ id: "t2", capacity: 0 })];
    const plan = planFleetDay(stops, trucks, null);
    expect(plan.trucks).toEqual([]);
    expect(plan.overflow).toEqual(stops);
    expect(plan.totalKm).toBe(0);
  });
});
