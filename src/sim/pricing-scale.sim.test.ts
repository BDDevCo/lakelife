/**
 * SCALE SIMULATION — pricing, packages & storage money.
 *
 * ~1,100 lake-home profiles across 6 lakes, two full seasons of activity,
 * every seeded service, all three storage packages, thousands of randomized
 * selections, stays, overstays and spring true-ups — all driven through the
 * REAL engines:
 *
 *   src/lib/pricing.ts   priceService, boatFeet
 *   src/lib/packages.ts  validateSelection, defaultSelection, anchorServiceId
 *   src/lib/storage.ts   seasonEndFor, overstayDays, perdiemCharge, trueLegsToQuote
 *   src/lib/rush.ts      rushPrice, fillInRate
 *
 * Nothing here re-implements the logic under test: the service RULES are
 * copied verbatim from supabase/seed/seed_services.sql and migration
 * 0033_storage_seeds.sql (rule 8 — the numbers live in data), and the
 * package RECIPES are the exact rows from 0033. Everything else is
 * generated world + invariant checks.
 *
 * DETERMINISM: one seeded mulberry32 PRNG, never Math.random(). Every
 * failure message carries the seed so a red run reproduces exactly.
 *
 * HISTORY: this sim was written DURING the two-season audit
 * (docs/two-season-audit-2026-07.md) and originally PINNED the defects it
 * found at their then-current (wrong) behavior. Those engine bugs were fixed
 * in 2026-08, so every one of those pins is now a REGRESSION GUARD asserting
 * the CORRECT behavior, labelled `REGRESSION (audit bug N)` with a past-tense
 * note saying what used to happen. A `SIM-FOUND` label that survives is a
 * finding that has NOT been fixed and is still pinned at current behavior.
 */

import { describe, it, expect } from "vitest";
import { priceService, boatFeet, type ServiceRule, type PricingProfile } from "@/lib/pricing";
import {
  validateSelection,
  defaultSelection,
  anchorServiceId,
  type PackageView,
  type PackageComponentView,
} from "@/lib/packages";
import { seasonEndFor, overstayDays, perdiemCharge, trueLegsToQuote } from "@/lib/storage";
import { rushPrice, fillInRate } from "@/lib/rush";

