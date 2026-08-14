import { describe, it, expect } from "vitest";
import {
  canEnableParkServices, buildParkBlockers, buildGroundsPropertyRow, priceLine,
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
