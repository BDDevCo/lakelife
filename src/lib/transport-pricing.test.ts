import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transportFee, billsByDistance, priceService, type ServiceRule, type PricingProfile } from "./pricing";

/**
 * TRANSPORT PRICING (0149) — a tow is as long as it is.
 *
 * Real arithmetic tests, not scans: this is money, and the function is pure.
 *
 * The shape is the owner's decision (29 Aug 2026), taken from Pointe Marine in
 * the research file: ONE all-in price covering everything inside a radius,
 * then a per-mile rate charged on the EXCESS ONLY — never on the whole tow.
 *
 * The load-bearing property is that it is INERT by default. `priceService` has
 * 25 call sites and not one knows where a boat wintered; the entire reason
 * transport lives in its own function is that 0115 proved what happens when a
 * pricing change reaches call sites that were not ready for it. So the tests
 * below spend as much effort on "changes nothing" as on the arithmetic.
 */
const rule = (over: Partial<ServiceRule> = {}): ServiceRule => ({
  name: "Boat return & splash",
  pricing_model: "flat",
  base: 285,
  unit_rate: 0,
  band_pricing: null,
  ...over,
});

const withDials = (included: number, perMile: number) =>
  rule({ band_pricing: { included_miles: included, per_mile_beyond: perMile } });

describe("transportFee — the excess only, never the whole tow", () => {
  it("charges nothing inside the included radius", () => {
    const r = withDials(20, 3.6);
    expect(transportFee(r, 0)).toBe(0);
    expect(transportFee(r, 12)).toBe(0);
    expect(transportFee(r, 20)).toBe(0); // the boundary is INSIDE — 20 included means 20 free
  });

  it("charges only the miles past the radius", () => {
    const r = withDials(20, 3.6);
    // The failure this pins: 25 × 3.60 = $90 instead of 5 × 3.60 = $18. Both
    // look plausible in a total; only one matches what the customer was told.
    expect(transportFee(r, 25)).toBe(18);
    expect(transportFee(r, 30)).toBe(36);
  });

  it("one mile past the radius costs one mile, not twenty-one", () => {
    // The discriminating edge case. `transportFee(r, 20) === 0` is true under
    // both excess-only and whole-tow arithmetic (0 × rate is 0 either way), so
    // it documents the boundary without testing it. This one does both.
    expect(transportFee(withDials(20, 3.6), 21)).toBe(4); // 1 × 3.60 → $4
  });

  it("a radius of zero charges from the first mile", () => {
    expect(transportFee(withDials(0, 3.6), 10)).toBe(36);
  });

  it("rounds to whole dollars, like every other price here", () => {
    expect(transportFee(withDials(20, 3.55), 27)).toBe(25); // 7 × 3.55 = 24.85
  });
});

describe("INERT unless somebody sets a rate", () => {
  it("no dials at all: no fee, whatever the distance", () => {
    expect(transportFee(rule(), 500)).toBe(0);
    expect(billsByDistance(rule())).toBe(false);
  });

  it("dials present but zero — the state 0149 ships — is still no fee", () => {
    const r = withDials(0, 0);
    expect(transportFee(r, 500)).toBe(0);
    expect(billsByDistance(r), "a zero rate must not make a service distance-priced").toBe(false);
  });

  it("a radius with no rate charges nothing — a radius alone is not a price", () => {
    expect(transportFee(withDials(20, 0), 100)).toBe(0);
  });

  it("does not disturb what priceService returns", () => {
    // The 0115 property: adding dials to a service must not move its own price.
    const profile = {
      sqft: 2000, beds: 3, baths: 2, pier_sections: 0, boat_lifts: 0, toy_lifts: 0,
      jet_skis: 0, pwc_lifts: 0, lawn_band: "medium", boats: [], toys: [],
    } as PricingProfile;
    expect(priceService(withDials(20, 3.6), profile)).toBe(priceService(rule(), profile));
  });
});

describe("an unmeasurable tow is never a free one", () => {
  it("returns 0 for an unknown distance — and the CALLER must refuse", () => {
    // 0 here means "this function has nothing to add", NOT "the tow is free".
    // Deciding that a null distance is chargeable is the booking action's job,
    // and it refuses the booking rather than quoting a price it can't stand by.
    const r = withDials(20, 3.6);
    expect(transportFee(r, null)).toBe(0);
    expect(transportFee(r, Number.NaN)).toBe(0);
    expect(transportFee(r, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("a negative distance is not a discount", () => {
    expect(transportFee(withDials(20, 3.6), -50)).toBe(0);
  });
});

describe("the booking action is where an unmeasurable tow is refused", () => {
  const code = readFileSync(join(process.cwd(), "src/app/book/actions.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const block = () => {
    const m = code.match(/if \(billsByDistance\(priceRule\)\) \{[\s\S]*?\n  \}/);
    expect(m?.[0], "the transport block was not found — this scan is stale").toBeTruthy();
    return m?.[0] ?? "";
  };

  it("refuses rather than quoting a price it cannot compute", () => {
    expect(block(), "an unmeasurable tow must not fall through to a free one")
      .toMatch(/!Number\.isFinite\(miles\)/);
    expect(block(), "and that refusal must return an error").toMatch(/ok: false/);
  });

  it("blames OUR missing pin on us, not on the customer's typing", () => {
    // Two different causes, two different fixes. Telling somebody to re-pick
    // the marina when it is our own property that has no coordinates sends
    // them to correct something that is already right.
    expect(block()).toMatch(/propLat == null \|\| propLng == null/);
    expect(block(), "the property-side failure needs its own sentence")
      .toMatch(/pinned on the map/);
  });

  it("measures from the pickup, never from a number the browser sent", () => {
    expect(block()).toMatch(/milesBetween\(\s*pickup\?\.lat/);
    expect(block(), "the property end comes from the database")
      .toMatch(/from\("properties"\)/);
  });

  it("adds transport AFTER the $0 refusal, so that guard still means something", () => {
    const zeroGuard = code.indexOf("standardPrice <= 0");
    const transport = code.indexOf("billsByDistance(priceRule)");
    expect(zeroGuard).toBeGreaterThan(-1);
    expect(transport, "a tow must not rescue a service that prices to $0")
      .toBeGreaterThan(zeroGuard);
  });
});

describe("0149 on disk", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/0149_a_tow_is_as_long_as_it_is.sql"), "utf8",
  );

  it("ships inert, and asserts that it did", () => {
    expect(sql).toMatch(/"included_miles": 0, "per_mile_beyond": 0/);
    expect(sql, "the migration must prove it changed no quote")
      .toMatch(/this migration ships inert/);
  });

  it("refuses a distance rate on a service that never asks where the boat is", () => {
    expect(sql).toMatch(/bills by distance but never asks where the boat is/);
  });

  it("does not invent a price", () => {
    // The standing rule: an unpriced service is the SAFE state. The research
    // numbers appear as a commented-out UPDATE for him to run, never as one.
    const live = sql.replace(/^--.*$/gm, "");
    expect(live, "no live statement may set a per-mile rate")
      .not.toMatch(/set band_pricing[\s\S]*per_mile_beyond": *[1-9]/);
  });
});