// ─────────────────────────────────────────────────────────────────────
//  Seeded PRNG — print SEED in every failure so a red run reproduces.
// ─────────────────────────────────────────────────────────────────────
const SEED = 20260726;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rnd(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const why = (msg: string) => `${msg}  [seed=${SEED}]`;

/** Case counter — what this sim actually exercised. */
let CASES = 0;
const bump = (n = 1) => {
  CASES += n;
};

/** Collect failures, assert once — fast, and shows the MINIMAL first repro. */
function firstFailure(fails: string[]): string | null {
  return fails.length ? `${fails.length} failure(s); first: ${fails[0]}` : null;
}

// ─────────────────────────────────────────────────────────────────────
//  THE MENU — verbatim from supabase/seed/seed_services.sql
// ─────────────────────────────────────────────────────────────────────
interface CatalogEntry {
  key: string;
  rule: ServiceRule;
  /** Does this property actually own what the service covers? */
  owns: (p: PricingProfile) => boolean;
}

const MENU: CatalogEntry[] = [
  {
    key: "opening",
    rule: { name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0 },
    owns: () => true, // a house is a house
  },
  {
    key: "winterization",
    rule: { name: "Fall winterization", pricing_model: "flat", base: 485, unit_rate: 0 },
    owns: () => true,
  },
  {
    key: "pier",
    rule: {
      name: "Pier install / removal",
      pricing_model: "per_section",
      base: 220,
      unit_rate: 48,
      band_pricing: { count_field: "pier_sections" },
    },
    owns: (p) => p.pier_sections > 0,
  },
  {
    key: "boatlift",
    rule: {
      name: "Boat lift set / pull",
      pricing_model: "per_section",
      base: 0,
      unit_rate: 495,
      band_pricing: { count_field: "boat_lifts", min_count: 1 },
    },
    owns: (p) => p.boat_lifts > 0,
  },
  {
    key: "jetski",
    rule: {
      name: "Jet ski winterize & store",
      pricing_model: "per_section",
      base: 0,
      unit_rate: 350,
      band_pricing: { count_field: "jet_skis" },
    },
    owns: (p) => p.jet_skis > 0,
  },
  {
    key: "pwclift",
    rule: {
      name: "PWC lift set / pull",
      pricing_model: "per_section",
      base: 0,
      unit_rate: 165,
      band_pricing: { count_field: "pwc_lifts" },
    },
    owns: (p) => p.pwc_lifts > 0,
  },
  {
    key: "boatstore",
    rule: { name: "Boat storage & winterize", pricing_model: "per_foot", base: 0, unit_rate: 50 },
    owns: (p) => boatFeet(p) > 0,
  },
  {
    key: "watertoys",
    rule: {
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
    owns: (p) => p.toy_lifts > 0 || p.toys.length > 0,
  },
  {
    key: "lawn",
    rule: {
      name: "Lawn mowing & trim",
      pricing_model: "band",
      base: 0,
      unit_rate: 0,
      band_pricing: { small: 65, medium: 85, large: 110 },
    },
    owns: () => true,
  },
  {
    key: "housekeeping",
    rule: {
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
    owns: () => true,
  },
];

/** Storage/winterize components & add-ons — verbatim from 0033_storage_seeds.sql. */
const COMPONENTS: Array<{
  name: string;
  kind: "component" | "addon";
  rule: ServiceRule;
}> = [
  {
    name: "Boat winterization (shop)",
    kind: "component",
    rule: {
      name: "Boat winterization (shop)",
      pricing_model: "per_foot",
      base: 0,
      unit_rate: 12,
      // 0034_boat_engines: winterization also prices per engine, additively.
      band_pricing: {
        per_engine_hp_tiers: [
          { max: 150, price: 120 },
          { max: 300, price: 190 },
          { max: null, price: 260 },
        ],
      },
    },
  },
  {
    name: "Spring de-winterize & test run",
    kind: "component",
    rule: {
      name: "Spring de-winterize & test run",
      pricing_model: "per_foot",
      base: 0,
      unit_rate: 9,
      band_pricing: {
        per_engine_hp_tiers: [
          { max: 150, price: 90 },
          { max: 300, price: 140 },
          { max: null, price: 190 },
        ],
      },
    },
  },
  {
    name: "Boat haul-out (we pick it up)",
    kind: "component",
    rule: { name: "Boat haul-out (we pick it up)", pricing_model: "flat", base: 285, unit_rate: 0 },
  },
  {
    name: "Boat return & splash",
    kind: "component",
    rule: { name: "Boat return & splash", pricing_model: "flat", base: 285, unit_rate: 0 },
  },
  {
    name: "Winter storage — outdoor",
    kind: "component",
    rule: {
      name: "Winter storage — outdoor",
      pricing_model: "seasonal_plus_perdiem",
      base: 0,
      unit_rate: 43,
      band_pricing: {},
    },
  },
  {
    name: "Winter storage — indoor",
    kind: "component",
    rule: {
      name: "Winter storage — indoor",
      pricing_model: "seasonal_plus_perdiem",
      base: 0,
      unit_rate: 64,
      band_pricing: {},
    },
  },
  { name: "Shrink wrap", kind: "addon", rule: { name: "Shrink wrap", pricing_model: "per_foot", base: 0, unit_rate: 26 } },
  {
    name: "Battery care (pull, tend, reinstall)",
    kind: "addon",
    rule: { name: "Battery care (pull, tend, reinstall)", pricing_model: "flat", base: 90, unit_rate: 0 },
  },
  {
    name: "Engine oil & filter change",
    kind: "addon",
    rule: { name: "Engine oil & filter change", pricing_model: "flat", base: 180, unit_rate: 0 },
  },
];

const svcId = (name: string) => `svc-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/** Package recipes — the exact (pkg, service, phase, required, default_on) rows from 0033. */
const RECIPES: Record<string, Array<[string, "fall" | "spring", boolean, boolean]>> = {
  you_tow: [
    ["Boat winterization (shop)", "fall", true, true],
    ["Winter storage — outdoor", "fall", false, false],
    ["Winter storage — indoor", "fall", false, false],
    ["Shrink wrap", "fall", false, false],
    ["Spring de-winterize & test run", "spring", false, true],
    ["Boat return & splash", "spring", false, false],
  ],
  we_haul: [
    ["Boat haul-out (we pick it up)", "fall", true, true],
    ["Boat winterization (shop)", "fall", true, true],
    ["Boat return & splash", "fall", false, false],
    ["Winter storage — outdoor", "fall", false, true],
    ["Winter storage — indoor", "fall", false, false],
    ["Shrink wrap", "fall", false, true],
    ["Boat haul-out (we pick it up)", "spring", false, false],
    ["Spring de-winterize & test run", "spring", false, true],
    ["Boat return & splash", "spring", false, true],
  ],
  storage_only: [
    ["Winter storage — outdoor", "fall", false, true],
    ["Winter storage — indoor", "fall", false, false],
    ["Boat haul-out (we pick it up)", "fall", false, false],
    ["Boat return & splash", "spring", false, false],
  ],
};

const PKG_NAMES: Record<string, string> = {
  you_tow: "You tow it to the shop",
  we_haul: "We pick it up",
  storage_only: "Winter storage only",
};

/**
 * The recipe row that IS the trip home. Keyed on the seed row's identity —
 * the thing migration 0051 turns into `role = 'return_leg'` on the component
 * row — never on services.name, which ops may rename at any time (audit bug
 * 7). `ruleOverrides` below renames the DISPLAY name of this same row and the
 * tag must survive it, which is exactly the regression this fixture protects.
 */
const RETURN_LEG_SEED_NAME = "Boat return & splash";

/**
 * Mirror of src/app/book/storage/data.ts getPackageViews — WIRING only
 * (it maps recipe rows to views and calls the real priceService for every
 * price); the legality and the money math under test stay in packages.ts.
 *
 * `tagReturnLeg = false` reproduces a package whose return leg is NOT
 * identified (a recipe migration 0051 never reached, or a hand-inserted row)
 * — the fail-closed case, exercised below.
 */
function buildPackageViews(
  profile: PricingProfile,
  ruleOverrides?: Record<string, ServiceRule>,
  tagReturnLeg = true,
): PackageView[] {
  const byName = new Map(COMPONENTS.map((c) => [c.name, c]));
  return Object.keys(RECIPES).map((code) => {
    const components: PackageComponentView[] = RECIPES[code]
      .map(([name, phase, required, defaultOn]) => {
        const c = byName.get(name)!;
        const rule = ruleOverrides?.[name] ?? c.rule;
        return {
          serviceId: svcId(name),
          name: rule.name,
          phase,
          required,
          defaultOn,
          kind: c.kind,
          pricingModel: c.rule.pricing_model,
          price: priceService(rule, profile),
          isStorageTier: c.rule.pricing_model === "seasonal_plus_perdiem",
          role: tagReturnLeg && name === RETURN_LEG_SEED_NAME ? ("return_leg" as const) : null,
        };
      })
      // same ordering the server hands the wizard
      .sort((a, b) =>
        a.phase === b.phase
          ? a.required === b.required
            ? a.name.localeCompare(b.name)
            : a.required
              ? -1
              : 1
          : a.phase === "fall"
            ? -1
            : 1,
      );
    return { id: `pkg-${code}`, code, name: PKG_NAMES[code], description: null, components };
  });
}

// ─────────────────────────────────────────────────────────────────────
//  THE WORLD — ~1,100 properties, 6 lakes, HOA blocks, 2 seasons
// ─────────────────────────────────────────────────────────────────────
const LAKES = [
  "Big Long", // 3 starting lakes ...
  "Pretty",
  "Big Turkey",
  "Little Turkey", // ... growing to 6 over season two
  "Jimmerson",
  "Crooked",
];

const BOAT_TYPES = ["Pontoon", "Tritoon", "Bowrider", "Ski boat", "Cruiser", "Fishing boat", "Sailboat"];
const ENGINE_TYPES: Array<string | null> = ["outboard", "sterndrive", "inboard", "jet", "none", null];

interface SimProperty {
  id: string;
  lake: string;
  hoa: string | null;
  season: 1 | 2;
  profile: PricingProfile;
}

function makeProfile(): PricingProfile {
  const boatCount = chance(0.12) ? 0 : chance(0.72) ? 1 : chance(0.75) ? 2 : 3;
  const boats: PricingProfile["boats"] = [];
  for (let i = 0; i < boatCount; i++) {
    const type = pick(BOAT_TYPES);
    const engine_type = type === "Sailboat" ? (chance(0.6) ? "none" : "outboard") : pick(ENGINE_TYPES);
    boats.push({
      type,
      length_ft: int(14, 34),
      engine_type,
      engine_hp: engine_type === "none" ? 0 : chance(0.15) ? null : int(40, 450),
      engines: chance(0.18) ? 2 : 1,
    });
  }
  const toyCount = chance(0.28) ? 0 : int(1, 6);
  return {
    sqft: int(850, 6800),
    beds: int(1, 7),
    baths: int(1, 5),
    pier_sections: chance(0.1) ? 0 : int(3, 18),
    boat_lifts: chance(0.24) ? 0 : int(1, 3),
    toy_lifts: chance(0.45) ? 0 : int(1, 2),
    jet_skis: chance(0.55) ? 0 : int(1, 4),
    pwc_lifts: chance(0.6) ? 0 : int(1, 3),
    lawn_band: pick(["small", "medium", "large"] as const),
    boats,
    toys: Array.from({ length: toyCount }, () => ({ name: pick(["Kayak", "Paddleboard", "Water trampoline", "Tube", "Lily pad"]) })),
  };
}

const PROPERTIES: SimProperty[] = (() => {
  const out: SimProperty[] = [];
  // 3 organic HOA-scale accounts (one association, many identical-ish units)
  const hoas = [
    { name: "Turkey Point Association", lake: "Big Turkey", units: 42 },
    { name: "Pretty Lake Shores HOA", lake: "Pretty", units: 28 },
    { name: "Jimmerson Cove Condos", lake: "Jimmerson", units: 19 },
  ];
  for (const h of hoas) {
    for (let u = 0; u < h.units; u++) {
      out.push({
        id: `${h.name}#${u}`,
        lake: h.lake,
        hoa: h.name,
        season: u % 3 === 0 ? 2 : 1,
        profile: makeProfile(),
      });
    }
  }
  while (out.length < 1100) {
    const i = out.length;
    // seasons 1 & 2; lakes 4-6 only exist in season two (lakes are born from demand)
    const season: 1 | 2 = i % 5 === 0 ? 2 : 1;
    const lake = season === 1 ? pick(LAKES.slice(0, 3)) : pick(LAKES);
    out.push({ id: `prop-${i}`, lake, hoa: null, season, profile: makeProfile() });
  }
  return out;
})();

