/**
 * A PARK'S OWN RATE BEATS A CREW'S CARD. WHERE IT HAS NO RATE, THE CREW'S CARD
 * IS THE PRICE — THE SAME AS FOR ANYBODY ELSE.
 *
 * This file is the safety argument for 0176 dropping
 * `services_park_is_never_crew_priced`. The CHECK is gone; the guarantee it was
 * standing in for is here, and the load-bearing case is the last one: flip
 * `Park grounds mowing & trim` to crew_priced tomorrow and The Haven's mow
 * still prices at the $125 Mike negotiated, because the park HAS a number and
 * precedence prefers it.
 *
 * NUMBERS COME FROM SEEDED INPUTS, NEVER FROM THE EXPRESSION UNDER TEST. The
 * mow is base 20 + $5 a lot over 21 live lots. 20 + 5 x 21 = 125, typed out
 * rather than recomputed. ($125 x 0.80 = $100.00 is what Mike actually pays
 * Advantage Lawn Care, on five 2026 invoices — the margin floor is why the row
 * reads 125 and not 100.)
 */
import { describe, it, expect } from "vitest";
import {
  pricingPathFor,
  crewSetsThePrice,
  withParkRate,
  noPriceForThisPark,
  type ParkRates,
} from "./park-rates";
import { priceService, type ServiceRule, type PricingProfile } from "./pricing";
import { summariseCorrection, correctionCard, correctionMessage, type TimedRule } from "./arrival";

const MOW_ID = "11111111-1111-1111-1111-111111111111";
const DOCK_ID = "22222222-2222-2222-2222-222222222222";
const SNOW_ID = "33333333-3333-3333-3333-333333333333";

/** The grounds mow, as `services` holds it: 0115 zeroed the GLOBAL price. */
const mowService = {
  id: MOW_ID,
  name: "Park grounds mowing & trim",
  pricing_model: "per_section" as const,
  base: 0,
  unit_rate: 0,
  band_pricing: { count_field: "lots" },
  park_only: true,
  crew_priced: false,
};

/** The 28-section dock. `park_bookable` retail work — a lake house buys it too,
 *  so its global row carries a REAL price and 0115's zeroing trick is unusable. */
const dockService = {
  id: DOCK_ID,
  name: "Pier install / removal",
  pricing_model: "per_section" as const,
  base: 220,
  unit_rate: 48,
  band_pricing: null,
  park_only: false,
  crew_priced: false,
};

/** Snow clearing — roads & common drives. park_only, priced `flat`, NO rate. */
const snowService = {
  id: SNOW_ID,
  name: "Snow clearing — roads & common drives",
  pricing_model: "flat" as const,
  base: 0,
  unit_rate: 0,
  band_pricing: null,
  park_only: true,
  crew_priced: false,
};

/** The Haven's grounds: 21 live lots, a 28-section dock. */
const grounds = {
  lots: 21,
  sqft: 0, beds: 0, baths: 0,
  pier_sections: 28, boat_lifts: 0, toy_lifts: 0, jet_skis: 0, pwc_lifts: 0,
  panes: 0, lawn_band: "medium", drive_band: null, boats: [], toys: [],
} as unknown as PricingProfile;

/** A lake house with the same dock, so the retail card is exercised for real. */
const lakeHouse = { ...grounds, lots: undefined } as unknown as PricingProfile;

/** What The Haven actually holds today: one row, the mow. */
const havenRates = (): ParkRates =>
  new Map([[MOW_ID, { base: 20, unit_rate: 5, note: "Advantage Lawn Care — $100 a cut" }]]);

type Svc = {
  id: string | null;
  name: string;
  pricing_model: ServiceRule["pricing_model"];
  base: number;
  unit_rate: number;
  band_pricing: Record<string, unknown> | null;
  park_only: boolean;
  crew_priced: boolean;
};

const price = (svc: Svc, rates: ParkRates | null, p: PricingProfile) =>
  priceService(withParkRate(svc, rates) as unknown as ServiceRule, p);

