import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withParkRate, parkMayPrice, type ParkRates } from "./park-rates";
import { priceService, type ServiceRule, type PricingProfile } from "./pricing";
import { parkRateUnit } from "@/app/park/service-helpers";

/**
 * EVERY PARK CARRIES ITS OWN NUMBER (28 Aug 2026), and the widening that made
 * it possible is the dangerous half.
 *
 * 0115 fenced park pricing by ZEROING the global row, which only works for
 * `park_only` work. 0143 then let a park BOOK lake-house work without giving it
 * anywhere to put its own price, so The Haven's dock fell through to the retail
 * card. The fence therefore moved off the flag and onto the doorway: if the
 * customer is a park, only that park's own row may price the work.
 *
 * The risk that buys is the reverse leak — the same doorway, pointed at a lake
 * house, zeroes the entire retail catalogue. `null` is what says "not a park",
 * and these tests collapse that condition BOTH ways.
 */

/** The real production row, 23 Sep 2026: base 220, unit_rate 48, per pier section. */
const PIER: ServiceRule & { id: string } = {
  id: "svc-pier",
  name: "Pier install / removal",
  pricing_model: "per_section",
  base: 220,
  unit_rate: 48,
  band_pricing: { count_field: "pier_sections" },
};

/** The real production row: park_only, and 0115 zeroed its global price. */
const MOW: ServiceRule & { id: string } = {
  id: "svc-mow",
  name: "Park grounds mowing & trim",
  pricing_model: "per_section",
  base: 0,
  unit_rate: 0,
  band_pricing: { count_field: "lots" },
};

/** The Haven's grounds: 21 live lots, a 28-section vinyl dock. */
const HAVEN = { lots: 21, pier_sections: 28 } as unknown as PricingProfile;
/** An ordinary lake house with an 8-section pier and no lots at all. */
const LAKE_HOUSE = { pier_sections: 8 } as unknown as PricingProfile;

const rates = (rows: Array<[string, number, number]>): ParkRates =>
  new Map(rows.map(([id, base, unit_rate]) => [id, { base, unit_rate }]));

describe("a park's dock is priced by the park, or not at all", () => {
  it("prices The Haven's dock at Josh's $840 an operation", () => {
    // 23 Sep 2026, from him: "$1,680 per season... 1/2 of it is putting in and
    // the other 1/2 is taking it out." 28 sections, $30.00 a section.
    const rule = withParkRate(PIER, rates([["svc-pier", 0, 30]]));
    expect(priceService(rule, HAVEN)).toBe(840);
    expect(priceService(rule, HAVEN) * 2).toBe(1680); // set in spring, pull in fall
  });

  it("gives a park that has not priced the dock NO number, not the retail card", () => {
    // THE BUG THIS EXISTS FOR. 220 + 48 x 28 = 1564, which is 1.86x Josh, and
    // it was on the owner's own booking screen.
    const rule = withParkRate(PIER, rates([]));
    expect(priceService(rule, HAVEN)).toBe(0);
    expect(priceService(rule, HAVEN)).not.toBe(1564);
  });

  it("does not let one park's dock rate reach another park's", () => {
    // Park #2 books a pier. Its own map is empty; The Haven's $30 is not its.
    const havensMap = rates([["svc-pier", 0, 30]]);
    const parkTwo = withParkRate({ ...PIER, id: "svc-pier-elsewhere" }, havensMap);
    expect(priceService(parkTwo, HAVEN)).toBe(0);
  });

  it("still gives a park with no mow rate nothing", () => {
    expect(priceService(withParkRate(MOW, rates([])), HAVEN)).toBe(0);
    expect(priceService(withParkRate(MOW, rates([["svc-mow", 20, 5]])), HAVEN)).toBe(125);
  });
});

describe("THE LEAK: a park rate must never reach a lake house", () => {
  /**
   * The overlay is now destructive — a park with no row gets base 0 — so the
   * ONLY thing standing between a lake homeowner and a $0 catalogue is the
   * `null` that says "this customer is not a park".
   */
  it("leaves the retail card alone when the customer is not a park", () => {
    const rule = withParkRate(PIER, null);
    expect(priceService(rule, LAKE_HOUSE)).toBe(220 + 48 * 8); // 604
  });

  it("would destroy that price if the same house were handed a park's map", () => {
    // COLLAPSE THE CONDITION THE OTHER WAY. This is what `new Map()` — what
    // getPricedServices passed for a lake house before this change — now does.
    const asIfPark = withParkRate(PIER, new Map() as ParkRates);
    expect(priceService(asIfPark, LAKE_HOUSE)).toBe(0);
    expect(priceService(asIfPark, LAKE_HOUSE)).not.toBe(604);
  });

  it("never hands a lake house The Haven's negotiated number either", () => {
    // The other direction of the same fence: even holding The Haven's map, a
    // lake house is priced by the retail card and nothing else.
    const havensMap = rates([["svc-pier", 0, 30]]);
    expect(priceService(withParkRate(PIER, null), LAKE_HOUSE)).toBe(604);
    // And if it DID leak, the number would be different — so the assertion
    // above is pinning something.
    expect(priceService(withParkRate(PIER, havensMap), LAKE_HOUSE)).toBe(240);
  });

  it("keeps `note` off the rule, park or no park", () => {
    const withNote: ParkRates = new Map([
      ["svc-pier", { base: 0, unit_rate: 30, note: "Josh, $840 an operation." }],
    ]);
    expect("note" in withParkRate(PIER, withNote)).toBe(false);
  });
});