// ─────────────────────────────────────────────────────────────────────
//  1. UNIVERSAL SANITY — nothing ever returns NaN / Infinity / negative
// ─────────────────────────────────────────────────────────────────────
describe("scale: every price on every menu, for every property", () => {
  it("is finite, non-negative and a whole dollar", () => {
    const fails: string[] = [];
    const all: Array<{ key: string; rule: ServiceRule }> = [
      ...MENU.map((m) => ({ key: m.key, rule: m.rule })),
      ...COMPONENTS.map((c) => ({ key: c.name, rule: c.rule })),
    ];
    for (const prop of PROPERTIES) {
      for (const s of all) {
        const price = priceService(s.rule, prop.profile);
        bump();
        if (!Number.isFinite(price) || price < 0 || !Number.isInteger(price)) {
          fails.push(why(`${s.key} on ${prop.id} priced ${price} (profile=${JSON.stringify(prop.profile)})`));
          if (fails.length > 3) break;
        }
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("prices the same inputs identically every time (pure)", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES.slice(0, 200)) {
      for (const m of MENU) {
        const a = priceService(m.rule, prop.profile);
        const b = priceService(m.rule, prop.profile);
        bump(2);
        if (a !== b) fails.push(why(`${m.key} on ${prop.id}: ${a} then ${b}`));
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. THE $0 GUARD AND ITS BLIND SPOT
// ─────────────────────────────────────────────────────────────────────
describe("scale: owners never price to $0; non-owners are the interesting case", () => {
  it("a property that OWNS the covered equipment never prices to $0", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES) {
      for (const m of MENU) {
        if (!m.owns(prop.profile)) continue;
        const price = priceService(m.rule, prop.profile);
        bump();
        if (!(price > 0)) fails.push(why(`${m.key} priced $0 for owner ${prop.id}: ${JSON.stringify(prop.profile)}`));
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("pure-multiplier services price $0 for non-owners — the guard in createBooking catches these", () => {
    const zeroEquip: PricingProfile = {
      sqft: 2200,
      beds: 3,
      baths: 2,
      pier_sections: 0,
      boat_lifts: 0,
      toy_lifts: 0,
      jet_skis: 0,
      pwc_lifts: 0,
      lawn_band: "medium",
      boats: [],
      toys: [],
    };
    bump(3);
    expect(priceService(MENU.find((m) => m.key === "jetski")!.rule, zeroEquip)).toBe(0);
    expect(priceService(MENU.find((m) => m.key === "pwclift")!.rule, zeroEquip)).toBe(0);
    expect(priceService(MENU.find((m) => m.key === "boatstore")!.rule, zeroEquip)).toBe(0);
  });

  // REGRESSION (audit bug 5): a service that COUNTS equipment used to quote a
  // customer who owns none of it a real, bookable price, because the "$0 = you
  // don't own this" guard in src/app/book/actions.ts only ever caught pure
  // multipliers. A `base` (pier $220, water toys $120) or a `min_count` floor
  // (boat lift $495) sailed straight past it — 501 phantom-priced tiles across
  // these 1,100 properties (~455 per 1,000 customers per season), each one a
  // crew dispatched to a property with nothing to do. priceService now asks
  // serviceApplies() FIRST and returns 0 when the property owns none of the
  // equipment the rule's own data names, so the guard sees every case.
  it("REGRESSION (audit bug 5): equipment services price to $0 for a non-owner, never a phantom price", () => {
    const zeroEquip: PricingProfile = {
      sqft: 2200,
      beds: 3,
      baths: 2,
      pier_sections: 0,
      boat_lifts: 0,
      toy_lifts: 0,
      jet_skis: 0,
      pwc_lifts: 0,
      lawn_band: "medium",
      boats: [],
      toys: [],
    };
    bump(3);
    // Was 220 / 495 / 120 respectively — the three floored/based rules.
    expect(priceService(MENU.find((m) => m.key === "pier")!.rule, zeroEquip)).toBe(0);
    expect(priceService(MENU.find((m) => m.key === "boatlift")!.rule, zeroEquip)).toBe(0);
    expect(priceService(MENU.find((m) => m.key === "watertoys")!.rule, zeroEquip)).toBe(0);

    // …and the fix is NARROW: a rule that counts no equipment still applies to
    // everybody. Seasonal and land work must not be touched by the gate.
    bump(4);
    expect(priceService(MENU.find((m) => m.key === "opening")!.rule, zeroEquip)).toBe(430);
    expect(priceService(MENU.find((m) => m.key === "winterization")!.rule, zeroEquip)).toBe(485);
    expect(priceService(MENU.find((m) => m.key === "lawn")!.rule, zeroEquip)).toBe(85);
    expect(priceService(MENU.find((m) => m.key === "housekeeping")!.rule, zeroEquip)).toBe(95);

    // Owning ONE of the counted things is enough to bring the tile back, at
    // the honest floored price — the gate is applicability, not a discount.
    bump(2);
    expect(priceService(MENU.find((m) => m.key === "pier")!.rule, { ...zeroEquip, pier_sections: 1 })).toBe(268);
    expect(priceService(MENU.find((m) => m.key === "boatlift")!.rule, { ...zeroEquip, boat_lifts: 1 })).toBe(495);

    // Scale reading: the phantom-tile count over the whole population is now
    // ZERO, and every non-owner tile reads $0 so the booking guard refuses it.
    let phantomTiles = 0;
    let zeroTiles = 0;
    const perService: Record<string, number> = {};
    for (const prop of PROPERTIES) {
      for (const m of MENU) {
        if (m.owns(prop.profile)) continue;
        const price = priceService(m.rule, prop.profile);
        bump();
        if (price > 0) {
          phantomTiles++;
          perService[m.key] = (perService[m.key] ?? 0) + 1;
        } else {
          zeroTiles++;
        }
      }
    }
    // RECALIBRATED: was `phantomTiles > 400` (measured 501, of which boat lift
    // 258, water toys 124, pier 119). The fix removes the whole category, so
    // the honest assertion is exact zero — and nothing may creep back.
    expect(perService).toEqual({});
    expect(phantomTiles).toBe(0);
    // RECALIBRATED: was `zeroTiles > 1200` (measured 1,383). The 501 former
    // phantoms moved into this bucket, so it is now 1,884 — same tiles, all
    // of them now honestly $0 and un-bookable.
    expect(zeroTiles).toBeGreaterThan(1800);
    expect(phantomTiles + zeroTiles).toBe(
      PROPERTIES.reduce((n, prop) => n + MENU.filter((m) => !m.owns(prop.profile)).length, 0),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. MONOTONICITY — more equipment must never cost less
// ─────────────────────────────────────────────────────────────────────
describe("scale: monotonicity across every countable dimension", () => {
  it("adding pier sections / lifts / jet skis / toys / boat feet / sqft never lowers a price", () => {
    const fails: string[] = [];
    const bumps: Array<[string, (p: PricingProfile) => PricingProfile]> = [
      ["pier_sections+1", (p) => ({ ...p, pier_sections: p.pier_sections + 1 })],
      ["boat_lifts+1", (p) => ({ ...p, boat_lifts: p.boat_lifts + 1 })],
      ["toy_lifts+1", (p) => ({ ...p, toy_lifts: p.toy_lifts + 1 })],
      ["jet_skis+1", (p) => ({ ...p, jet_skis: p.jet_skis + 1 })],
      ["pwc_lifts+1", (p) => ({ ...p, pwc_lifts: p.pwc_lifts + 1 })],
      ["+1 toy", (p) => ({ ...p, toys: [...p.toys, { name: "Kayak" }] })],
      ["+1ft on boat 0", (p) => ({ ...p, boats: p.boats.length ? [{ ...p.boats[0], length_ft: p.boats[0].length_ft + 1 }, ...p.boats.slice(1)] : [{ type: "Pontoon", length_ft: 1, engine_type: "outboard", engine_hp: 150, engines: 1 }] })],
      ["+1 boat (20ft)", (p) => ({ ...p, boats: [...p.boats, { type: "Bowrider", length_ft: 20, engine_type: "outboard", engine_hp: 200, engines: 1 }] })],
      ["sqft +250", (p) => ({ ...p, sqft: p.sqft + 250 })],
      ["+1 engine on boat 0", (p) => ({ ...p, boats: p.boats.length ? [{ ...p.boats[0], engines: (p.boats[0].engines ?? 1) + 1 }, ...p.boats.slice(1)] : p.boats })],
    ];
    const rules: Array<{ key: string; rule: ServiceRule }> = [
      ...MENU.map((m) => ({ key: m.key, rule: m.rule })),
      ...COMPONENTS.map((c) => ({ key: c.name, rule: c.rule })),
    ];
    for (const prop of PROPERTIES.slice(0, 450)) {
      for (const [label, f] of bumps) {
        const bigger = f(prop.profile);
        for (const r of rules) {
          const before = priceService(r.rule, prop.profile);
          const after = priceService(r.rule, bigger);
          bump(2);
          if (after < before) {
            fails.push(why(`${r.key}: ${label} on ${prop.id} DROPPED ${before} → ${after} (profile=${JSON.stringify(prop.profile)})`));
            if (fails.length > 3) break;
          }
        }
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("bigger HP never prices a winterization engine-add lower", () => {
    const fails: string[] = [];
    const winterize = COMPONENTS.find((c) => c.name === "Boat winterization (shop)")!.rule;
    const base: PricingProfile = { ...PROPERTIES[0].profile, boats: [] };
    let last = -1;
    for (let hp = 0; hp <= 700; hp++) {
      const price = priceService(winterize, {
        ...base,
        boats: [{ type: "Bowrider", length_ft: 22, engine_type: "outboard", engine_hp: hp, engines: 1 }],
      });
      bump();
      if (price < last) fails.push(why(`winterization DROPPED at hp=${hp}: ${last} → ${price}`));
      last = price;
    }
    expect(firstFailure(fails)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. BAND & TIER BOUNDARIES — no gap, no overlap, no cliff surprise
// ─────────────────────────────────────────────────────────────────────
describe("scale: band + sqft-tier boundaries", () => {
  it("housekeeping is non-decreasing across every square foot 0..8000, with no gap", () => {
    const clean = MENU.find((m) => m.key === "housekeeping")!.rule;
    const base = PROPERTIES[0].profile;
    const fails: string[] = [];
    let last = -1;
    const cliffs: Array<[number, number, number]> = [];
    for (let sqft = 0; sqft <= 8000; sqft++) {
      const price = priceService(clean, { ...base, sqft });
      bump();
      if (price <= 0) fails.push(why(`housekeeping priced ${price} at sqft=${sqft}`));
      if (last >= 0 && price < last) fails.push(why(`housekeeping DROPPED at sqft=${sqft}: ${last} → ${price}`));
      if (last >= 0 && price > last) cliffs.push([sqft, last, price]);
      last = price;
    }
    expect(firstFailure(fails)).toBeNull();
    // Exactly two boundaries, each a modest step — no missing tier, no cliff.
    expect(cliffs).toEqual([
      [1800, 80, 95],
      [2800, 95, 120],
    ]);
  });

  it("the lawn band ladder is ordered small ≤ medium ≤ large as seeded", () => {
    const lawn = MENU.find((m) => m.key === "lawn")!.rule;
    const p = PROPERTIES[0].profile;
    const s = priceService(lawn, { ...p, lawn_band: "small" });
    const m = priceService(lawn, { ...p, lawn_band: "medium" });
    const l = priceService(lawn, { ...p, lawn_band: "large" });
    bump(3);
    expect(s).toBeLessThanOrEqual(m);
    expect(m).toBeLessThanOrEqual(l);
  });

  // SIM-FOUND BUG (low): the `band` model falls back to `rule.base` for an
  // unrecognized band key, and the seeded lawn row has base = 0 — so an
  // off-list value in properties.lawn_band prices the mow at $0. The column
  // is free text with no CHECK constraint (0001_schema.sql line 85) and
  // src/app/profile/actions.ts writes input.lawn_band through with no runtime
  // validation (the union type is compile-time only, and a "use server"
  // export is a network endpoint). Read paths default NULL → "medium", so
  // only a non-null off-list value gets through — and then the customer's
  // lawn tile reads $0 and createBooking refuses with an "equipment you
  // don't own" message about a lawn.
  it("SIM-FOUND BUG: an off-list lawn_band prices the mow at $0", () => {
    const lawn = MENU.find((m) => m.key === "lawn")!.rule;
    const p = PROPERTIES[0].profile;
    bump(2);
    expect(priceService(lawn, { ...p, lawn_band: "medium" })).toBe(85);
    expect(priceService(lawn, { ...p, lawn_band: "xl" as unknown as "large" })).toBe(0);
  });

  // REGRESSION (audit bug 6): nothing used to keep the band/tier LADDER
  // sorted. executeMenuUpdate (src/lib/menu-core.ts) can only move the MIDDLE
  // rung ("band:medium" / "tier:mid") and gated it solely on a 40% cap against
  // that rung's OWN current value, never against the rung above. Margin Health
  // proposes exactly those fields and a one-tap Apply wrote them: 85 × 1.4 =
  // 119 > large 110, and 95 × 1.4 = 133 > top tier 120. The guard now refuses
  // any mid-rung write that would cross a neighbouring rung, which is the ONLY
  // defence — as this test shows, priceService faithfully quotes whatever the
  // menu says, so an inverted ladder has to be stopped at the write.
  // (The refusal itself is asserted directly in src/lib/menu-core.test.ts;
  // this is the blast radius it prevents, measured over the population.)
  it("REGRESSION (audit bug 6): an inverted ladder is priced verbatim — which is why the write must refuse it", () => {
    const p = PROPERTIES[0].profile;

    // The write executeMenuUpdate USED to accept: 118 <= 85 * 1.4 clears the
    // 40% cap, and nothing else looked at the $110 large band above it.
    expect(118).toBeLessThanOrEqual(85 * 1.4);
    const tunedLawn: ServiceRule = {
      name: "Lawn mowing & trim",
      pricing_model: "band",
      base: 0,
      unit_rate: 0,
      band_pricing: { small: 65, medium: 118, large: 110 },
    };
    const med = priceService(tunedLawn, { ...p, lawn_band: "medium" });
    const lrg = priceService(tunedLawn, { ...p, lawn_band: "large" });
    bump(2);
    expect(med).toBe(118);
    expect(lrg).toBe(110);
    expect(med).toBeGreaterThan(lrg); // ← the inversion, priced and shown

    // Same story for housekeeping: 133 <= 95 * 1.4, top tier stays 120.
    expect(133).toBeLessThanOrEqual(95 * 1.4);
    const tunedClean: ServiceRule = {
      name: "Housekeeping",
      pricing_model: "per_sqft_band",
      base: 0,
      unit_rate: 0,
      band_pricing: {
        tiers: [
          { max: 1800, price: 80 },
          { max: 2800, price: 133 },
          { max: null, price: 120 },
        ],
      },
    };
    const midHome = priceService(tunedClean, { ...p, sqft: 2000 });
    const bigHome = priceService(tunedClean, { ...p, sqft: 5000 });
    bump(2);
    expect(midHome).toBe(133);
    expect(bigHome).toBe(120);
    expect(midHome).toBeGreaterThan(bigHome); // ← smaller house pays more

    // How many of our 1,100 properties would be quoted MORE than a strictly
    // bigger neighbour after that one tap?
    let inverted = 0;
    for (const prop of PROPERTIES) {
      bump();
      if (priceService(tunedClean, prop.profile) > priceService(tunedClean, { ...prop.profile, sqft: 6000 })) inverted++;
    }
    expect(inverted).toBeGreaterThan(150); // ~1 in 6 of the population, mid-size homes
  });
});

// ─────────────────────────────────────────────────────────────────────
//  5. RUSH — premium is never a discount, never NaN
// ─────────────────────────────────────────────────────────────────────
describe("scale: same-day rush pricing", () => {
  it("rush ≥ standard, finite, whole dollars, across every dial the settings allow", () => {
    const fails: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const menu = chance(0.03) ? 0 : int(1, 4000);
      const pct = Math.round(rnd() * 100) / 100; // parseSetting clamps to [0,1]
      const rush = rushPrice(menu, pct);
      bump();
      if (!Number.isFinite(rush)) fails.push(why(`rushPrice(${menu},${pct}) = ${rush}`));
      else if (rush < 0) fails.push(why(`rushPrice(${menu},${pct}) negative: ${rush}`));
      else if (!Number.isInteger(rush)) fails.push(why(`rushPrice(${menu},${pct}) not whole: ${rush}`));
      else if (menu > 0 && rush < menu) fails.push(why(`rushPrice(${menu},${pct}) = ${rush} < menu`));
      if (fails.length > 3) break;
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("rush over every real menu price for every property stays ≥ standard", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES.slice(0, 400)) {
      for (const m of MENU) {
        const std = priceService(m.rule, prop.profile);
        const rush = rushPrice(std, 0.25);
        bump();
        if (std > 0 && !(rush >= std)) fails.push(why(`${m.key} on ${prop.id}: rush ${rush} < std ${std}`));
        if (std === 0 && rush !== 0) fails.push(why(`${m.key} on ${prop.id}: $0 menu produced rush ${rush}`));
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("crew fill-in take-home is never negative and never exceeds the standing rate", () => {
    const fails: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const rate = int(0, 2500) + Math.round(rnd() * 100) / 100;
      const disc = rnd() * 1.5; // dial abuse: fillInRate clamps at 0.5
      const got = fillInRate(rate, disc);
      bump();
      if (!Number.isFinite(got) || got < 0 || got > Math.max(0, rate)) {
        fails.push(why(`fillInRate(${rate},${disc}) = ${got}`));
        break;
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  6. STORAGE — two seasons of stays, season ends, overstays, per-diems
// ─────────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parse = (d: string) => Date.parse(d + "T00:00:00Z");
const plusDays = (d: string, n: number) => iso(parse(d) + n * DAY);

/** Is a YYYY-MM-DD string a date that actually exists on the calendar? */
function isRealDate(d: string): boolean {
  const [y, m, day] = d.split("-").map(Number);
  const t = Date.UTC(y, m - 1, day);
  return new Date(t).toISOString().slice(0, 10) === d;
}

describe("scale: winter storage money over two seasons", () => {
  const END_MONTH = 5;
  const END_DAY = 31;
  const PERDIEM = 10;

  it("season end is on/after intake, per-diem is never negative, and on-time owes $0", () => {
    const fails: string[] = [];
    const includedDays: number[] = [];
    for (let i = 0; i < 2500; i++) {
      // Two seasons of realistic intakes (Sep–Nov), plus a tail of odd ones.
      const year = chance(0.5) ? 2026 : 2027;
      const odd = chance(0.08);
      const month = odd ? int(1, 12) : int(9, 11);
      const day = int(1, 28);
      const intake = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const end = seasonEndFor(intake, END_MONTH, END_DAY);
      bump();

      if (!isRealDate(end)) fails.push(why(`seasonEndFor(${intake}) = ${end}, not a real date`));
      if (end < intake) fails.push(why(`seasonEndFor(${intake}) = ${end} is BEFORE intake`));
      includedDays.push(Math.round((parse(end) - parse(intake)) / DAY));

      // Out on time / the day before / the day of: zero.
      bump(3);
      if (overstayDays(end, end) !== 0) fails.push(why(`out on season end ${end} charged`));
      if (overstayDays(plusDays(end, -1), end) !== 0) fails.push(why(`out the day BEFORE ${end} charged`));
      if (overstayDays(intake, end) !== 0) fails.push(why(`out on intake day ${intake} charged`));

      // Each day past the end is exactly one more day, and exactly one more per-diem.
      const late = int(1, 45);
      const days = overstayDays(plusDays(end, late), end);
      const charge = perdiemCharge(days, PERDIEM);
      bump(2);
      if (days !== late) fails.push(why(`overstayDays(${plusDays(end, late)}, ${end}) = ${days}, expected ${late}`));
      if (charge < 0 || !Number.isFinite(charge)) fails.push(why(`perdiemCharge(${days},${PERDIEM}) = ${charge}`));
      if (Math.abs(charge - late * PERDIEM) > 0.005) fails.push(why(`perdiemCharge(${days},${PERDIEM}) = ${charge}, expected ${late * PERDIEM}`));
      if (fails.length > 3) break;
    }
    expect(firstFailure(fails)).toBeNull();
    // Ordinary fall intakes get roughly 6–9 months of season.
    const normal = includedDays.filter((d) => d > 150);
    expect(normal.length).toBeGreaterThan(1800);
  });

  it("per-diem is monotone in days and never negative for any dial in range", () => {
    const fails: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const rate = Math.round(rnd() * 100 * 100) / 100; // parseSetting clamps 0..100
      const d = int(0, 400);
      const a = perdiemCharge(d, rate);
      const b = perdiemCharge(d + 1, rate);
      bump(2);
      if (a < 0 || b < 0 || !Number.isFinite(a) || !Number.isFinite(b)) fails.push(why(`perdiemCharge(${d},${rate}) = ${a}`));
      else if (b < a) fails.push(why(`perdiemCharge DROPPED ${d}→${d + 1} at rate ${rate}: ${a} → ${b}`));
      else if (Math.round(a * 100) !== a * 100 && Math.abs(Math.round(a * 100) - a * 100) > 1e-6) fails.push(why(`perdiemCharge(${d},${rate}) = ${a} is not whole cents`));
      if (fails.length > 3) break;
    }
    expect(firstFailure(fails)).toBeNull();
    bump(2);
    expect(perdiemCharge(0, 10)).toBe(0);
    expect(perdiemCharge(-5, 10)).toBe(0);
  });

  // REGRESSION (audit bug 9): platform settings clamp
  // storage_season_end_month to 1..12 and storage_season_end_day to 1..31
  // INDEPENDENTLY, and seasonEndFor used to re-clamp the same way — so the
  // dial pair (April, 31) emitted the string "2027-04-31". That is what the
  // customer saw as their due-out date on /requests, but Date.parse rolled it
  // forward, so billing measured overstay from a DIFFERENT day than the one on
  // the screen (Feb 31 → Mar 3, a 3-day free ride at $10/day per boat), and
  // Postgres rejects it outright on a `date` column. seasonEndFor now clamps
  // the (month, day) PAIR against that month's real last day, per candidate
  // year, so every dial pair an ops form can produce is a real date.
  it("REGRESSION (audit bug 9): every (month, day) dial pair yields a REAL calendar date", () => {
    bump(4);
    // Was "2027-04-31"; April has 30 days.
    expect(seasonEndFor("2026-10-05", 4, 31)).toBe("2027-04-30");
    expect(isRealDate("2027-04-30")).toBe(true);
    // The meter now measures from the day on the screen: May 1 is one day late.
    expect(overstayDays("2027-05-01", seasonEndFor("2026-10-05", 4, 31))).toBe(1);
    expect(overstayDays("2027-04-30", seasonEndFor("2026-10-05", 4, 31))).toBe(0);

    // February was the worst case (the shown end used to roll three days
    // forward). It is now leap-aware, clamped per candidate year.
    bump(3);
    expect(seasonEndFor("2026-10-05", 2, 31)).toBe("2027-02-28");
    expect(seasonEndFor("2027-10-05", 2, 31)).toBe("2028-02-29"); // leap year
    expect(overstayDays("2027-03-01", seasonEndFor("2026-10-05", 2, 31))).toBe(1);

    // Every dial pair the settings clamp allows — 12 months × 1..31 days,
    // across a leap year and a common one — is a real date on or after intake.
    const fails: string[] = [];
    for (const intake of ["2026-10-05", "2027-10-05", "2027-01-31", "2028-02-29"]) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 31; d++) {
          const end = seasonEndFor(intake, m, d);
          bump();
          if (!isRealDate(end)) fails.push(why(`seasonEndFor(${intake}, ${m}, ${d}) = ${end}, not a real date`));
          else if (end < intake) fails.push(why(`seasonEndFor(${intake}, ${m}, ${d}) = ${end} precedes intake`));
          if (fails.length > 3) break;
        }
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  // SIM-FOUND BUG (cliff): seasonEndFor takes the first (month, day) ON OR
  // AFTER intake, so the length of the paid season falls off a 365-day cliff
  // across a single calendar day. A boat taken in on May 30 gets ONE day of
  // storage for the full seasonal minimum ($43/ft outdoor); the same boat
  // taken in on June 1 gets 365. Nothing warns the customer or ops.
  it("SIM-FOUND BUG: a one-day shift in intake swings the paid season by 365 days", () => {
    const dayFor = (intake: string) => Math.round((parse(seasonEndFor(intake, 5, 31)) - parse(intake)) / DAY);
    bump(3);
    expect(dayFor("2027-05-30")).toBe(1);
    expect(dayFor("2027-05-31")).toBe(0); // paid the seasonal minimum, season over same day
    expect(dayFor("2027-06-01")).toBe(365);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  7. SPRING TRUE-UP — trueLegsToQuote must never drift or go negative
// ─────────────────────────────────────────────────────────────────────
describe("scale: spring true-up (trueLegsToQuote)", () => {
  it("legs always sum EXACTLY to the quote, are non-negative whole dollars, and are deterministic", () => {
    const fails: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const n = int(1, 6);
      const legs = Array.from({ length: n }, (_, j) => ({
        id: `leg-${j}`,
        // realistic recomputed legs, plus adversarial 0 / huge values
        price: chance(0.1) ? 0 : chance(0.03) ? int(9000, 40000) : int(60, 900),
      }));
      // the booking-time promise: sometimes below, sometimes above today's menu
      const sum = legs.reduce((t, l) => t + l.price, 0);
      const quote = chance(0.05) ? 0 : Math.max(0, Math.round(sum * (0.4 + rnd() * 1.6)));
      const out = trueLegsToQuote(legs, quote);
      const out2 = trueLegsToQuote(legs, quote);
      bump(2);

      const total = out.reduce((t, l) => t + l.price, 0);
      if (out.length !== legs.length) fails.push(why(`leg count changed ${legs.length} → ${out.length}`));
      else if (total !== Math.max(0, Math.round(quote))) fails.push(why(`drift: legs sum ${total} vs quote ${quote} (legs=${JSON.stringify(legs)})`));
      else if (out.some((l) => l.price < 0 || !Number.isInteger(l.price) || !Number.isFinite(l.price))) fails.push(why(`bad leg in ${JSON.stringify(out)} for quote ${quote}`));
      else if (JSON.stringify(out) !== JSON.stringify(out2)) fails.push(why(`non-deterministic for quote ${quote}, legs ${JSON.stringify(legs)}`));
      else if (out.some((l, k) => l.id !== legs[k].id)) fails.push(why(`leg ids reordered for quote ${quote}`));
      if (fails.length > 3) break;
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("survives all-zero legs, a zero quote, and negative garbage prices", () => {
    bump(4);
    expect(trueLegsToQuote([], 500)).toEqual([]);
    expect(trueLegsToQuote([{ id: "a", price: 0 }, { id: "b", price: 0 }], 300).reduce((t, l) => t + l.price, 0)).toBe(300);
    expect(trueLegsToQuote([{ id: "a", price: 100 }, { id: "b", price: 200 }], 0).reduce((t, l) => t + l.price, 0)).toBe(0);
    const neg = trueLegsToQuote([{ id: "a", price: -50 }, { id: "b", price: 200 }], 400);
    expect(neg.every((l) => l.price >= 0)).toBe(true);
    expect(neg.reduce((t, l) => t + l.price, 0)).toBe(400);
  });

  it("trues real package spring legs to a real booking-time quote for hundreds of properties", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES.slice(0, 400)) {
      if (!prop.profile.boats.length) continue;
      const pkgs = buildPackageViews(prop.profile);
      for (const pkg of pkgs) {
        const sel = validateSelection(pkg, defaultSelection(pkg));
        bump();
        if (!sel.ok || sel.spring.length === 0) continue;
        const legs = pkg.components
          .filter((c) => c.phase === "spring" && sel.spring.includes(c.serviceId))
          .map((c) => ({ id: c.serviceId, price: c.price }));
        // the owner turned dials over the winter: recomputed legs drift ±30%
        const drifted = legs.map((l) => ({ ...l, price: Math.round(l.price * (0.7 + rnd() * 0.6)) }));
        const trued = trueLegsToQuote(drifted, sel.springTotal);
        bump();
        const total = trued.reduce((t, l) => t + l.price, 0);
        if (total !== sel.springTotal) fails.push(why(`${pkg.code} on ${prop.id}: trued legs ${total} ≠ promised ${sel.springTotal}`));
        if (trued.some((l) => l.price < 0)) fails.push(why(`${pkg.code} on ${prop.id}: negative leg`));
        if (fails.length > 3) break;
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  8. PACKAGES — legality + the total must equal the sum of the legs
// ─────────────────────────────────────────────────────────────────────
describe("scale: storage packages", () => {
  it("total = fallTotal + springTotal = sum of the chosen legs, to the cent, over thousands of selections", () => {
    const fails: string[] = [];
    let okCount = 0;
    let failCount = 0;
    for (const prop of PROPERTIES.slice(0, 320)) {
      const pkgs = buildPackageViews(prop.profile);
      for (const pkg of pkgs) {
        const optional = pkg.components.filter((c) => !c.required);
        for (let t = 0; t < 9; t++) {
          const keys = optional.filter(() => chance(0.5)).map((c) => `${c.serviceId}|${c.phase}`);
          const sel = validateSelection(pkg, keys);
          bump();
          if (!sel.ok) {
            failCount++;
            // A rejected selection must quote nothing at all.
            if (sel.total !== 0 || sel.fallTotal !== 0 || sel.springTotal !== 0 || sel.fall.length || sel.spring.length || sel.storageTierId) {
              fails.push(why(`${pkg.code} rejected but leaked a quote: ${JSON.stringify(sel)}`));
            }
            continue;
          }
          okCount++;

          const priceOf = (ids: string[], phase: "fall" | "spring") =>
            pkg.components.filter((c) => c.phase === phase && ids.includes(c.serviceId)).reduce((s, c) => s + c.price, 0);
          const fSum = priceOf(sel.fall, "fall");
          const sSum = priceOf(sel.spring, "spring");

          if (sel.fallTotal !== fSum) fails.push(why(`${pkg.code} on ${prop.id}: fallTotal ${sel.fallTotal} ≠ legs ${fSum}`));
          else if (sel.springTotal !== sSum) fails.push(why(`${pkg.code} on ${prop.id}: springTotal ${sel.springTotal} ≠ legs ${sSum}`));
          else if (sel.total !== sel.fallTotal + sel.springTotal) fails.push(why(`${pkg.code} on ${prop.id}: total ${sel.total} ≠ ${sel.fallTotal}+${sel.springTotal}`));
          else if (sel.total < 0 || !Number.isFinite(sel.total)) fails.push(why(`${pkg.code} on ${prop.id}: total ${sel.total}`));

          // Required components are always in, in their own phase.
          for (const c of pkg.components) {
            if (!c.required) continue;
            const list = c.phase === "fall" ? sel.fall : sel.spring;
            if (!list.includes(c.serviceId)) fails.push(why(`${pkg.code}: required ${c.name} (${c.phase}) missing from the selection`));
          }
          // At most one storage tier, ever.
          const tiers = pkg.components.filter((c) => c.isStorageTier && (c.phase === "fall" ? sel.fall : sel.spring).includes(c.serviceId));
          if (tiers.length > 1) fails.push(why(`${pkg.code}: ${tiers.length} storage tiers survived validation`));
          if (sel.storageTierId && !tiers.some((c) => c.serviceId === sel.storageTierId)) fails.push(why(`${pkg.code}: storageTierId not among the chosen tiers`));
          if (pkg.code === "storage_only" && !sel.storageTierId) fails.push(why(`storage_only accepted with no tier`));
          if (fails.length > 3) break;
        }
      }
    }
    expect(firstFailure(fails)).toBeNull();
    // Measured at seed 20260726 with the return leg tagged (as migration 0051
    // now tags it in production): 4,641 accepted and 3,999 refused selections.
    // Both numbers are unchanged by the audit-bug-7 fix — the role tag decides
    // exactly what the old name match decided, it just cannot be renamed away.
    expect(okCount).toBeGreaterThan(4000);
    expect(failCount).toBeGreaterThan(100); // the legality rails really do fire
  });

  it("the default selection every package tile quotes is always legal", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES.slice(0, 300)) {
      for (const pkg of buildPackageViews(prop.profile)) {
        const sel = validateSelection(pkg, defaultSelection(pkg));
        bump();
        if (!sel.ok) fails.push(why(`${pkg.code} default selection rejected on ${prop.id}: ${sel.error}`));
        else if (sel.total !== sel.fallTotal + sel.springTotal) fails.push(why(`${pkg.code} default total mismatch on ${prop.id}`));
        else if (sel.fall.length) {
          const anchor = anchorServiceId(pkg, "fall", sel.fall);
          bump();
          if (!anchor) fails.push(why(`${pkg.code} on ${prop.id}: no fall anchor for ${sel.fall.length} legs`));
          else if (!sel.fall.includes(anchor)) fails.push(why(`${pkg.code} on ${prop.id}: anchor ${anchor} not in the fall selection`));
          else if (anchorServiceId(pkg, "fall", sel.fall) !== anchor) fails.push(why(`${pkg.code}: anchor flipped between calls`));
        }
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("we_haul never lets a boat sleep at the shop unstored, and never double-books the fall return", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES.slice(0, 250)) {
      const pkg = buildPackageViews(prop.profile).find((p) => p.code === "we_haul")!;
      const fallReturn = pkg.components.find((c) => c.phase === "fall" && c.name === "Boat return & splash")!;
      const tierKeys = pkg.components.filter((c) => c.isStorageTier).map((c) => `${c.serviceId}|${c.phase}`);
      const optional = pkg.components.filter((c) => !c.required);
      for (let t = 0; t < 8; t++) {
        const keys = optional.filter(() => chance(0.5)).map((c) => `${c.serviceId}|${c.phase}`);
        const sel = validateSelection(pkg, keys);
        bump();
        if (!sel.ok) continue;
        const storing = Boolean(sel.storageTierId);
        const returning = sel.fall.includes(fallReturn.serviceId);
        if (!storing && !returning) fails.push(why(`we_haul accepted with neither storage nor a fall return: ${JSON.stringify(keys)}`));
        if (storing && returning) fails.push(why(`we_haul accepted storage AND a fall return: ${JSON.stringify(keys)}`));
        if (sel.storageTierId && !tierKeys.some((k) => k.startsWith(sel.storageTierId!))) fails.push(why(`we_haul tier id not a tier`));
        if (fails.length > 3) break;
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  // REGRESSION (audit bug 7): packages.ts used to identify the fall-return leg
  // by its DISPLAY NAME (`const FALL_RETURN = "Boat return & splash"`) — an
  // ops-editable `services.name` column that rule 8 explicitly tells the owner
  // to tune. One ordinary rename inverted the we_haul rails in BOTH
  // directions: a customer who DID pick the fall return was told to add it
  // (nothing they could tap would ever satisfy the check), and a customer who
  // picked storage AND the fall return sailed through — billed for a winter at
  // the shop and a trip home for the same hull, with custody opened on a boat
  // that had been delivered back. The leg is now identified by the immutable
  // `role: "return_leg"` tag (or an explicit returnLegServiceId), so a rename
  // is exactly what it should be: a copy edit.
  it("REGRESSION (audit bug 7): renaming the fall-return service leaves we_haul's rails intact", () => {
    const prop = PROPERTIES.find((p) => p.profile.boats.length > 0)!;
    const renamed: Record<string, ServiceRule> = {
      [RETURN_LEG_SEED_NAME]: {
        name: "Spring splash & delivery", // an ops copy edit, nothing more
        pricing_model: "flat",
        base: 285,
        unit_rate: 0,
      },
    };
    const pkg = buildPackageViews(prop.profile, renamed).find((p) => p.code === "we_haul")!;
    const fallReturnKey = `${svcId(RETURN_LEG_SEED_NAME)}|fall`;
    // The rename really did land — the rails are not passing by luck.
    expect(pkg.components.some((c) => c.name === "Spring splash & delivery")).toBe(true);
    expect(pkg.components.some((c) => c.name === RETURN_LEG_SEED_NAME)).toBe(false);

    // (a) The legal home-storage booking (no tier, fall return picked) is
    //     ACCEPTED under the new name — it used to be unsatisfiable.
    const homeStorage = validateSelection(pkg, [fallReturnKey]);
    bump();
    expect(homeStorage.ok).toBe(true);
    expect(homeStorage.storageTierId).toBeNull();
    expect(homeStorage.fall).toContain(svcId(RETURN_LEG_SEED_NAME));

    // (b) The illegal combination (storage tier AND a fall return) is REFUSED
    //     under the new name — it used to be accepted and double-billed.
    const tier = pkg.components.find((c) => c.isStorageTier)!;
    const both = validateSelection(pkg, [fallReturnKey, `${tier.serviceId}|fall`]);
    bump();
    expect(both.ok).toBe(false);
    expect(both.error).toMatch(/drop the fall return trip/i);
    // A refused selection quotes nothing at all — no leaked money, no tier.
    expect([both.total, both.fallTotal, both.springTotal]).toEqual([0, 0, 0]);
    expect(both.storageTierId).toBeNull();
    expect(both.fall).toEqual([]);

    // (c) And the caller's explicit id wins over the tags, for the surfaces
    //     that hold the stable key but not the tagged view.
    const untagged = buildPackageViews(prop.profile, renamed, false).find((p) => p.code === "we_haul")!;
    const byId = validateSelection(untagged, [fallReturnKey], { returnLegServiceId: svcId(RETURN_LEG_SEED_NAME) });
    bump();
    expect(byId.ok).toBe(true);
  });

  // REGRESSION (audit bug 7, the fail-closed half): when NOTHING identifies the
  // return leg — an untagged recipe row, a package migration 0051 never reached
  // — we_haul cannot tell "the boat comes home" from "the boat stays", and the
  // wrong guess bills a winter of storage AND a trip home for the same hull.
  // It now refuses every we_haul selection and sends the customer to a human,
  // rather than guessing. The OTHER packages are untouched: the rails are
  // we_haul's alone, so an untagged recipe must not take you_tow or
  // storage_only offline with it.
  it("REGRESSION (audit bug 7): a package with no identifiable return leg fails CLOSED", () => {
    const fails: string[] = [];
    let refusedWeHaul = 0;
    let acceptedOthers = 0;
    for (const prop of PROPERTIES.slice(0, 150)) {
      const pkgs = buildPackageViews(prop.profile, undefined, false);
      const weHaul = pkgs.find((p) => p.code === "we_haul")!;
      // The default tile, the bare minimum, and the "bring it home" pick —
      // three shapes that would ALL have been decidable with a tagged leg.
      const keySets = [defaultSelection(weHaul), [], [`${svcId(RETURN_LEG_SEED_NAME)}|fall`]];
      for (const keys of keySets) {
        const sel = validateSelection(weHaul, keys);
        bump();
        if (sel.ok) fails.push(why(`we_haul accepted with an unidentifiable return leg on ${prop.id}`));
        else {
          refusedWeHaul++;
          if (!/return trip isn't identified/i.test(sel.error ?? "")) fails.push(why(`wrong refusal on ${prop.id}: ${sel.error}`));
          // Fail-closed still means quote nothing.
          if (sel.total !== 0 || sel.storageTierId) fails.push(why(`fail-closed leaked a quote on ${prop.id}`));
        }
      }
      for (const other of pkgs.filter((p) => p.code !== "we_haul")) {
        const sel = validateSelection(other, defaultSelection(other));
        bump();
        if (!sel.ok) fails.push(why(`${other.code} taken offline by an untagged we_haul row on ${prop.id}: ${sel.error}`));
        else acceptedOthers++;
      }
    }
    expect(firstFailure(fails)).toBeNull();
    expect(refusedWeHaul).toBe(450);
    expect(acceptedOthers).toBe(300);
  });

  it("legacy bare-serviceId selection keys select a service in EVERY phase (documented, still surprising)", () => {
    const prop = PROPERTIES.find((p) => p.profile.boats.length > 0)!;
    const pkg = buildPackageViews(prop.profile).find((p) => p.code === "we_haul")!;
    const tier = pkg.components.find((c) => c.isStorageTier && c.defaultOn)!;
    // A legacy client asking for "storage + the SPRING return" gets the FALL
    // return too, because the bare id matches both rows — and is refused.
    const sel = validateSelection(pkg, [tier.serviceId, svcId(RETURN_LEG_SEED_NAME)]);
    bump();
    expect(sel.ok).toBe(false);
    expect(sel.error).toMatch(/drop the fall return trip/i);
  });

  it("no package ever quotes a negative or fractional dollar for any property", () => {
    const fails: string[] = [];
    for (const prop of PROPERTIES) {
      for (const pkg of buildPackageViews(prop.profile)) {
        const sel = validateSelection(pkg, defaultSelection(pkg));
        bump();
        if (!sel.ok) continue;
        for (const v of [sel.total, sel.fallTotal, sel.springTotal]) {
          if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
            fails.push(why(`${pkg.code} on ${prop.id} quoted ${v}`));
            break;
          }
        }
        if (fails.length > 3) break;
      }
    }
    expect(firstFailure(fails)).toBeNull();
  });

  it("NEAR MISS: storage is priced against the WHOLE fleet, not the boat being stored", () => {
    // There is no per-boat picker in the wizard, and dispatch stamps the stay
    // with the sum of every boat's feet (src/app/book/dispatch.ts ~line 470,
    // boat_label joins all boats with " + "). A two-boat household storing one
    // boat is quoted for both.
    const oneBoat: PricingProfile = { ...PROPERTIES[0].profile, boats: [{ type: "Pontoon", length_ft: 22, engine_type: "outboard", engine_hp: 150, engines: 1 }] };
    const twoBoats: PricingProfile = { ...oneBoat, boats: [...oneBoat.boats, { type: "Ski boat", length_ft: 20, engine_type: "sterndrive", engine_hp: 250, engines: 1 }] };
    const tier = COMPONENTS.find((c) => c.name === "Winter storage — outdoor")!.rule;
    bump(2);
    expect(priceService(tier, oneBoat)).toBe(22 * 43);
    expect(priceService(tier, twoBoats)).toBe(42 * 43); // both boats, one stored

    const multi = PROPERTIES.filter((p) => p.profile.boats.length > 1).length;
    expect(multi).toBeGreaterThan(150); // ~1 in 6 of the population is exposed
  });
});

// ─────────────────────────────────────────────────────────────────────
//  9. TWO SEASONS END TO END — book, store, overstay, splash, true up
// ─────────────────────────────────────────────────────────────────────
describe("scale: two full seasons of storage customers, end to end", () => {
  it("every stay's money is internally consistent from fall quote to spring settle", () => {
    const fails: string[] = [];
    let stays = 0;
    let overstays = 0;
    let perdiemDollars = 0;
    for (const prop of PROPERTIES) {
      if (!prop.profile.boats.length) continue;
      for (const season of [2026, 2027]) {
        if (prop.season === 2 && season === 2026) continue;
        const wanted = chance(0.4) ? "we_haul" : chance(0.5) ? "you_tow" : "storage_only";
        const pkg = buildPackageViews(prop.profile).find((p) => p.code === wanted)!;
        const optional = pkg.components.filter((c) => !c.required);
        const keys = optional.filter((c) => (c.isStorageTier ? c.defaultOn : chance(0.5))).map((c) => `${c.serviceId}|${c.phase}`);
        const sel = validateSelection(pkg, keys);
        bump();
        if (!sel.ok || !sel.storageTierId) continue;
        stays++;

        const intake = `${season}-${String(int(9, 11)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`;
        const end = seasonEndFor(intake, 5, 31);
        // most boats leave in April/May, a long tail overstays into summer
        const out = chance(0.86) ? plusDays(end, -int(1, 70)) : plusDays(end, int(1, 60));
        const days = overstayDays(out, end);
        const charge = perdiemCharge(days, 10);
        bump(3);

        if (days > 0) {
          overstays++;
          perdiemDollars += charge;
        }
        if (charge < 0 || !Number.isFinite(charge)) fails.push(why(`stay ${prop.id}/${season}: perdiem ${charge}`));
        if (out <= end && days !== 0) fails.push(why(`stay ${prop.id}/${season}: out ${out} ≤ end ${end} but charged ${days}d`));
        if (sel.fallTotal <= 0) fails.push(why(`stay ${prop.id}/${season}: fall quote ${sel.fallTotal} with a storage tier`));

        // Spring settle: legs recomputed against today's menu, trued to the promise.
        if (sel.spring.length) {
          const legs = pkg.components
            .filter((c) => c.phase === "spring" && sel.spring.includes(c.serviceId))
            .map((c) => ({ id: c.serviceId, price: Math.round(c.price * (0.8 + rnd() * 0.5)) }));
          const trued = trueLegsToQuote(legs, sel.springTotal);
          bump();
          const total = trued.reduce((t, l) => t + l.price, 0);
          if (total !== sel.springTotal) fails.push(why(`stay ${prop.id}/${season}: spring settle ${total} ≠ promise ${sel.springTotal}`));
          if (trued.some((l) => l.price < 0)) fails.push(why(`stay ${prop.id}/${season}: negative spring leg`));
        }
        if (fails.length > 3) break;
      }
    }
    expect(firstFailure(fails)).toBeNull();
    // Measured at seed 20260726: 885 storage stays over two seasons, 119 of
    // them overstaying (~134 per 1,000 stays) for $37,540 of per-diem —
    // every one of those a notice, a phone call and a pickup to chase.
    // (Unchanged by the audit fixes. With an UNTAGGED return leg this falls to
    // 496 because every we_haul stay fails closed — see the fail-closed test
    // above; that drop is the tell that a package recipe is missing its tag.)
    expect(stays).toBeGreaterThan(800);
    expect(overstays).toBeGreaterThan(90);
    expect(perdiemDollars).toBeGreaterThan(20_000);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  10. Case count — proof of what was actually exercised.
// ─────────────────────────────────────────────────────────────────────
describe("sim coverage", () => {
  it("exercised a real population, not a handful of examples", () => {
    expect(PROPERTIES.length).toBe(1100);
    expect(CASES).toBeGreaterThan(100_000);
    // eslint-disable-next-line no-console
    console.log(`[pricing-scale.sim] seed=${SEED} properties=${PROPERTIES.length} engine calls=${CASES}`);
  });
});
