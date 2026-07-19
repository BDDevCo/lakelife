import { describe, it, expect } from "vitest";
import { planVendorDay, nearestNeighborOrder, routeMapUrl, type StopIn } from "./router";

const stop = (id: string, lat: number | null, lng: number | null, lake = "Big Long Lake"): StopIn => ({
  id, lat, lng, lake_name: lake,
});

describe("nearestNeighborOrder", () => {
  it("starts northernmost and walks to the nearest next stop", () => {
    const a = stop("a", 41.63, -85.24); // northernmost
    const b = stop("b", 41.62, -85.24); // closest to a
    const c = stop("c", 41.60, -85.24); // farthest
    expect(nearestNeighborOrder([c, b, a]).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps un-mapped stops at the end in original order", () => {
    const order = nearestNeighborOrder([stop("x", null, null), stop("a", 41.6, -85.2), stop("y", null, null)]);
    expect(order.map((s) => s.id)).toEqual(["a", "x", "y"]);
  });

  it("handles empty and single", () => {
    expect(nearestNeighborOrder([])).toEqual([]);
    expect(nearestNeighborOrder([stop("a", 41.6, -85.2)]).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("planVendorDay", () => {
  it("clusters by lake (largest lake first), then orders within", () => {
    const plan = planVendorDay(
      [
        stop("p1", 41.60, -85.35, "Pretty Lake"),
        stop("b1", 41.63, -85.24, "Big Long Lake"),
        stop("b2", 41.62, -85.24, "Big Long Lake"),
      ],
      10,
    );
    expect(plan.ordered.map((s) => s.id)).toEqual(["b1", "b2", "p1"]);
    expect(plan.overflow).toEqual([]);
  });

  it("caps at daily capacity and reports overflow (never silently drops)", () => {
    const plan = planVendorDay(
      [stop("a", 41.63, -85.24), stop("b", 41.62, -85.24), stop("c", 41.61, -85.24)],
      2,
    );
    expect(plan.ordered).toHaveLength(2);
    expect(plan.overflow).toHaveLength(1);
    expect(plan.overflow[0].id).toBe("c");
  });

  it("capacity 0 means uncapped", () => {
    const plan = planVendorDay([stop("a", 41.6, -85.2), stop("b", 41.61, -85.2)], 0);
    expect(plan.ordered).toHaveLength(2);
  });

  it("estimates drive time from path distance", () => {
    const plan = planVendorDay([stop("a", 41.60, -85.24), stop("b", 41.66, -85.24)], 10);
    expect(plan.driveKm).toBeGreaterThan(5);
    expect(plan.driveMinutes).toBeGreaterThan(plan.driveKm); // 1.6 min/km + hop time
  });
});

describe("routeMapUrl", () => {
  it("builds a google dir link from located stops only", () => {
    const url = routeMapUrl([stop("a", 41.6, -85.2), stop("x", null, null)]);
    expect(url).toBe("https://www.google.com/maps/dir/41.6,-85.2");
  });
  it("null when nothing is located", () => {
    expect(routeMapUrl([stop("x", null, null)])).toBeNull();
  });
});