describe("who prices the work — the four answers", () => {
  it("a lake house on ordinary work takes the retail menu", () => {
    expect(pricingPathFor(dockService, null)).toBe("menu");
    // 220 + 48 x 28 = 1564. The figure exists; it is simply not a park's.
    expect(price(dockService, null, lakeHouse)).toBe(1564);
  });

  it("a lake house on a crew-priced service takes the crew's card", () => {
    expect(pricingPathFor({ ...dockService, crew_priced: true }, null)).toBe("crew_card");
  });

  it("a park with its own rate is priced by that rate", () => {
    expect(pricingPathFor(mowService, havenRates())).toBe("park_rate");
  });

  it("a park with no rate on MENU-priced work has no price at all", () => {
    expect(pricingPathFor(dockService, havenRates())).toBe("park_no_rate");
    // NOT $1,564. The retail card is a lake house's number, and quoting it to
    // the park was the bug: 1.86x the $840 Josh charges for the same dock.
    expect(price(dockService, havenRates(), grounds)).toBe(0);
  });

  it("a park with no rate on CREW-PRICED work takes the crew's card — the correction", () => {
    // The fence 0174 shipped made this `park_rate`-or-nothing and refused the
    // crew path outright. It is the answer The Haven's snow depends on: no snow
    // crew, no snow price, and the seller's lawn guy sold his plow.
    expect(pricingPathFor({ ...snowService, crew_priced: true }, havenRates())).toBe("crew_card");
    expect(crewSetsThePrice({ ...snowService, crew_priced: true }, havenRates())).toBe(true);
  });
});

describe("THE MOW MUST NOT MOVE", () => {
  it("prices at $125 for The Haven, before anything else is asked", () => {
    // base 20 + $5 x 21 live lots. Typed, not recomputed from the overlay.
    expect(price(mowService, havenRates(), grounds)).toBe(125);
  });

  it("STILL prices at $125 if somebody flips the mow to crew_priced tomorrow", () => {
    // This is the whole safety argument for dropping 0174's CHECK. The park is
    // protected by HAVING a number, not by a fence: precedence prefers the
    // park's row over any crew's card, so the flag changes nothing here.
    const flipped = { ...mowService, crew_priced: true };
    expect(pricingPathFor(flipped, havenRates())).toBe("park_rate");
    expect(crewSetsThePrice(flipped, havenRates())).toBe(false);
    expect(price(flipped, havenRates(), grounds)).toBe(125);
  });

  it("does not leak The Haven's $125 to a lake house, flipped or not", () => {
    // The other direction of the fence, and the one that must never widen.
    // A mow rule against a property with no lots prices to 0 either way.
    expect(pricingPathFor(mowService, null)).toBe("menu");
    expect(price(mowService, null, lakeHouse)).toBe(0);
  });

  it("does not leak The Haven's $125 to a DIFFERENT park", () => {
    const otherPark: ParkRates = new Map();
    expect(pricingPathFor(mowService, otherPark)).toBe("park_no_rate");
    expect(price(mowService, otherPark, grounds)).toBe(0);
  });
});

describe("a failed read must not become a crew's card", () => {
  it("an EMPTY map and a NULL map are opposite answers, and the types say so", () => {
    // `null` = not a park. An empty Map = a park that has priced nothing.
    // Before the overlay these were the same value at five call sites, and the
    // difference is now money: on a crew_priced service the empty map routes to
    // the crew's card and `null` routes to LakeLife's retail card.
    const crewMow = { ...mowService, crew_priced: true };
    expect(pricingPathFor(crewMow, null)).toBe("crew_card");
    expect(pricingPathFor(crewMow, new Map())).toBe("crew_card");
    // …and with the park's own row present, neither.
    expect(pricingPathFor(crewMow, havenRates())).toBe("park_rate");
  });

  it("a service with no id falls to 'no price', never to retail", () => {
    const noId = { ...dockService, id: null };
    expect(pricingPathFor(noId, havenRates())).toBe("park_no_rate");
  });
});

