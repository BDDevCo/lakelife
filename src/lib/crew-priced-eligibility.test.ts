/**
 * THE REFUSAL IS A TEST OF THE SERVICE'S SHAPE, NOT A LIST OF TWO NAMES.
 *
 * Every fixture here is a SHAPE. The two refusals are asserted against rows
 * that carry no recognisable name at all, and the live rows are asserted
 * separately — so renaming `Water toy prep & storage` tomorrow cannot turn the
 * refusal off, and the next `flat`-with-`add` service is refused the day it is
 * seeded.
 *
 * NUMBERS AND SHAPES COME FROM THE LIVE ROWS, read out of `services` on
 * 24 September 2026 and typed out here rather than recomputed:
 *
 *   Water toy prep & storage  flat   base 120  {"add":[{rate:60,field:toy_lifts},
 *                                               {rate:15,field:toys_count}]}
 *   Lawn mowing & trim        band   base 0    {"small":65,"medium":85,"large":110}
 *   Pier install / removal    per_section base 220 unit 48 {"count_field":"pier_sections"}
 *   Housekeeping              per_sqft_band {"tiers":[{max:1800,price:80},
 *                                            {max:2800,price:95},{max:null,price:120}]}
 *   Park grounds mowing & trim per_section base 0 unit 0 {"count_field":"lots"}, park_only
 *
 * THE LAST PAIR OF `it`s IS THE ONE THAT MATTERS: the second `band` row on the
 * menu (`Snow removal — drive & walks`, inactive, band_field drive_band) is
 * refused without appearing in any list, and a `flat` row with an `add` term
 * nobody has seen yet is refused the same way.
 */
import { describe, it, expect } from "vitest";
import {
  crewCardCanPrice,
  menuPriceLine,
  flipConsequenceLines,
  parkPrecedenceLine,
  MODELS_A_CARD_CAN_PRICE,
  MODELS_PRICED_BY_A_SIZE_WORD,
} from "./crew-priced-eligibility";
import { priceService, type ServiceRule, type PricingProfile } from "./pricing";
import { computeRateRow } from "@/app/vendor/rates-helpers";

const emptyProfile: PricingProfile = {
  sqft: 2000, beds: 3, baths: 2,
  pier_sections: 0, boat_lifts: 0, toy_lifts: 0, jet_skis: 0, pwc_lifts: 0, panes: 0,
  lawn_band: "medium", drive_band: null, boats: [],
} as unknown as PricingProfile;

const toyProfile: PricingProfile = {
  ...emptyProfile,
  toy_lifts: 2,
  toys: [{}, {}, {}, {}, {}, {}],
} as unknown as PricingProfile;

describe("crewCardCanPrice — the two live refusals", () => {
  it("refuses a flat service that declares add[] terms (the water toys shape)", () => {
    const v = crewCardCanPrice({
      name: "Water toy prep & storage",
      pricing_model: "flat",
      band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] },
    });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("card_drops_terms");
    expect(v.droppedTerms).toEqual(["add"]);
    expect(v.reason).toContain("Water toy prep & storage");
    expect(v.reason).toContain("per-item add-ons");
  });

  it("refuses the band model (the lawn shape) and names the missing measurement", () => {
    const v = crewCardCanPrice({
      name: "Lawn mowing & trim",
      pricing_model: "band",
      band_pricing: { small: 65, medium: 85, large: 110 },
    });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("size_word_not_a_measure");
    expect(v.reason).toContain("acre");
  });

  it("ACCEPTS the shapes a crew's card can carry", () => {
    for (const s of [
      { name: "Pier install / removal", pricing_model: "per_section", band_pricing: { count_field: "pier_sections" as const } },
      { name: "Boat storage & winterize", pricing_model: "per_foot", band_pricing: null },
      { name: "Spring opening", pricing_model: "flat", band_pricing: null },
      { name: "Housekeeping", pricing_model: "per_sqft_band", band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: null, price: 120 }] } },
      { name: "Winter storage — indoor", pricing_model: "seasonal_plus_perdiem", band_pricing: null },
      { name: "Park grounds mowing & trim", pricing_model: "per_section", band_pricing: { count_field: "lots" as const } },
    ]) {
      expect(crewCardCanPrice(s), s.name).toEqual({ ok: true });
    }
  });
});

