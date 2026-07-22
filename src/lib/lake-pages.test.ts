import { describe, it, expect } from "vitest";
import { fromPrice, slugify } from "./lake-pages";

describe("fromPrice — honest public menu floors", () => {
  it("flat prices are exact, not 'from'", () => {
    expect(fromPrice({ pricing_model: "flat", base: 430, unit_rate: 0, band_pricing: null })).toEqual({ amount: 430, unit: null, from: false });
  });
  it("per-unit models name their unit", () => {
    expect(fromPrice({ pricing_model: "per_section", base: 0, unit_rate: 99.5, band_pricing: null })).toEqual({ amount: 99.5, unit: "per pier section", from: true });
    expect(fromPrice({ pricing_model: "per_foot", base: 0, unit_rate: 12, band_pricing: null })).toEqual({ amount: 12, unit: "per boat foot", from: true });
  });
  it("bands quote the smallest real tier", () => {
    expect(fromPrice({ pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 } })).toEqual({ amount: 65, unit: null, from: true });
    expect(fromPrice({ pricing_model: "per_sqft_band", base: 0, unit_rate: 0, band_pricing: { tiers: [{ max: 1800, price: 95 }, { max: null, price: 149 }] } })).toEqual({ amount: 95, unit: null, from: true });
  });
  it("zero/garbage pricing renders nothing rather than lying", () => {
    expect(fromPrice({ pricing_model: "flat", base: 0, unit_rate: 0, band_pricing: null })).toBeNull();
    expect(fromPrice({ pricing_model: "band", base: 0, unit_rate: 0, band_pricing: null })).toBeNull();
  });
});

describe("slugify — must match the SQL backfill", () => {
  it("standard names", () => {
    expect(slugify("Big Long Lake")).toBe("big-long-lake");
    expect(slugify("  Pretty Lake ")).toBe("pretty-lake");
    expect(slugify("Lake o' the Woods")).toBe("lake-o-the-woods");
  });
});

describe("fromPrice — unit names follow the service's count_field", () => {
  it("a per_section service counting boat lifts says 'per lift'", () => {
    expect(fromPrice({ pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts" } as never })).toEqual({ amount: 495, unit: "per lift", from: true });
  });
});
