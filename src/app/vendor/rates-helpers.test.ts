import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  unitNounFor,
  tierKey,
  tierLabel,
  coerceRate,
  buildRateForm,
  computeRateRow,
  RATE_CAP,
  type RateService,
} from "./rates-helpers";

describe("unitNounFor", () => {
  it("maps counted fields to human nouns", () => {
    expect(unitNounFor("per_section", "pier_sections")).toBe("pier section");
    expect(unitNounFor("per_section", "boat_lifts")).toBe("boat lift");
    expect(unitNounFor("per_section", "jet_skis")).toBe("jet ski");
    expect(unitNounFor("per_section", "pwc_lifts")).toBe("PWC lift");
  });
  it("per_foot is always feet, unknown falls back to unit", () => {
    expect(unitNounFor("per_foot")).toBe("foot");
    expect(unitNounFor("per_section", "mystery")).toBe("unit");
    expect(unitNounFor("per_section", null)).toBe("unit");
  });
});

describe("tierKey / tierLabel", () => {
  it("keys the open-ended tier as 'top'", () => {
    expect(tierKey(1800)).toBe("1800");
    expect(tierKey(null)).toBe("top");
  });
  it("labels sqft bands readably", () => {
    expect(tierLabel(null, 1800)).toBe("Up to 1,800 sq ft");
    expect(tierLabel(1800, 2800)).toBe("1,800–2,800 sq ft");
    expect(tierLabel(2800, null)).toBe("2,800+ sq ft");
    expect(tierLabel(null, null)).toBe("Any size");
  });
});

describe("coerceRate", () => {
  it("accepts empty as 0", () => {
    expect(coerceRate("")).toEqual({ ok: true, value: 0 });
    expect(coerceRate(null)).toEqual({ ok: true, value: 0 });
    expect(coerceRate(undefined)).toEqual({ ok: true, value: 0 });
  });
  it("rounds to the cent", () => {
    expect(coerceRate("48.005").value).toBeCloseTo(48.01, 5);
    expect(coerceRate(220).value).toBe(220);
  });
  it("rejects negatives, non-finite, and over-cap", () => {
    expect(coerceRate("-1").ok).toBe(false);
    expect(coerceRate("abc").ok).toBe(false);
    expect(coerceRate(RATE_CAP + 1).ok).toBe(false);
  });
});

describe("buildRateForm", () => {
  it("flat: one base field, no unit noun", () => {
    const form = buildRateForm({ pricing_model: "flat", band_pricing: null }, null);
    expect(form.unitNoun).toBeNull();
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]).toMatchObject({ key: "base", kind: "base", value: null });
  });

  it("per_section: base + unit, noun from count_field, echoes existing values", () => {
    const svc: RateService = { pricing_model: "per_section", band_pricing: { count_field: "boat_lifts", min_count: 1 } };
    const form = buildRateForm(svc, { base: 0, unit_rate: 400, band_pricing: null });
    expect(form.unitNoun).toBe("boat lift");
    expect(form.fields.map((f) => f.kind)).toEqual(["base", "unit"]);
    expect(form.fields[1].value).toBe(400);
  });

  it("band: small/medium/large from existing band_pricing", () => {
    const svc: RateService = { pricing_model: "band", band_pricing: { small: 65, medium: 85, large: 110 } };
    const form = buildRateForm(svc, { base: 0, unit_rate: 0, band_pricing: { small: 40, medium: 55, large: 70 } });
    expect(form.fields.map((f) => f.key)).toEqual(["small", "medium", "large"]);
    expect(form.fields.map((f) => f.value)).toEqual([40, 55, 70]);
  });

  it("per_sqft_band: one field per tier boundary, labeled by sqft", () => {
    const svc: RateService = {
      pricing_model: "per_sqft_band",
      band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
    };
    const form = buildRateForm(svc, null);
    expect(form.fields.map((f) => f.key)).toEqual(["1800", "2800", "top"]);
    expect(form.fields.map((f) => f.label)).toEqual(["Up to 1,800 sq ft", "1,800–2,800 sq ft", "2,800+ sq ft"]);
  });
});