describe("the copy tells the two no-price cases apart", () => {
  it("the park sentence points at the park's own desk and quotes no retail figure", () => {
    const s = noPriceForThisPark("Pier install / removal");
    expect(s).toContain("Services page");
    expect(s).not.toContain("1,564");
    expect(s).not.toContain("$");
  });

  it("a correction on a park's own rate is priced off the park's row, not retail", () => {
    // 28 sections → 34. Mow-shaped rule so the numbers are the park's:
    // base 20 + 5 x lots is unaffected by sections, so use the DOCK with a
    // park rate of $30 a section — Josh's real $840 / 28.
    const rates: ParkRates = new Map([[DOCK_ID, { base: 0, unit_rate: 30, note: "Josh" }]]);
    const rule = dockService as unknown as TimedRule;
    const s = summariseCorrection(rule, grounds, { pier_sections: 34 }, rates);
    // 30 x 28 = 840 before, 30 x 34 = 1020 after. Seeded, not recomputed.
    expect(s.priceBefore).toBe(840);
    expect(s.priceAfter).toBe(1020);
    expect(s.crewPriced).toBe(false);
    expect(s.parkUnpriced).toBe(false);
    // And the retail answer, which is what this screen printed before 0176.
    expect(summariseCorrection(rule, grounds, { pier_sections: 34 }, null).priceBefore).toBe(1564);
  });

  it("a park with NO rate is never told 'the price doesn't change'", () => {
    const s = summariseCorrection(
      dockService as unknown as TimedRule, grounds, { pier_sections: 34 }, havenRates(),
    );
    expect(s.parkUnpriced).toBe(true);
    expect(s.priceDelta).toBe(0);
    // ApprovalCard renders `price ?? "The price doesn't change."` — so a null
    // here IS that sentence, printed over work that has no price at all.
    const card = correctionCard(s);
    expect(card?.price).not.toBeNull();
    expect(card?.price).toContain("hasn't set its own price");
    expect(correctionMessage(s, { serviceName: dockService.name }))
      .not.toContain("The price doesn't change");
  });

  it("a crew-priced correction says a crew re-quotes it, on both surfaces", () => {
    const s = summariseCorrection(
      { ...dockService, crew_priced: true } as unknown as TimedRule,
      grounds, { pier_sections: 34 }, havenRates(),
    );
    expect(s.crewPriced).toBe(true);
    expect(s.parkUnpriced).toBe(false);
    expect(correctionCard(s)?.price).toContain("re-quote");
    expect(correctionMessage(s, { serviceName: dockService.name })).toContain("re-quote");
  });

  it("a lake house correction is byte for byte what it was", () => {
    const s = summariseCorrection(dockService as unknown as TimedRule, lakeHouse, { pier_sections: 34 });
    expect(s.crewPriced).toBe(false);
    expect(s.parkUnpriced).toBe(false);
    expect(s.priceBefore).toBe(1564);
    // 220 + 48 x 34 = 1852.
    expect(s.priceAfter).toBe(1852);
    expect(correctionCard(s)?.price).toContain("$1,852.00 instead of $1,564.00");
  });
});

