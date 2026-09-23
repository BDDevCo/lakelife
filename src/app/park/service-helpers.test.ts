import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canEnableParkServices, buildParkBlockers, buildGroundsPropertyRow, priceLine,
  type ParkReadiness,
} from "./service-helpers";
import { NO_LAKE_LINE } from "./readiness";

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

  it("names the lake in the shared sentence, because no owner screen sets one", () => {
    // /lake/i pinned nothing: it passed while the line ended "Set it in Park
    // setup", and ParkSetup has no lake field. parks.lake_id is ops-written
    // (NewPark), so the blocker must say what the publish gate and the
    // readiness row say — exactly, so the three doorways can never drift.
    expect(buildParkBlockers({ ...READY, lakeId: null })[0]).toBe(NO_LAKE_LINE);
    expect(NO_LAKE_LINE).not.toContain("Set it in Park setup");
    // Both ways: with a lake, the sentence is gone.
    expect(buildParkBlockers(READY)).not.toContain(NO_LAKE_LINE);
    expect(buildParkBlockers({ ...READY, address: null })).not.toContain(NO_LAKE_LINE);
  });

  it("the address blocker is the one that may open Park setup — it has an input there", () => {
    expect(buildParkBlockers({ ...READY, address: null })[0]).toContain("Set it in Park setup");
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

/**
 * `usesPerLotRate` USED TO BE TESTED HERE, AND IT IS GONE (23 Sep 2026).
 *
 * It answered "does this service's price move with the LOT COUNT?" — true for
 * the mow and the two cleanups, false for snow, which is priced `flat` and
 * never reads unit_rate. That stopped the rate editor drawing a per-lot box on
 * a snow push and previewing `$0.00 + $15.00 x 21 lots = $0.00 a visit`, a $315
 * gap the screen blamed on rounding.
 *
 * The 28 August widening (a park may price ANYTHING it can buy) replaced it
 * with `parkRateUnit`, which names the counter the engine will actually read,
 * and moved its last production caller. The predicate stayed exported, stayed
 * green, and was asked by nobody but these tests — a symbol with no caller,
 * which reads to the next person as a rule still in force. Deleted with them.
 *
 * The BEHAVIOUR it protected did not go anywhere: "the editor hides the
 * per-unit box when the model ignores it" and "the server refuses a rate the
 * engine would throw away", below, are the same rule tested at the two doors
 * that enforce it, and `park-rates.every-park-its-own.test.ts` covers
 * `parkRateUnit` itself — including `flat` returning null, which is snow.
 */

describe("the screen and the server both ask the helper", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the lake blocker never sends him to Park setup, in any doorway", () => {
    // The link in ParkServices attaches to every row containing "Set it in
    // Park setup". A lake line carrying those words would be a door to a
    // field ParkSetup does not have — so the sentence may appear at most once
    // in the helper (the address), and the lake branch must use the constant.
    const helper = read("./service-helpers.ts");
    const lakeBranch = helper.match(/if \(!r\.lakeId\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(lakeBranch, "the lake branch not found — this scan is measuring nothing").not.toBe("");
    expect(lakeBranch).toMatch(/out\.push\(NO_LAKE_LINE\)/);
    expect(lakeBranch).not.toContain("Set it in Park setup");
    expect(helper.split("Set it in Park setup").length - 1).toBe(1);

    const setup = read("../../components/ParkSetup.tsx");
    expect(setup, "ParkSetup grew a lake control — the blocker may name it again").not.toMatch(/lake_id|lakeId/);
    expect(setup, "ParkSetup lost its address input — the address blocker now lies too").toMatch(/address/i);
  });

  it("the editor hides the per-unit box when the model ignores it", () => {
    // WIDENED with the overlay (28 Aug decision). The old per-lot predicate
    // answered the park_only question and was right for it — but it is FALSE
    // for the dock, which is per_section counting pier_sections, so wiring the
    // editor to it would have hidden the box Josh's "$30 a section" goes in. The
    // editor asks the server, which asked priceService against the grounds'
    // real profile; `perUnit` is that answer.
    const src = read("../../components/ParkServices.tsx");
    expect(src, "the editor still draws both boxes unconditionally")
      .toMatch(/\{perUnit &&/);
    expect(src, "the per-unit branch no longer decides anything")
      .toMatch(/perUnit \?/);
    expect(src, "a lot count is not the multiplier for every park service")
      .not.toMatch(/u \* liveLots/);
  });

  it("and the rounding hedge is only ever about rounding", () => {
    // "(rounded to the dollar)" explained a $315 structural gap. A rounding
    // difference is always under a dollar by construction.
    const src = read("../../components/ParkServices.tsx");
    expect(src).toMatch(/rounded to the dollar/);
    expect(src, "the hedge still fires on any difference at all")
      .not.toMatch(/Math\.abs\(b \+ u \* unitCount - preview\) > 0\.005/);
  });

  it("the server refuses a rate the engine would throw away", () => {
    // Not merely a UI nicety: setParkServiceRate takes base and unitRate from
    // a browser, and a stored unit_rate on a flat service is a number that
    // shows on the card and is worth nothing at booking.
    const src = read("./service-actions.ts");
    expect(src, "setParkServiceRate never consults the pricing model")
      .toMatch(/parkRateUnit\(/);

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
