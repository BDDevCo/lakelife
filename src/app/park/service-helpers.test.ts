import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canEnableParkServices, buildParkBlockers, buildGroundsPropertyRow, priceLine,
  usesPerLotRate,
  type ParkReadiness,
} from "./service-helpers";

const READY: ParkReadiness = {
  parkName: "The Haven",
  lakeId: "lake-1",
  address: "1 Haven Rd, Angola IN",
  liveLots: 21,
  memberRole: "owner",
  accountRole: "owner",
  hasCard: true,
};

describe("who may switch park services on", () => {
  // ROLE ACCESS. Committing the park to a paid service relationship is the
  // owner's decision, the same line setParkLive draws.
  it("the owner may; a manager may not", () => {
    expect(canEnableParkServices("owner")).toBe(true);
    expect(canEnableParkServices("manager")).toBe(false);
    expect(canEnableParkServices(null)).toBe(false);
    expect(canEnableParkServices(undefined)).toBe(false);
  });

  it("says so in the blockers, not just by disabling a button", () => {
    const [first] = buildParkBlockers({ ...READY, memberRole: "manager" });
    expect(first).toMatch(/only the park's owner/i);
  });
});

describe("why he cannot turn it on yet", () => {
  it("is silent when everything is in place", () => {
    expect(buildParkBlockers(READY)).toEqual([]);
  });

  it("names the lake, because a lake decides the season", () => {
    expect(buildParkBlockers({ ...READY, lakeId: null })[0]).toMatch(/lake/i);
  });

  it("names the address, because a crew has to find the place", () => {
    expect(buildParkBlockers({ ...READY, address: null })[0]).toMatch(/address/i);
    expect(buildParkBlockers({ ...READY, address: "   " })[0]).toMatch(/address/i);
  });

  it("names the lot count, because that IS the price", () => {
    expect(buildParkBlockers({ ...READY, liveLots: 0 })[0]).toMatch(/no live lots/i);
  });

  // A park owner who also mows can claim a crew invite and be flipped to
  // 'vendor'. /book reads services with the SESSION client, so his menu would
  // come back silently EMPTY rather than refused — the exact failure this desk
  // exists to end.
  it("names a crew account, which would otherwise show an empty menu and no reason", () => {
    const rows = buildParkBlockers({ ...READY, accountRole: "vendor" });
    expect(rows.some((r) => /vendor/i.test(r))).toBe(true);
  });

  it("does not complain about an ops account", () => {
    expect(buildParkBlockers({ ...READY, accountRole: "ops" })).toEqual([]);
  });

  it("names the card, because createBooking refuses without one", () => {
    expect(buildParkBlockers({ ...READY, hasCard: false })[0]).toMatch(/card/i);
  });

  it("lists every problem at once, so fixing one does not reveal a new refusal", () => {
    const rows = buildParkBlockers({
      ...READY, lakeId: null, address: null, liveLots: 0, hasCard: false,
    });
    expect(rows).toHaveLength(4);
  });
});

describe("the grounds property row", () => {
  const row = buildGroundsPropertyRow({
    ownerId: "u1", parkId: "p1", parkName: "The Haven",
    lakeId: "lake-1", address: "1 Haven Rd", lat: 41.6, lng: -85.0,
  });

  // 0006 puts a GLOBAL partial unique index on place_id, and 0107's trigger
  // refuses a grounds property carrying one.
  it("carries no Google place_id at all", () => {
    expect("place_id" in row).toBe(false);
  });

  // sqft/beds/baths drive housekeeping and winterization, which are not on a
  // park's menu. Inventing 2,400 sqft for a field of grass is a number
  // somebody later trusts.
  it("invents no house measurements", () => {
    expect("sqft" in row).toBe(false);
    expect("beds" in row).toBe(false);
    expect("baths" in row).toBe(false);
  });

  it("names itself, so the property switcher is not a list of bare addresses", () => {
    expect(row.nickname).toBe("The Haven — grounds");
  });

  it("carries the park, the lake and the map pin", () => {
    expect(row.park_id).toBe("p1");
    expect(row.lake_id).toBe("lake-1");
    expect(row.owner_id).toBe("u1");
    expect(row.lat).toBe(41.6);
    expect(row.lng).toBe(-85.0);
  });

  it("survives a park with no coordinates yet", () => {
    const bare = buildGroundsPropertyRow({
      ownerId: "u1", parkId: "p1", parkName: "The Haven",
      lakeId: "lake-1", address: "1 Haven Rd",
    });
    expect(bare.lat).toBeNull();
    expect(bare.lng).toBeNull();
  });
});

describe("the arithmetic, shown before he commits to it", () => {
  it("prints the count and the price together", () => {
    expect(priceLine(21, 602)).toBe("21 live lots · $602.00 a visit");
  });

  it("says lot, not lots, when there is one", () => {
    expect(priceLine(1, 162)).toBe("1 live lot · $162.00 a visit");
  });
});

describe("a per-lot box on a service that cannot use one", () => {
  /**
   * SNOW IS THE ONE THAT BITES, AND IT BITES IN JANUARY.
   *
   * Production's four grounds services split two ways. Mowing and the two
   * cleanups are `per_section` with `band_pricing.count_field = "lots"`, so
   * `priceService` returns `base + unit_rate × lots`. Snow clearing is `flat`
   * with `band_pricing` null, and `flat` returns `rule.base` — `unit_rate` is
   * not read at all.
   *
   * The rate editor drew both boxes for every service. So pricing a snow push
   * at "nothing flat, $15 a lot" showed:
   *
   *     $0.00 + $15.00 × 21 lots = $0.00 a visit (rounded to the dollar)
   *
   * — a $315 discrepancy reported as rounding, on a Save button disabled by
   * `preview <= 0` with no other explanation. The one number he most needs to
   * set before the first snow is the one the screen argues with him about.
   *
   * And a unit_rate saved against a flat service is a column with no reader:
   * stored, shown back on the card, and worth nothing at booking.
   */
  it("says yes for the three services that are priced per lot", () => {
    for (const name of ["Park grounds mowing & trim", "Common-area spring cleanup", "Common-area fall cleanup & leaf haul"]) {
      expect(usesPerLotRate("per_section", { count_field: "lots" }), name).toBe(true);
    }
  });

  it("says no for snow, which is flat and ignores unit_rate outright", () => {
    expect(usesPerLotRate("flat", null)).toBe(false);
    expect(usesPerLotRate("flat", { count_field: "lots" })).toBe(false);
  });

  it("says no when per_section counts something a park has none of", () => {
    // `cfg.count_field ?? "pier_sections"` — a per_section service with no
    // band_pricing counts PIER SECTIONS, and a park's grounds has zero. The
    // per-lot box would multiply by nothing, silently.
    expect(usesPerLotRate("per_section", null)).toBe(false);
    expect(usesPerLotRate("per_section", { count_field: "pier_sections" })).toBe(false);
  });

  it("says no for every other model, rather than guessing", () => {
    for (const m of ["band", "per_foot", "per_sqft_band", "seasonal_plus_perdiem", ""]) {
      expect(usesPerLotRate(m, { count_field: "lots" }), m).toBe(false);
    }
  });
});

describe("the screen and the server both ask the helper", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the editor hides the per-lot box when the model ignores it", () => {
    const src = read("../../components/ParkServices.tsx");
    expect(src, "the editor still draws both boxes unconditionally")
      .toMatch(/usesPerLotRate\(/);
  });

  it("and the rounding hedge is only ever about rounding", () => {
    // "(rounded to the dollar)" explained a $315 structural gap. A rounding
    // difference is always under a dollar by construction.
    const src = read("../../components/ParkServices.tsx");
    expect(src).toMatch(/rounded to the dollar/);
    expect(src, "the hedge still fires on any difference at all")
      .not.toMatch(/Math\.abs\(b \+ u \* liveLots - preview\) > 0\.005/);
  });

  it("the server refuses a rate the engine would throw away", () => {
    // Not merely a UI nicety: setParkServiceRate takes base and unitRate from
    // a browser, and a stored unit_rate on a flat service is a number that
    // shows on the card and is worth nothing at booking.
    const src = read("./service-actions.ts");
    expect(src, "setParkServiceRate never consults the pricing model")
      .toMatch(/usesPerLotRate\(/);

    // AND ITS SELECT FETCHES WHAT THE CHECK READS. A condition widened without
    // its query is this repo's most repeated mistake: it compiles, reads
    // `undefined`, and every service looks flat — refusing the per-lot rate on
    // the three that genuinely use one.
    const fn = src.match(/export async function setParkServiceRate[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "setParkServiceRate not found — this scan is measuring nothing").not.toBe("");
    const select = fn.match(/\.select\("id, name, park_only[^"]*"\)/)?.[0] ?? "";
    expect(select, "the service lookup is gone — the scan is stale").not.toBe("");
    expect(select, "the model check reads pricing_model but the query omits it")
      .toMatch(/pricing_model/);
    expect(select, "and band_pricing, which is what says the count is lots")
      .toMatch(/band_pricing/);
  });
});

describe("the rate desk says what the number he types actually is", () => {
  /**
   * THE MOST EXPENSIVE MISUNDERSTANDING AVAILABLE TO HIM, and the screen
   * never mentions it.
   *
   * The box asks for a price. Every word around it — "what you pay", "every
   * park pays a different number for these" — reads as *what the crew charges
   * me*. It is not. The number becomes `jobs.customer_price`, the ALL-IN price,
   * and the margin floor then caps what a crew can be paid at
   * price x (1 - marginFloor).
   *
   * The Haven's mow is on file at $100, noted "From the seller: $100/week" —
   * which is exactly the natural act: type what the current mower charges. At
   * the 0.20 floor that caps a crew at $80.00 for mowing 21 lots, while the
   * park's own cost line puts that work at ~$99 a cut. No crew can take it. The
   * job simply sits on "Finding a crew", and nothing on this screen ever
   * explains why.
   *
   * The fix is NOT to invent a price — an unpriced park service is the safe
   * state and his number is his. It is to stop the screen implying the figure
   * means something it does not, on the screen where the mistake is made.
   */
  const src = readFileSync(
    fileURLToPath(new URL("../../components/ParkServices.tsx", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    // `//` LINES TOO. Without this the "no price of its own" check below
    // matched a COMMENT explaining a past rounding bug ("previewed $277.50 for
    // a rate that actually charged $278") — prose, not copy. A scanner that
    // reads comments is measuring the wrong thing, which is this repo's
    // standing rule for source scans.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("tells him the figure is all-in, not the crew's fee", () => {
    expect(
      src,
      "nothing on the rate desk says the number is the all-in price rather " +
        "than what the crew is paid — so typing the mower's quote caps the crew " +
        "below it, and the job never fills.",
    ).toMatch(/all-in|what the crew is paid|the crew's share comes out of it/i);
  });

  it("and does not quote a price of its own", () => {
    // `prices-come-as-we-go`: an unpriced park service is the SAFE state.
    // Naming a number here would be inventing his rate for him.
    expect(src, "the desk now suggests a figure").not.toMatch(/\$\d/);
  });
});