describe("the lake-house branch is spelt `null`, in the code that runs", () => {
  /**
   * THE DOORWAY, not a copy of it. `getPricedServices` is the one call site
   * that prices BOTH a lake house and a park through the same expression, and
   * it used to pass `new Map()` for the lake house. Under the widened overlay
   * that empty map is "a park that has set no prices" and zeroes everything.
   *
   * A unit test cannot reach it (it needs Supabase), so the assignment itself
   * is read — matching the assignment, not the type annotation.
   */
  const source = readFileSync(
    fileURLToPath(new URL("../app/profile/data.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("hands a non-grounds property null, never an empty map", () => {
    // THE SHAPE MOVED, THE RULE DID NOT (23 Sep 2026). The read is now split in
    // two — `checked` carries the third answer, `rates` carries the value — so
    // this scan follows both halves rather than one ternary. What it still
    // refuses is the same thing: `new Map()` on the lake-house branch, which
    // under the widened overlay means "a park that has priced nothing" and
    // zeroes the entire retail catalogue.
    const read = source.match(/const checked[^=]*=\s*isGrounds[\s\S]{0,240}?;/)?.[0] ?? "";
    expect(read, "the park-rate read in getPricedServices").not.toBe("");
    expect(read).toMatch(/:\s*null\s*;/);
    expect(read).not.toContain("new Map");

    const assign = source.match(/const rates: ParkRates \| null =[\s\S]{0,200}?;/)?.[0] ?? "";
    expect(assign, "the rates assignment in getPricedServices").not.toBe("");
    expect(assign).toMatch(/:\s*null\s*;/);
    expect(assign).not.toContain("new Map");
  });

  it("and it is the CHECKED read, because this menu speaks to a person", () => {
    // Added 0176. A swallowed failure is an empty Map, an empty Map is "this
    // park has no rate", and since precedence that is not merely "no price" —
    // on a crew_priced service it is "let a crew's card price it". Two lies on
    // one screen: The Haven's $125 mow reading "waiting on your price", and a
    // negotiated number captioned "Crews set their own price for this one".
    expect(source, "getPricedServices is back on the swallowing read")
      .not.toMatch(/\bloadParkRates\(/);
    expect(source).toContain("loadParkRatesChecked(");
    expect(source, "a failed rate read has to stop the menu, not price it")
      .toMatch(/checked\?\.failed/);
  });

  it("is still the only thing priced through withParkRate there", () => {
    expect(source).toContain("withParkRate(s, rates)");
  });
});

describe("which services a park may put a number on", () => {
  it("says yes to its own grounds work and to what 0143 opened", () => {
    expect(parkMayPrice({ park_only: true, park_bookable: false })).toBe(true);
    expect(parkMayPrice({ park_only: false, park_bookable: true })).toBe(true);
  });

  it("says no to lake-house work a park cannot buy at all", () => {
    // Pricing something you cannot book is a number with no reader.
    expect(parkMayPrice({ park_only: false, park_bookable: false })).toBe(false);
    expect(parkMayPrice({})).toBe(false);
    expect(parkMayPrice(null)).toBe(false);
    expect(parkMayPrice(undefined)).toBe(false);
  });

  it("does not treat a missing column as permission", () => {
    // A select that forgot park_bookable must fail CLOSED, not open.
    expect(parkMayPrice({ park_only: false })).toBe(false);
  });
});

describe("the per-unit box names what the engine counts", () => {
  it("counts pier sections for the dock, not lots", () => {
    expect(parkRateUnit("per_section", { count_field: "pier_sections" }))
      .toEqual({ countField: "pier_sections", noun: "pier section" });
  });

  it("still counts lots for the park's own mow", () => {
    expect(parkRateUnit("per_section", { count_field: "lots" }))
      .toEqual({ countField: "lots", noun: "lot" });
  });

  it("applies priceService's own default when band_pricing says nothing", () => {
    expect(parkRateUnit("per_section", null)?.countField).toBe("pier_sections");
  });

  it("refuses a unit on a model that never reads unit_rate", () => {
    // Snow clearing is `flat`; priceService returns rule.base and never looks.
    expect(parkRateUnit("flat", null)).toBeNull();
    expect(parkRateUnit("band", { count_field: "lots" })).toBeNull();
    expect(parkRateUnit("per_sqft_band", null)).toBeNull();
  });

  it("names the lifts a park might buy", () => {
    expect(parkRateUnit("per_section", { count_field: "boat_lifts" })?.noun).toBe("boat lift");
    expect(parkRateUnit("per_section", { count_field: "pwc_lifts" })?.noun).toBe("PWC lift");
  });
});
