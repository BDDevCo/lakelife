import { describe, it, expect } from "vitest";
import {
  priceService,
  boatFeet,
  type ServiceRule,
  type PricingProfile,
} from "./pricing";

// Service rules exactly as seeded in supabase/seed/seed_services.sql,
// which in turn mirror the prototype's pricing constants.
const RULES: Record<string, ServiceRule> = {
  opening: { name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0 },
  winter: { name: "Fall winterization", pricing_model: "flat", base: 485, unit_rate: 0 },
  pier: {
    name: "Pier install / removal",
    pricing_model: "per_section",
    base: 220,
    unit_rate: 48,
    band_pricing: { count_field: "pier_sections" },
  },
  lift: {
    name: "Boat lift set / pull",
    pricing_model: "per_section",
    base: 0,
    unit_rate: 495,
    band_pricing: { count_field: "boat_lifts", min_count: 1 },
  },
  jetski: {
    name: "Jet ski winterize & store",
    pricing_model: "per_section",
    base: 0,
    unit_rate: 350,
    band_pricing: { count_field: "jet_skis" },
  },
  pwclift: {
    name: "PWC lift set / pull",
    pricing_model: "per_section",
    base: 0,
    unit_rate: 165,
    band_pricing: { count_field: "pwc_lifts" },
  },
  boat: {
    name: "Boat storage & winterize",
    pricing_model: "per_foot",
    base: 0,
    unit_rate: 50,
  },
  toys: {
    name: "Water toy prep & storage",
    pricing_model: "flat",
    base: 120,
    unit_rate: 0,
    band_pricing: {
      add: [
        { field: "toy_lifts", rate: 60 },
        { field: "toys_count", rate: 15 },
      ],
    },
  },
  mow: {
    name: "Lawn mowing & trim",
    pricing_model: "band",
    base: 0,
    unit_rate: 0,
    band_pricing: { small: 65, medium: 85, large: 110 },
  },
  clean: {
    name: "Housekeeping",
    pricing_model: "per_sqft_band",
    base: 0,
    unit_rate: 0,
    band_pricing: {
      tiers: [
        { max: 1800, price: 80 },
        { max: 2800, price: 95 },
        { max: null, price: 120 },
      ],
    },
  },
};

// The prototype's default property.
const PROFILE: PricingProfile = {
  sqft: 2400,
  beds: 4,
  baths: 3,
  pier_sections: 10,
  boat_lifts: 1,
  toy_lifts: 1,
  jet_skis: 2,
  pwc_lifts: 1,
  lawn_band: "medium",
  boats: [{ type: "Pontoon", length_ft: 24 }],
  toys: [{ name: "Kayak" }, { name: "Kayak" }, { name: "Paddleboard" }, { name: "Water trampoline" }],
};

describe("flat pricing", () => {
  it("spring opening is a fixed price", () => {
    expect(priceService(RULES.opening, PROFILE)).toBe(430);
  });
  it("fall winterization is a fixed price", () => {
    expect(priceService(RULES.winter, PROFILE)).toBe(485);
  });
});

describe("pier — per_section: base + rate × sections", () => {
  it("10 sections = 220 + 48×10 = 700", () => {
    expect(priceService(RULES.pier, PROFILE)).toBe(700);
  });
  it("12 sections = 220 + 48×12 = 796 (the vendor-flag reprice)", () => {
    expect(priceService(RULES.pier, { ...PROFILE, pier_sections: 12 })).toBe(796);
  });
  it("0 sections falls back to just the base", () => {
    expect(priceService(RULES.pier, { ...PROFILE, pier_sections: 0 })).toBe(220);
  });
});

describe("boat — per_foot: rate × total feet", () => {
  it("one 24ft boat = 50 × 24 = 1200", () => {
    expect(priceService(RULES.boat, PROFILE)).toBe(1200);
  });
  it("adds up multiple boats bow to stern", () => {
    const p = { ...PROFILE, boats: [{ length_ft: 24 }, { length_ft: 16 }] };
    expect(boatFeet(p)).toBe(40);
    expect(priceService(RULES.boat, p)).toBe(2000);
  });
  it("no boats = $0", () => {
    expect(priceService(RULES.boat, { ...PROFILE, boats: [] })).toBe(0);
  });
});

describe("lawn — band pricing", () => {
  it("small = 65", () => {
    expect(priceService(RULES.mow, { ...PROFILE, lawn_band: "small" })).toBe(65);
  });
  it("medium = 85", () => {
    expect(priceService(RULES.mow, { ...PROFILE, lawn_band: "medium" })).toBe(85);
  });
  it("large = 110", () => {
    expect(priceService(RULES.mow, { ...PROFILE, lawn_band: "large" })).toBe(110);
  });
});