describe("the refusal is derived, so a service nobody listed is still caught", () => {
  it("refuses a second band service with a different band_field and a made-up name", () => {
    const v = crewCardCanPrice({
      name: "zzz-unknown-service",
      pricing_model: "band",
      band_pricing: { band_field: "drive_band", small: 40, medium: 55, large: 70 },
    });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("size_word_not_a_measure");
  });

  it("refuses a per_section service that declares per_engine_hp_tiers", () => {
    const v = crewCardCanPrice({
      name: "zzz-unknown-service",
      pricing_model: "per_section",
      band_pricing: { count_field: "boat_lifts", per_engine_hp_tiers: [{ max: 150, price: 40 }] },
    });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("card_drops_terms");
    expect(v.droppedTerms).toEqual(["per_engine_hp_tiers"]);
  });

  it("names BOTH dropped terms when a row declares both", () => {
    const v = crewCardCanPrice({
      name: "zzz-unknown-service",
      pricing_model: "flat",
      band_pricing: { add: [{ field: "panes", rate: 4 }], per_engine_hp_tiers: [{ max: null, price: 90 }] },
    });
    expect(v.droppedTerms).toEqual(["add", "per_engine_hp_tiers"]);
    expect(v.reason).toContain("per-item add-ons and its per-engine pricing");
  });

  it("refuses a pricing model the rate-card builder has no branch for", () => {
    const v = crewCardCanPrice({ name: "zzz-unknown-service", pricing_model: "per_hour", band_pricing: null });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("no_card_for_this_model");
  });

  it("an EMPTY add[] is not a declared term — the row prices like any other flat", () => {
    expect(crewCardCanPrice({ name: "zzz", pricing_model: "flat", band_pricing: { add: [] } })).toEqual({ ok: true });
  });

  it("a zero-rate add[] term IS still refused — the card drops it whatever it is worth today", () => {
    const v = crewCardCanPrice({
      name: "zzz",
      pricing_model: "flat",
      band_pricing: { add: [{ field: "toys_count", rate: 0 }] },
    });
    expect(v.ok).toBe(false);
    expect(v.blocker).toBe("card_drops_terms");
  });

  it("transport keys are NOT treated as dropped — the crew-priced path skips the tow on purpose", () => {
    expect(
      crewCardCanPrice({ name: "Boat return & splash", pricing_model: "flat", band_pricing: { included_miles: 0, per_mile_beyond: 0 } }),
    ).toEqual({ ok: true });
    expect(
      crewCardCanPrice({ name: "zzz", pricing_model: "per_foot", band_pricing: { included_miles: 20, per_mile_beyond: 3.6 } }),
    ).toEqual({ ok: true });
  });
});

/**
 * THE ARITHMETIC BEHIND THE REFUSAL, PROVED RATHER THAN ASSERTED.
 *
 * Not a re-implementation: this runs the REAL `computeRateRow` to build the
 * card a crew would save, then the REAL `priceService` over it, and shows the
 * per-lift and per-toy terms are gone. Inputs are seeded (2 lifts, 6 toys, a
 * $120 quote); the menu figure 120 + 2x60 + 6x15 = 330 is typed out.
 */
describe("why the water-toys shape cannot work — the two prices, computed", () => {
  const service = {
    pricing_model: "flat" as const,
    band_pricing: { add: [{ field: "toy_lifts" as const, rate: 60 }, { field: "toys_count" as const, rate: 15 }] },
    crew_priced: false,
  };
  const menuRule: ServiceRule = { name: "Water toy prep & storage", pricing_model: "flat", base: 120, unit_rate: 0, band_pricing: service.band_pricing };

  it("the menu charges 330 on a shoreline with 2 lifts and 6 toys", () => {
    expect(priceService(menuRule, toyProfile)).toBe(330);
  });

  it("a crew's card built by computeRateRow quotes the same 120 whatever is on the shore", () => {
    const built = computeRateRow(service, { base: 120, unitRate: null, band: {} });
    expect(built.ok).toBe(true);
    // THE DROP, IN THE STORED ROW ITSELF: nothing carries the add terms.
    expect(built.row?.band_pricing).toBeNull();
    const crewRule: ServiceRule = {
      name: "Water toy prep & storage",
      pricing_model: "flat",
      base: built.row!.base,
      unit_rate: built.row!.unit_rate,
      band_pricing: built.row!.band_pricing,
    };
    expect(priceService(crewRule, toyProfile)).toBe(120);
    // ...and the bare shoreline pays exactly the same, which is the bug.
    expect(priceService(crewRule, { ...toyProfile, toy_lifts: 0, toys: [] } as unknown as PricingProfile)).toBe(120);
  });
});

