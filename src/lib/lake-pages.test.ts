import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fromPrice, slugify, OWNER_FIXTURE_EMBED, OWNER_FIXTURE_FILTER } from "./lake-pages";
import { priceService, type ServiceRule, type PricingProfile } from "./pricing";
import { checkNamedInsured } from "./named-insured";

/**
 * THE PUBLIC FLOOR AND THE ENGINE MUST AGREE.
 *
 * Every number on /lakes/[slug] is a price claim on the open internet. The
 * only honest definition of "from $X" is: X is what `priceService` charges
 * the smallest property that can book this service at all. So each model is
 * pinned against the engine itself, not against a remembered number — and
 * each pin is written so that DROPPING `rule.base` fails it.
 */

const bare: PricingProfile = {
  pier_sections: 0, boat_lifts: 0, toy_lifts: 0, jet_skis: 0, pwc_lifts: 0,
  panes: 0, beds: 3, baths: 2, sqft: 1500, lawn_band: "small", drive_band: null,
  boats: [], toys: [],
} as unknown as PricingProfile;
const rule = (r: Partial<ServiceRule>): ServiceRule =>
  ({ name: "x", pricing_model: "flat", base: 0, unit_rate: 0, band_pricing: null, ...r }) as ServiceRule;

describe("fromPrice — the floor is what the engine would charge", () => {
  it("per_section: the pier floor carries its base (the $220 the page used to drop)", () => {
    const pier = rule({ pricing_model: "per_section", base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" } });
    const cheapestRealBill = priceService(pier, { ...bare, pier_sections: 1 });
    expect(cheapestRealBill).toBe(268);
    expect(fromPrice(pier)).toEqual({ amount: 268, unit: null, from: true });
    // FAILS IF THE BASE IS DROPPED: 48 is what the page printed for $268 work.
    expect(fromPrice(pier)!.amount).not.toBe(48);
    expect(fromPrice(pier)!.amount).toBe(cheapestRealBill);
    // And the noun must not survive a bundled base — a second section is $48,
    // not $268.
    expect(fromPrice(pier)!.unit).toBeNull();
  });

  it("per_section: with no base the floor IS the unit rate, and keeps its noun", () => {
    const lift = rule({ pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 } });
    expect(priceService(lift, { ...bare, boat_lifts: 1 })).toBe(495);
    expect(fromPrice(lift)).toEqual({ amount: 495, unit: "per lift", from: true });
  });

  it("per_section: min_count is part of the floor", () => {
    const two = rule({ pricing_model: "per_section", base: 0, unit_rate: 165, band_pricing: { count_field: "pwc_lifts", min_count: 2 } });
    expect(priceService(two, { ...bare, pwc_lifts: 1 })).toBe(330);
    expect(fromPrice(two)!.amount).toBe(330);
    expect(fromPrice(two)!.unit).toBeNull(); // $330 is not "per PWC lift"
  });

  it("flat: a plain flat service is still an exact price", () => {
    const opening = rule({ pricing_model: "flat", base: 430 });
    expect(priceService(opening, bare)).toBe(430);
    expect(fromPrice(opening)).toEqual({ amount: 430, unit: null, from: false });
  });

  it("flat + add: water toys cannot be booked with no toys, so $120 was never the floor", () => {
    const toys = rule({ pricing_model: "flat", base: 120, band_pricing: { add: [{ field: "toy_lifts", rate: 60 }, { field: "toys_count", rate: 15 }] } });
    const oneToy = priceService(toys, { ...bare, toys: [{ name: "tube" }] } as PricingProfile);
    expect(oneToy).toBe(135);
    expect(fromPrice(toys)).toEqual({ amount: 135, unit: null, from: true });
    // FAILS IF THE ADD TERMS ARE DROPPED — that is the old "$120", exact.
    expect(fromPrice(toys)!.amount).not.toBe(120);
    expect(fromPrice(toys)!.from).toBe(true);
  });

  it("per_foot: with a base the floor includes it; without one it is the rate", () => {
    const plain = rule({ pricing_model: "per_foot", base: 0, unit_rate: 50 });
    expect(fromPrice(plain)).toEqual({ amount: 50, unit: "per boat foot", from: true });
    const withBase = rule({ pricing_model: "per_foot", base: 95, unit_rate: 12 });
    // The engine bills base + rate × feet, so no real bill is below base + one foot.
    expect(priceService(withBase, { ...bare, boats: [{ length_ft: 18 }] } as PricingProfile)).toBe(311);
    expect(fromPrice(withBase)).toEqual({ amount: 107, unit: null, from: true });
    expect(fromPrice(withBase)!.amount).not.toBe(12);
  });

  it("seasonal_plus_perdiem: same arithmetic, seasonal noun", () => {
    expect(fromPrice(rule({ pricing_model: "seasonal_plus_perdiem", unit_rate: 43 })))
      .toEqual({ amount: 43, unit: "per boat foot / season", from: true });
    expect(fromPrice(rule({ pricing_model: "seasonal_plus_perdiem", base: 200, unit_rate: 43 }))!.amount).toBe(243);
  });

  it("band: the smallest tier, and a band the rule does not carry falls to base", () => {
    const lawn = rule({ pricing_model: "band", band_pricing: { small: 65, medium: 85, large: 110 } });
    expect(priceService(lawn, { ...bare, lawn_band: "small" })).toBe(65);
    expect(fromPrice(lawn)).toEqual({ amount: 65, unit: null, from: true });
    // Only "large" priced: a small lawn bills `base`, which is cheaper — and
    // the floor has to say so.
    const partial = rule({ pricing_model: "band", base: 40, band_pricing: { large: 110 } });
    expect(priceService(partial, { ...bare, lawn_band: "small" })).toBe(40);
    expect(fromPrice(partial)!.amount).toBe(40);
  });

  it("per_sqft_band: the cheapest tier, plus base when no tier catches the big houses", () => {
    const keeping = rule({ pricing_model: "per_sqft_band", band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] } });
    expect(priceService(keeping, { ...bare, sqft: 1200 })).toBe(80);
    expect(fromPrice(keeping)).toEqual({ amount: 80, unit: null, from: true });
    const noCatchAll = rule({ pricing_model: "per_sqft_band", base: 60, band_pricing: { tiers: [{ max: 1800, price: 80 }] } });
    expect(priceService(noCatchAll, { ...bare, sqft: 4000 })).toBe(60);
    expect(fromPrice(noCatchAll)!.amount).toBe(60);
  });

  it("zero/garbage pricing renders nothing rather than lying", () => {
    expect(fromPrice(rule({ pricing_model: "flat", base: 0 }))).toBeNull();
    expect(fromPrice(rule({ pricing_model: "band" }))).toBeNull();
    expect(fromPrice(rule({ pricing_model: "per_section", base: 0, unit_rate: 0, band_pricing: { count_field: "lots" } }))).toBeNull();
    expect(fromPrice(rule({ pricing_model: "per_sqft_band", band_pricing: { tiers: [] } }))).toBeNull();
  });
});