describe("the rule has one home, and every doorway calls it", () => {
  // A rule in one doorway of three is not a rule — and the first version of
  // this file scanned exactly three files, while the codebase had SIX places
  // that decided who prices a job. Three of them carried the old fence in
  // spellings this scan could not see (`!grounds`, `!parkRates`, and the bare
  // flag with no park question at all), and one of those three WRITES
  // `customer_price`. So the list is named, and the re-spelling scan is run
  // over every file in src/ rather than over the three it started with.
  const read = async (p: string) =>
    (await import("node:fs")).readFileSync(new URL(p, import.meta.url), "utf8")
      // Strip comments first: every one of these files DISCUSSES the old fence
      // at length, and a scanner that counts prose finds the rule everywhere.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * EVERY PLACE THAT DECIDES WHO PRICES A JOB, and what each one does with the
   * answer. Adding a seventh means adding it here; that is the point.
   */
  const DOORWAYS: [string, string][] = [
    ["../app/book/actions.ts", "createBooking — books priced, or books unpriced for a crew to quote"],
    ["../app/book/dispatch.ts", "assignJob — writes customer_price, vendor_cost and margin"],
    ["../app/profile/data.ts", "the /book menu — price tile, or the crew-quoted sentence"],
    ["../app/book/autopilot-actions.ts", "enrollAutopilot — freezes locked_price for a season"],
    ["../app/approvals/actions.ts", "approveFlag — reprices both ends at the corrected size"],
    ["../app/vendor/open-actions.ts", "claimJob — the claim that can SET customer_price"],
    ["../app/vendor/open-data.ts", "the open board — the quote box, and canClaim's floor test"],
    ["../app/ops/actions.ts", "assignJobManual — ops hand-costing, refused on the crew path"],
    ["../app/requests/offer-data.ts", "the scarcity offer — meaningless without a menu price"],
  ];

  it("every doorway asks the shared helper", async () => {
    for (const [f, what] of DOORWAYS) {
      const src = await read(f);
      expect(src, `${f} (${what}) does not ask pricingPathFor/crewSetsThePrice`)
        .toMatch(/crewSetsThePrice\(|pricingPathFor\(/);
    }
  });

  it("and arrival.ts, the quote surface, asks it too", async () => {
    const src = await read("./arrival.ts");
    expect(src).toMatch(/pricingPathFor\(/);
  });

  it("NO file in src/ re-derives 'is this a park' beside crew_priced", async () => {
    // The widened scan. The old fence was spelled five ways across the tree —
    // `!profile.groundsForParkId`, `!isParkGrounds`, `!isGrounds && !park_only`,
    // `!grounds`, `!parkRates` — and a scan hard-coded to three files could
    // only ever see the three it opened.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // fileURLToPath, not `.pathname` — this repo lives under "LakeLife App
    // Docs" and a raw URL pathname hands readdir "LakeLife%20App%20Docs".
    const root = fileURLToPath(new URL("../", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = `${dir}/${e}`;
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
        files.push(full);
      }
    };
    walk(root.replace(/\/$/, ""));
    // The scan is only worth anything if it is actually opening the tree.
    expect(files.length, "the walk found no source files — this scan measures nothing")
      .toBeGreaterThan(100);

    const FENCE = /crew_priced[^\n]*&&[^\n]*(groundsForParkId|isParkGrounds|isGrounds|parkRates|grounds\b)|(groundsForParkId|isParkGrounds|isGrounds|parkRates)[^\n]*&&[^\n]*crew_priced/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (FENCE.test(src)) offenders.push(f.slice(root.length));
    }
    expect(offenders, `the old fence is spelled by hand in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the fence scan would catch a doorway that grew its own copy back", () => {
    // An absence-only assertion passes with the condition deleted. This one
    // runs the same regex over the exact sentence it exists to refuse.
    const FENCE = /crew_priced[^\n]*&&[^\n]*(groundsForParkId|isParkGrounds|isGrounds|parkRates|grounds\b)|(groundsForParkId|isParkGrounds|isGrounds|parkRates)[^\n]*&&[^\n]*crew_priced/;
    expect(FENCE.test("if (service.crew_priced === true && !profile.groundsForParkId) {")).toBe(true);
    expect(FENCE.test("if (svc.crew_priced === true && !isParkGrounds) {")).toBe(true);
    expect(FENCE.test("const c = !!s.crew_priced && !isGrounds && !s.park_only;")).toBe(true);
    expect(FENCE.test("if (svc.crew_priced === true && !grounds) {")).toBe(true);
    expect(FENCE.test("if (raw.crew_priced === true && !parkRates && pct != null) {")).toBe(true);
    // And it does not fire on the shape that IS correct.
    expect(FENCE.test("const crewPriced = crewSetsThePrice(service, parkRates);")).toBe(false);
  });

  it("arrival.ts prices through the overlay, not off the bare rule", async () => {
    const src = await read("./arrival.ts");
    // The exact defect skeptic (2) found: `priceService(rule, ...)` on a park.
    expect(src, "summariseCorrection is pricing off the retail card again")
      .not.toMatch(/priceService\(rule,/);
    expect(src).toMatch(/withParkRate\(rule, parkRates\)/);
  });

  it("the /book menu takes the CHECKED read of what the park pays", async () => {
    // A swallowed failure here is an empty Map, an empty Map is "this park has
    // no rate", and that is two lies on one screen: The Haven's $125 mow
    // reading "waiting on your price" on a Services page where the price has
    // been set since 8 September, and — on anything flagged crew_priced — "Crews
    // set their own price for this one" printed over a negotiated number.
    const src = await read("../app/profile/data.ts");
    expect(src, "getPricedServices is back on the swallowing read")
      .not.toMatch(/\bloadParkRates\(/);
    expect(src).toMatch(/loadParkRatesChecked\(/);
    expect(src, "a failed rate read has to stop the menu, not price it")
      .toMatch(/checked\?\.failed/);
  });

  it("the claim board decides the fee from the CUSTOMER, not the flag alone", async () => {
    // claimJob's guarded UPDATE writes `customer_price` from the crew's card
    // when `fee` is set. On a park holding its own rate that would overwrite
    // the number Mike negotiated — the one thing "THE MOW MUST NOT MOVE" above
    // cannot prove on its own, because it tests the rule and not this door.
    const action = await read("../app/vendor/open-actions.ts");
    expect(action, "claimJob sets the platform fee off svc.crew_priced alone")
      .not.toMatch(/const fee[^=]*=\s*svc\.crew_priced/);
    expect(action).toMatch(/crewSetsThePrice\(/);
    const board = await read("../app/vendor/open-data.ts");
    expect(board, "the open board sets the platform fee off svc.crew_priced alone")
      .not.toMatch(/const fee[^=]*=\s*svc\?\.crew_priced/);
    expect(board).toMatch(/crewSetsThePrice\(/);
  });
});