describe("computeRateRow", () => {
  it("flat stores base only", () => {
    const r = computeRateRow({ pricing_model: "flat", band_pricing: null }, { base: "300" });
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({ base: 300, unit_rate: 0, band_pricing: null });
  });

  it("per_section carries the service's count_field + min_count, never prices", () => {
    const svc: RateService = { pricing_model: "per_section", band_pricing: { count_field: "boat_lifts", min_count: 1 } };
    const r = computeRateRow(svc, { base: "0", unitRate: "400" });
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({ base: 0, unit_rate: 400, band_pricing: { count_field: "boat_lifts", min_count: 1 } });
  });

  it("band stores small/medium/large from the crew's own numbers", () => {
    const svc: RateService = { pricing_model: "band", band_pricing: { small: 65, medium: 85, large: 110 } };
    const r = computeRateRow(svc, { band: { small: "40", medium: "55", large: "70" } });
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({ base: 0, unit_rate: 0, band_pricing: { small: 40, medium: 55, large: 70 } });
  });

  it("per_sqft_band pairs the service's tier maxes with the crew's prices", () => {
    const svc: RateService = {
      pricing_model: "per_sqft_band",
      band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
    };
    const r = computeRateRow(svc, { band: { "1800": "50", "2800": "65", top: "90" } });
    expect(r.ok).toBe(true);
    expect(r.row?.band_pricing).toEqual({
      tiers: [{ max: 1800, price: 50 }, { max: 2800, price: 65 }, { max: null, price: 90 }],
    });
  });

  it("rejects an invalid number", () => {
    const r = computeRateRow({ pricing_model: "flat", band_pricing: null }, { base: "-5" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("a park mow is priced PER LOT, and the box has to say so", () => {
  /**
   * THE 21× TYPO, ON THE FIRST SCREEN A NEW CREW TOUCHES.
   *
   * `unitNounFor` knew pier sections, boat lifts, jet skis, PWC lifts and toy
   * lifts — every count a LAKE HOUSE has. It had no case for "lots", the
   * count_field on all three per_section park services, so the label fell to
   * the default and read "Your rate per unit".
   *
   * A crew invited to mow The Haven opens their rate card, reads "per unit" as
   * "per visit" — which is how mowing is quoted everywhere in the trade — and
   * types 100. That is stored as $100 A LOT. Priced against the park it becomes
   * $100 × 21 = $2,100, the margin floor drops them instantly, and the screen
   * says "Saved." They are then live, invisible, and certain their rate is on
   * file. The reverse costs them just as much: meaning $100 a lot and being
   * paid $100 for the day.
   *
   * The count is genuinely per-park — a crew's one rate applies at every park
   * they serve, and each has its own lot count — so the honest label names the
   * unit and says what multiplies it, rather than promising a number.
   */
  it("names the lot, which is what the engine actually multiplies", () => {
    expect(unitNounFor("per_section", "lots")).toBe("lot");
  });

  it("still says 'unit' for a count nobody has taught it", () => {
    // The default is right for an unknown field — inventing a noun would be
    // worse than admitting we don't know.
    expect(unitNounFor("per_section", "mystery")).toBe("unit");
  });

  it("the built form carries the lot noun through to the box's label", () => {
    // unitNounFor could be perfect and the form still read "per unit" — the
    // label is assembled separately, and that assembly is what a crew reads.
    const form = buildRateForm(
      { pricing_model: "per_section", band_pricing: { count_field: "lots" } },
      null,
    );
    expect(form.unitNoun).toBe("lot");
    const unitField = form.fields.find((f) => f.kind === "unit");
    expect(unitField, "the per-unit box is gone — this scan measures nothing").toBeTruthy();
    expect(unitField!.label).toBe("Your rate per lot");
  });

  it("and the screen warns that a park multiplies it", () => {
    // A label alone still lets somebody read "per lot" and type the whole-job
    // number. The count varies by park, so the screen says what happens rather
    // than quoting a figure it cannot know here.
    const src = readFileSync(
      fileURLToPath(new URL("../../components/VendorRates.tsx", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src, "nothing on the rate card explains the lot multiplier")
      .toMatch(/every lot in the park|multiplied by the park/i);
  });
});
