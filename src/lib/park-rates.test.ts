import { describe, it, expect } from "vitest";
import { withParkRate, type ParkRates } from "./park-rates";
import { priceService, type ServiceRule, type PricingProfile } from "./pricing";

/**
 * 0115 MADE PARK PRICING PER-PARK. These tests exist because the failure they
 * guard against is silent and expensive: park #2 signing up and being quoted
 * The Haven's LaGrange County mow contract as if it were their own.
 *
 * The whole safety property is "no fallback" — a missing rate must produce NO
 * price, never somebody else's.
 */

/** The real shape of the row in `services`: per_section counting `lots`. */
const MOW: ServiceRule = {
  name: "Park grounds mowing & trim",
  pricing_model: "per_section",
  base: 0,          // what 0115 left in the global row, deliberately
  unit_rate: 0,
  band_pricing: { count_field: "lots" },
};

/** A park with N live lots, as `toPricingProfile` builds it. */
const park = (lots: number) => ({ lots } as unknown as PricingProfile);

const rates = (rows: Array<[string, number, number]>): ParkRates =>
  new Map(rows.map(([id, base, unit_rate]) => [id, { base, unit_rate }]));

describe("a park pays its own rate", () => {
  it("prices The Haven's mow at the seller's actual $100", () => {
    const rule = withParkRate({ ...MOW, id: "svc-mow" }, rates([["svc-mow", 16, 4]]));
    expect(priceService(rule, park(21))).toBe(100);
  });

  it("gives a park that has set no rate NO price — not The Haven's", () => {
    // The bug this whole migration exists to prevent. A brand-new park in a
    // different market has no row; it must not inherit 16 + 4/lot.
    const rule = withParkRate({ ...MOW, id: "svc-mow" }, rates([]));
    expect(priceService(rule, park(21))).toBe(0);
    expect(priceService(rule, park(60))).toBe(0);
  });

  it("does not leak one park's rate onto another park's service", () => {
    const haven = rates([["svc-mow", 16, 4]]);
    const other = withParkRate({ ...MOW, id: "svc-cleanup" }, haven);
    expect(priceService(other, park(21))).toBe(0);
  });

  it("reprices on its own when a lot comes online", () => {
    const rule = withParkRate({ ...MOW, id: "svc-mow" }, rates([["svc-mow", 16, 4]]));
    expect(priceService(rule, park(21))).toBe(100);
    expect(priceService(rule, park(25))).toBe(116); // 4 new pads, $16 more
  });

  it("honours a flat park rate that ignores the lot count", () => {
    // A park owner who pays $250 a visit no matter how full he is puts the
    // whole number in `base`. Adding lots must not move it.
    const rule = withParkRate({ ...MOW, id: "svc-mow" }, rates([["svc-mow", 250, 0]]));
    expect(priceService(rule, park(12))).toBe(250);
    expect(priceService(rule, park(40))).toBe(250);
  });

  it("never lets `note` reach the pricing rule", () => {
    // It is documentation. A stray column on a rule is how a reader somewhere
    // starts depending on a field the writer never promised.
    const withNote: ParkRates = new Map([
      ["svc-mow", { base: 16, unit_rate: 4, note: "From the seller: $100/week." }],
    ]);
    const rule = withParkRate({ ...MOW, id: "svc-mow" }, withNote);
    expect("note" in rule).toBe(false);
    expect(priceService(rule, park(21))).toBe(100);
  });

  it("leaves a service with no id alone rather than throwing", () => {
    const rule = withParkRate({ ...MOW }, rates([["svc-mow", 16, 4]]));
    expect(priceService(rule as ServiceRule, park(21))).toBe(0);
  });
});

describe("the screen and the invoice agree", () => {
  /**
   * FOUND ON SCREEN, not by a test: the rate editor previewed "$277.50 a
   * visit" for a rate that saved and charged $278. LakeLife prices in whole
   * dollars and the hand-rolled preview did not know it. Half a dollar is
   * small; a preview the owner cannot trust is not.
   *
   * The editor now calls priceService, so this asserts the property that broke
   * — the arithmetic a park owner reads is the arithmetic he is billed.
   */
  const cases: Array<[number, number, number]> = [
    [120, 7.5, 21],   // the one that drifted
    [16, 4, 21],      // The Haven's mow
    [0, 33.333, 3],   // a repeating third
    [99.99, 0, 40],   // flat, fractional
    [10.005, 0.005, 7],
  ];

  it.each(cases)("base %s + %s/lot at %i lots rounds the same both ways", (base, unit, lots) => {
    const engine = priceService(
      withParkRate({ ...MOW, id: "s" }, rates([["s", base, unit]])),
      park(lots),
    );
    // What the editor renders, by the same call it makes.
    const preview = priceService(
      { ...MOW, base, unit_rate: unit } as ServiceRule,
      park(lots),
    );
    expect(preview).toBe(engine);
    expect(Number.isInteger(engine)).toBe(true);
  });
});