describe("housekeeping — per_sqft_band", () => {
  it("under 1800 sq ft = 80", () => {
    expect(priceService(RULES.clean, { ...PROFILE, sqft: 1500 })).toBe(80);
  });
  it("1800–2799 sq ft = 95", () => {
    expect(priceService(RULES.clean, { ...PROFILE, sqft: 2400 })).toBe(95);
  });
  it("2800+ sq ft = 120", () => {
    expect(priceService(RULES.clean, { ...PROFILE, sqft: 3200 })).toBe(120);
  });
  it("exact boundary 1800 goes to the next tier (95)", () => {
    expect(priceService(RULES.clean, { ...PROFILE, sqft: 1800 })).toBe(95);
  });
});

describe("boat lift — per_section on lifts, floored at 1", () => {
  it("1 lift = 495", () => {
    expect(priceService(RULES.lift, PROFILE)).toBe(495);
  });
  it("2 lifts = 990", () => {
    expect(priceService(RULES.lift, { ...PROFILE, boat_lifts: 2 })).toBe(990);
  });
  it("0 lifts still floors to 1 × 495", () => {
    expect(priceService(RULES.lift, { ...PROFILE, boat_lifts: 0 })).toBe(495);
  });
});

describe("jet skis — per-unit winterize & store", () => {
  it("2 jet skis = 350 × 2 = 700", () => {
    expect(priceService(RULES.jetski, PROFILE)).toBe(700);
  });
  it("no jet skis = $0", () => {
    expect(priceService(RULES.jetski, { ...PROFILE, jet_skis: 0 })).toBe(0);
  });
});

describe("PWC lifts — per-unit set / pull", () => {
  it("1 PWC lift = 165", () => {
    expect(priceService(RULES.pwclift, PROFILE)).toBe(165);
  });
  it("3 PWC lifts = 495", () => {
    expect(priceService(RULES.pwclift, { ...PROFILE, pwc_lifts: 3 })).toBe(495);
  });
});

describe("water toys — flat base + per-lift + per-toy", () => {
  it("120 + 60×1 lift + 15×4 toys = 240", () => {
    expect(priceService(RULES.toys, PROFILE)).toBe(240);
  });
  it("no lifts, no toys = base 120", () => {
    expect(priceService(RULES.toys, { ...PROFILE, toy_lifts: 0, toys: [] })).toBe(120);
  });
});

describe("seasonal_plus_perdiem — the storage seasonal minimum", () => {
  const rule = (base: number, unit: number): ServiceRule =>
    ({ name: "Winter storage — outdoor", pricing_model: "seasonal_plus_perdiem", base, unit_rate: unit });
  it("scales by total fleet feet, like per_foot (24-ft pontoon fixture)", () => {
    expect(priceService(rule(0, 43), PROFILE)).toBe(1032); // 43 × 24
  });
  it("multi-boat households pay for every foot in the barn", () => {
    expect(priceService(rule(0, 43), { ...PROFILE, boats: [{ length_ft: 22 }, { length_ft: 14 }] })).toBe(1548);
  });
  it("a base-only rule behaves flat (no boats → base)", () => {
    expect(priceService(rule(120, 0), { ...PROFILE, boats: [] })).toBe(120);
  });
  it("never negative on garbage", () => {
    expect(priceService(rule(-50, 0), { ...PROFILE, boats: [] })).toBe(0);
  });
});

describe("per_engine_hp_tiers — engines refine the price, per-foot still matters", () => {
  const winterize: ServiceRule = {
    name: "Boat winterization (shop)", pricing_model: "per_foot", base: 0, unit_rate: 12,
    band_pricing: { per_engine_hp_tiers: [{ max: 150, price: 60 }, { max: null, price: 120 }] },
  };
  it("per-foot base + the boat's HP tier", () => {
    const p = { ...PROFILE, boats: [{ length_ft: 24, engine_type: "outboard", engine_hp: 115, engines: 1 }] };
    expect(priceService(winterize, p)).toBe(348); // 12×24 + 60
  });
  it("twins pay the tier twice; big HP hits the top tier", () => {
    const p = { ...PROFILE, boats: [{ length_ft: 28, engine_type: "sterndrive", engine_hp: 300, engines: 2 }] };
    expect(priceService(winterize, p)).toBe(576); // 12×28 + 2×120
  });
  it("sailboats (engine 'none') pay feet only", () => {
    const p = { ...PROFILE, boats: [{ length_ft: 20, engine_type: "none", engine_hp: 0, engines: 1 }] };
    expect(priceService(winterize, p)).toBe(240);
  });
  it("legacy boats with unknown engine price at the cheapest tier — an honest floor", () => {
    const p = { ...PROFILE, boats: [{ length_ft: 24 }] };
    expect(priceService(winterize, p)).toBe(348); // 288 + first tier 60
  });
  it("rules without the param are untouched", () => {
    const bare: ServiceRule = { name: "x", pricing_model: "per_foot", base: 0, unit_rate: 12 };
    const p = { ...PROFILE, boats: [{ length_ft: 24, engine_type: "inboard", engine_hp: 450, engines: 2 }] };
    expect(priceService(bare, p)).toBe(288);
  });
});