describe("menuPriceLine names what is being switched off", () => {
  it("spells out a flat price and its add terms", () => {
    expect(
      menuPriceLine({
        name: "Water toy prep & storage", pricing_model: "flat", base: 120, unit_rate: 0,
        band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] },
      }),
    ).toBe("$120 flat + $60 per toy lift + $15 per toy");
    // The PLURAL was the bug: "per toy lifts" says "per one of these" about a
    // set. `toys_count` counts TOYS, and the "count" suffix is a column name,
    // not a thing anybody is charged for.
  });

  it("names the per-unit noun by SHAPE, so a field nobody listed still reads", () => {
    // Not a lookup table of the eight CountableField values — a table is a
    // list somebody has to remember to extend, and the failure mode when they
    // forget is the raw column name back on the screen.
    expect(
      menuPriceLine({ name: "PWC lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 165, band_pricing: { count_field: "pwc_lifts" } }),
    ).toBe("$165 per PWC lift");
    expect(
      menuPriceLine({
        name: "zzz-unknown", pricing_model: "per_section", base: 0, unit_rate: 9,
        // DELIBERATELY OUTSIDE `CountableField` — that is the whole point.
        // The cast is the test: a field this union has never heard of has to
        // read as English rather than as a column name.
        band_pricing: { count_field: "greenhouse_panels_count" } as unknown as ServiceRule["band_pricing"],
      }),
    ).toBe("$9 per greenhouse panel");
  });

  it("names the MINIMUM, because priceService charges it whether or not you have one", () => {
    // `count = max(min_count, count)` (src/lib/pricing.ts). Boat lift set /
    // pull is $495 per boat lift with min_count 1, so a property with no
    // lifts is still charged $495. Naming the rate and hiding the floor
    // understates the menu on the one screen whose job is to name the number
    // being switched off.
    expect(
      menuPriceLine({ name: "Boat lift set / pull", pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 } }),
    ).toBe("$495 per boat lift, minimum 1");
    // And a rule with no floor does not grow one.
    expect(
      menuPriceLine({ name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" } }),
    ).not.toContain("minimum");
  });

  it("spells out base + per-unit", () => {
    expect(
      menuPriceLine({ name: "Pier install / removal", pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" } }),
    ).toBe("$220 + $48 per pier section");
  });

  it("spells out the three bands", () => {
    expect(
      menuPriceLine({ name: "Lawn mowing & trim", pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 } }),
    ).toBe("small $65 · medium $85 · large $110");
  });

  it("a park_only row zeroed by 0115 returns NULL rather than a sentence", () => {
    // A string here got dropped into the middle of another sentence and read
    // "Today it charges No menu price — ... — after the flip...". Null forces
    // the caller to say something different, which is the honest answer.
    expect(
      menuPriceLine({ name: "Park grounds mowing & trim", pricing_model: "per_section", base: 0, unit_rate: 0, band_pricing: { count_field: "lots" }, park_only: true }),
    ).toBeNull();
    expect(menuPriceLine({ name: "x", pricing_model: "flat", base: 0, unit_rate: 0, band_pricing: null })).toBeNull();
  });
});

describe("flipConsequenceLines — a failed count never reads as zero", () => {
  const common = { serviceName: "Pier install / removal", menuLine: "$220 + $48 per pier section", customerPct: 0.12, crewPct: 0.12 };

  it("names the menu price it is switching off", () => {
    expect(flipConsequenceLines({ ...common, cardedCrews: 1, futureJobs: 0 })[0]).toContain("$220 + $48 per pier section");
  });

  it("a park_only service with no menu price says there is nothing to switch off", () => {
    const first = flipConsequenceLines({ ...common, serviceName: "Snow clearing — roads & common drives", menuLine: null, parkOnly: true, cardedCrews: 0, futureJobs: 0 })[0];
    expect(first).toContain("no menu price to switch off");
    expect(first).not.toContain("Today it charges");
  });

  it("an unpriced lake-house service says so without claiming a price stops applying", () => {
    const first = flipConsequenceLines({ ...common, menuLine: null, cardedCrews: 0, futureJobs: 0 })[0];
    expect(first).toContain("no menu price on file");
    expect(first).not.toContain("stops applying");
  });

  it("a rate card is called necessary, never sufficient", () => {
    // "N crews have a rate card for this and would be pickable" is a
    // readiness sentence he would act on, and this count cannot make it:
    // dispatch still demands unexpired insurance named to the business
    // (0152), this lake in service_lakes, the weekday in work_days, room in
    // the day, and on a package a rate row for EVERY leg.
    const joined = flipConsequenceLines({ ...common, cardedCrews: 2, futureJobs: 0 }).join(" ");
    expect(joined).toContain("2 crews have a rate card for this");
    expect(joined).not.toContain("would be pickable");
    expect(joined).toContain("insurance");
  });

  it("states both percentages", () => {
    const lines = flipConsequenceLines({ ...common, cardedCrews: 2, futureJobs: 0 });
    expect(lines.join(" ")).toContain("plus 12%");
    expect(lines.join(" ")).toContain("less 12%");
  });

  it("WARNS, rather than refusing, when no crew has priced it", () => {
    const lines = flipConsequenceLines({ ...common, cardedCrews: 0, futureJobs: 0 });
    expect(lines.join(" ")).toContain("NO CREW HAS PRICED THIS YET");
    expect(lines.join(" ")).toContain("day before crews onboard");
  });

  it("a null crew count says the read failed and NEVER says nobody has priced it", () => {
    const joined = flipConsequenceLines({ ...common, cardedCrews: null, futureJobs: 0 }).join(" ");
    expect(joined).toContain("couldn't read how many crews");
    expect(joined).not.toContain("NO CREW HAS PRICED THIS YET");
  });

  it("names booked work and covers BOTH shapes of sold price", () => {
    // "A job keeps the quote and both percentages it was sold under" is true
    // of a job sold at a crew's quote and says NOTHING about a job sold at
    // the MENU price and still waiting for a crew — which is the shape every
    // booking has today, and the one this switch turns into a crew-priced job
    // overnight. The sentence that named only the first half was false for
    // every waitlisted job on the platform.
    const joined = flipConsequenceLines({ ...common, cardedCrews: 1, futureJobs: 3 }).join(" ");
    expect(joined).toContain("3 jobs are already booked");
    expect(joined).toContain("NONE of them reprice");
    expect(joined).toContain("frozen");
    expect(joined).toContain("menu price keeps the figure its customer was shown");
  });

  it("a null job count says the read failed, not that the diary is empty", () => {
    const joined = flipConsequenceLines({ ...common, cardedCrews: 1, futureJobs: null }).join(" ");
    expect(joined).toContain("couldn't read what's already booked");
    expect(joined).not.toContain("Nothing is booked");
  });
});

describe("parkPrecedenceLine — the mow must not move", () => {
  it("names the park that holds its own number as protected", () => {
    const line = parkPrecedenceLine({
      serviceName: "Park grounds mowing & trim",
      parksWithOwnRate: ["The Haven"],
      parksThatCouldBuy: ["The Haven"],
    })!;
    expect(line).toContain("The Haven holds its own price");
    expect(line).toContain("beats a crew's card");
    expect(line).not.toContain("no price of their own");
  });

  it("names a park with no number of its own as one a crew would price", () => {
    const line = parkPrecedenceLine({
      serviceName: "Snow clearing — roads & common drives",
      parksWithOwnRate: [],
      parksThatCouldBuy: ["The Haven"],
    })!;
    expect(line).toContain("The Haven has no price of its own");
    expect(line).toContain("whichever crew quotes it");
  });

  it("a failed read does not print as 'no park buys this'", () => {
    const line = parkPrecedenceLine({ serviceName: "x", parksWithOwnRate: null, parksThatCouldBuy: ["The Haven"] })!;
    expect(line).toContain("couldn't read");
  });

  it("says nothing at all when no park can buy the service", () => {
    expect(parkPrecedenceLine({ serviceName: "Housekeeping", parksWithOwnRate: [], parksThatCouldBuy: [] })).toBeNull();
  });
});

describe("the two derived tables stay tied to the code they mirror", () => {
  it("every model a card can price has a computeRateRow branch that succeeds", () => {
    for (const model of MODELS_A_CARD_CAN_PRICE) {
      const res = computeRateRow({ pricing_model: model, band_pricing: null, crew_priced: false }, { base: 10, unitRate: 10, band: { small: 1, medium: 2, large: 3 } });
      expect(res.ok, model).toBe(true);
    }
  });

  it("the size-word model is exactly the one priceService picks with bandValue", () => {
    // `bandValue` is private; its effect is not. A band rule prices off the
    // profile's WORD, so changing only the word changes only a band price.
    const bandRule: ServiceRule = { name: "b", pricing_model: "band", base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 } };
    expect(priceService(bandRule, { ...emptyProfile, lawn_band: "small" } as PricingProfile)).toBe(65);
    expect(priceService(bandRule, { ...emptyProfile, lawn_band: "large" } as PricingProfile)).toBe(110);
    expect(MODELS_PRICED_BY_A_SIZE_WORD).toEqual(["band"]);
  });
});
