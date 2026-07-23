import { describe, it, expect } from "vitest";
import { validateSelection, defaultSelection, anchorServiceId, anchorFromServices, type PackageView, type PackageComponentView } from "./packages";

const C = (over: Partial<PackageComponentView>): PackageComponentView => ({
  serviceId: over.serviceId ?? "svc",
  name: over.name ?? "Component",
  phase: over.phase ?? "fall",
  required: over.required ?? false,
  defaultOn: over.defaultOn ?? false,
  kind: over.kind ?? "component",
  pricingModel: over.pricingModel ?? "flat",
  price: over.price ?? 0,
  isStorageTier: over.isStorageTier ?? false,
});

// The we_haul recipe as seeded (prices = a 22' tritoon's illustrative quote).
const WE_HAUL: PackageView = {
  id: "p2", code: "we_haul", name: "We pick it up", description: null,
  components: [
    C({ serviceId: "haul", name: "Boat haul-out (we pick it up)", phase: "fall", required: true, price: 285 }),
    C({ serviceId: "wtr", name: "Boat winterization (shop)", phase: "fall", required: true, pricingModel: "per_foot", price: 264 }),
    C({ serviceId: "ret", name: "Boat return & splash", phase: "fall", price: 285 }),
    C({ serviceId: "out", name: "Winter storage — outdoor", phase: "fall", defaultOn: true, pricingModel: "seasonal_plus_perdiem", price: 946, isStorageTier: true }),
    C({ serviceId: "ind", name: "Winter storage — indoor", phase: "fall", pricingModel: "seasonal_plus_perdiem", price: 1408, isStorageTier: true }),
    C({ serviceId: "wrap", name: "Shrink wrap", phase: "fall", defaultOn: true, kind: "addon", pricingModel: "per_foot", price: 572 }),
    C({ serviceId: "haul", name: "Boat haul-out (we pick it up)", phase: "spring", price: 285 }),
    C({ serviceId: "dew", name: "Spring de-winterize & test run", phase: "spring", defaultOn: true, pricingModel: "per_foot", price: 198 }),
    C({ serviceId: "ret", name: "Boat return & splash", phase: "spring", defaultOn: true, price: 285 }),
  ],
};

const STORAGE_ONLY: PackageView = {
  id: "p3", code: "storage_only", name: "Winter storage only", description: null,
  components: [
    C({ serviceId: "out", name: "Winter storage — outdoor", phase: "fall", defaultOn: true, pricingModel: "seasonal_plus_perdiem", price: 946, isStorageTier: true }),
    C({ serviceId: "ind", name: "Winter storage — indoor", phase: "fall", pricingModel: "seasonal_plus_perdiem", price: 1408, isStorageTier: true }),
    C({ serviceId: "ret", name: "Boat return & splash", phase: "spring", price: 285 }),
  ],
};

describe("validateSelection — the recipe rules the wizard can't break", () => {
  it("the default valet quote: haul + winterize + wrap + outdoor + spring dewinterize + splash", () => {
    const r = validateSelection(WE_HAUL, defaultSelection(WE_HAUL));
    expect(r.ok).toBe(true);
    expect(r.fallTotal).toBe(285 + 264 + 946 + 572);
    expect(r.springTotal).toBe(198 + 285);
    expect(r.total).toBe(r.fallTotal + r.springTotal);
    expect(r.storageTierId).toBe("out");
  });
  it("two storage tiers is never legal", () => {
    const r = validateSelection(WE_HAUL, ["out|fall", "ind|fall"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/one storage option/);
  });
  it("we_haul without storage must bring the boat home in fall", () => {
    const r = validateSelection(WE_HAUL, []); // requireds only, no tier, no fall return
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/comes home/);
  });
  it("the home-storage variant: fall return instead of a tier (owner's scenario A)", () => {
    const r = validateSelection(WE_HAUL, ["ret|fall", "haul|spring", "dew|spring", "ret|spring"]);
    expect(r.ok).toBe(true);
    expect(r.storageTierId).toBeNull();
    expect(r.fallTotal).toBe(285 + 264 + 285);
    expect(r.springTotal).toBe(285 + 198 + 285);
  });
  it("storing AND fall-returning is contradictory", () => {
    const r = validateSelection(WE_HAUL, ["out|fall", "ret|fall"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boat stays/);
  });
  it("storage_only demands exactly one tier", () => {
    expect(validateSelection(STORAGE_ONLY, []).ok).toBe(false);
    expect(validateSelection(STORAGE_ONLY, ["ind|fall"]).ok).toBe(true);
  });
  it("bare serviceIds select the service in every phase it appears (haul fall+spring)", () => {
    const r = validateSelection(WE_HAUL, ["ret"]); // ret exists fall AND spring
    // fall return selected → contradiction rules apply only vs storage (none picked)
    expect(r.ok).toBe(true);
    expect(r.fall).toContain("ret");
    expect(r.spring).toContain("ret");
  });
});

describe("anchorServiceId — the visit's primary service is deterministic", () => {
  it("winterize (per_foot component) anchors the fall visit, not storage or haul", () => {
    expect(anchorServiceId(WE_HAUL, "fall", ["haul", "wtr", "out", "wrap"])).toBe("wtr");
  });
  it("storage anchors when it's the only non-transport work", () => {
    expect(anchorServiceId(STORAGE_ONLY, "fall", ["ind"])).toBe("ind");
  });
  it("no components in phase → null", () => {
    expect(anchorServiceId(STORAGE_ONLY, "spring", ["ind"])).toBeNull();
  });
});

describe("anchorFromServices — the spring birth picks the same kind of anchor", () => {
  it("de-winterize (per_foot component) beats transport and add-ons", () => {
    expect(anchorFromServices([
      { id: "ret", kind: "component", pricing_model: "flat" },
      { id: "dew", kind: "component", pricing_model: "per_foot" },
      { id: "bat", kind: "addon", pricing_model: "flat" },
    ])).toBe("dew");
  });
  it("transport-only spring anchors on the transport leg", () => {
    expect(anchorFromServices([{ id: "ret", kind: "component", pricing_model: "flat" }])).toBe("ret");
  });
  it("empty → null", () => {
    expect(anchorFromServices([])).toBeNull();
  });
});
