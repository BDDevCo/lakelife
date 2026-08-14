import { describe, it, expect } from "vitest";
import { buildOwnedHomeRow, ownedHomeAddress } from "./service-helpers";
import { priceService, type ServiceRule, type PricingProfile } from "@/lib/pricing";

/**
 * A HOME THE PARK OWNS IS STILL A HOME — and the one thing that had to be got
 * right is its SIZE, because getting it wrong is invisible.
 */

/** The real Housekeeping row: bands at 1800 and 2800. */
const HOUSEKEEPING: ServiceRule = {
  name: "Housekeeping",
  pricing_model: "per_sqft_band",
  base: 0,
  unit_rate: 0,
  band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
};

const home = (sqft: number) => ({ sqft, beds: 3, baths: 2 } as unknown as PricingProfile);

describe("how big is the home", () => {
  it("takes width by length, the way a title describes it", () => {
    // The Haven's Lot 11: a 2019 28x60 Shult.
    const r = buildOwnedHomeRow({ widthFt: "28", lengthFt: "60", beds: "3", baths: "2" });
    expect(r.ok).toBe(true);
    expect(r.row).toEqual({ sqft: 1680, beds: 3, baths: 2 });
  });

  it("REFUSES a blank size, because the wrong answer looks like the right one", () => {
    // THE WHOLE REASON THIS IS REQUIRED. Housekeeping picks the first band
    // whose max exceeds sqft, so an unset 0 lands at $80 — exactly what a real
    // 1,680 sq ft double-wide costs. Nothing downstream could ever catch it.
    expect(priceService(HOUSEKEEPING, home(0))).toBe(80);
    expect(priceService(HOUSEKEEPING, home(1680))).toBe(80);

    const r = buildOwnedHomeRow({ widthFt: "", lengthFt: "", beds: "3", baths: "2" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("14 by 70");
  });

  it("prices the bands it is meant to", () => {
    const single = buildOwnedHomeRow({ widthFt: "14", lengthFt: "70", beds: "2", baths: "1" });
    expect(single.row!.sqft).toBe(980);
    expect(priceService(HOUSEKEEPING, home(single.row!.sqft))).toBe(80);

    // A big double-wide crosses into the middle band, and that is a real $15.
    const big = buildOwnedHomeRow({ widthFt: "32", lengthFt: "70", beds: "4", baths: "2" });
    expect(big.row!.sqft).toBe(2240);
    expect(priceService(HOUSEKEEPING, home(big.row!.sqft))).toBe(95);
  });

  it("catches inches typed as feet", () => {
    // 336 by 720 is a 28x60 in inches. Left alone it would price at $120 and
    // look like a mansion.
    const r = buildOwnedHomeRow({ widthFt: "336", lengthFt: "720", beds: "3", baths: "2" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("inches");
  });

  it("keeps a half bath a half", () => {
    expect(buildOwnedHomeRow({ widthFt: "28", lengthFt: "60", beds: "3", baths: "2.5" }).row!.baths)
      .toBe(2.5);
    // But not a third of one — the column is a number a person says out loud.
    expect(buildOwnedHomeRow({ widthFt: "28", lengthFt: "60", beds: "3", baths: "2.3" }).row!.baths)
      .toBe(2.5);
  });

  it("refuses nonsense rather than storing it", () => {
    expect(buildOwnedHomeRow({ widthFt: "-28", lengthFt: "60", beds: "3", baths: "2" }).ok).toBe(false);
    expect(buildOwnedHomeRow({ widthFt: "wide", lengthFt: "60", beds: "3", baths: "2" }).ok).toBe(false);
    expect(buildOwnedHomeRow({ widthFt: "28", lengthFt: "60", beds: "99", baths: "2" }).ok).toBe(false);
  });

  it("gives the crew an address they can put in a map", () => {
    expect(ownedHomeAddress("11", "The Haven", "1 Haven Rd, Angola IN"))
      .toBe("Lot 11, The Haven, 1 Haven Rd, Angola IN");
  });
});