describe("fromPrice — unit names follow the service's count_field", () => {
  const per = (count_field: string) =>
    fromPrice({ pricing_model: "per_section", base: 0, unit_rate: 495, band_pricing: { count_field } as never });
  it("every counted noun the table knows", () => {
    expect(per("boat_lifts")!.unit).toBe("per lift");
    expect(per("pwc_lifts")!.unit).toBe("per PWC lift");
    expect(per("jet_skis")!.unit).toBe("per jet ski");
    expect(per("panes")!.unit).toBe("per pane");
    expect(per("lots")!.unit).toBe("per lot");
    expect(per("pier_sections")!.unit).toBe("per pier section");
  });
});

describe("slugify — must match the SQL backfill", () => {
  it("standard names", () => {
    expect(slugify("Big Long Lake")).toBe("big-long-lake");
    expect(slugify("  Pretty Lake ")).toBe("pretty-lake");
    expect(slugify("Lake o' the Woods")).toBe("lake-o-the-woods");
  });
});

/**
 * THE FIXTURE FENCE ON THE PUBLIC LAKE PAGE.
 *
 * Source-scanning, because the defect is in a query string: the crew count
 * was fenced and the job count one line below it was not. Comments are
 * stripped first — the fence has to be in the CODE, not in a note about it.
 */
describe("a fixture job never becomes a public completion", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const page = strip(readFileSync(new URL("../app/lakes/[slug]/page.tsx", import.meta.url), "utf8"));
  const index = strip(readFileSync(new URL("../app/lakes/page.tsx", import.meta.url), "utf8"));

  it("the scanner is looking at the real page", () => {
    expect(page.length).toBeGreaterThan(2000);
    expect(page).toMatch(/from\("jobs"\)/);
    expect(page).toMatch(/from\("job_confirmations"\)/);
    expect(index.length).toBeGreaterThan(800);
  });

  it("the fence is one pair of strings, and the jobs query uses it", () => {
    expect(OWNER_FIXTURE_EMBED).toBe("users!properties_owner_id_fkey!inner(is_fixture)");
    expect(OWNER_FIXTURE_FILTER).toBe("properties.users.is_fixture");
    const jobs = page.slice(page.indexOf('from("jobs")'), page.indexOf('from("job_confirmations")'));
    expect(jobs).toContain("OWNER_FIXTURE_EMBED");
    expect(jobs).toContain("OWNER_FIXTURE_FILTER");
    // The count it feeds is the one the sentence prints.
    expect(page).toMatch(/completedRes/);
  });

  it("the thumbs on those jobs are fenced the same way", () => {
    const thumbs = page.slice(page.indexOf('from("job_confirmations")'));
    const stanza = thumbs.slice(0, thumbs.indexOf("]"));
    expect(stanza).toContain("OWNER_FIXTURE_EMBED");
    expect(stanza).toContain("OWNER_FIXTURE_FILTER");
  });

  it("the crew fence it copies is still there, both pages", () => {
    expect(page).toContain('.eq("users.is_fixture", false)');
    expect(index).toContain('.eq("users.is_fixture", false)');
  });

  it("the index page has no unfenced count of its own", () => {
    // Its twin would be a jobs/confirmations read on the directory page.
    expect(index).not.toMatch(/from\("jobs"\)|from\("job_confirmations"\)/);
  });

  it("\"insured\" on both public pages means what the router means by it", () => {
    // dispatch.ts refuses a crew whose certificate names another business, so
    // a public page counting an unexpired date alone would advertise a crew
    // no booking could reach.
    for (const [where, src] of [["the lake page", page], ["the directory", index]] as const) {
      expect(src, `${where} counts "insured" off the expiry alone`).toContain("checkNamedInsured");
      expect(src).toContain("coi_named_insured");
    }
    // Both ways, on the real helper the pages call: a mismatch is refused, a
    // match passes, and a null is grandfathered by the `== null` branch above.
    expect(checkNamedInsured("Northshore Docks LLC", "Northshore Docks").ok).toBe(true);
    expect(checkNamedInsured("Someone Else Inc", "Northshore Docks").ok).toBe(false);
  });

  it("a lake-house menu cannot advertise a park-only service", () => {
    expect(page).toContain('.eq("park_only", false)');
  });

  it("neither public page renders a failed read as an empty one", () => {
    expect(page).toMatch(/mustRead|mustCount/);
    expect(index).toMatch(/mustRead/);
    expect(index).not.toMatch(/\{\s*data:\s*lakes\s*\}/);
  });
});
