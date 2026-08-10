import { describe, it, expect } from "vitest";
import {
  streamStatus, allStreamStatuses, streamsNeedingWork, setupSummary,
  REVENUE_STREAMS, STREAM_SPEC,
  type ParkFacts, type RevenueStream,
} from "./revenue-streams";

const NOTHING: ParkFacts = {
  longTermLots: 0, shortTermLots: 0, slipLots: 0, storageLots: 0,
  parkOwnedHomes: 0, notYetLive: 0, lotsWithRates: 0,
  costsRecorded: 0, feesConfigured: 0,
};

/** The Haven the day after closing: pads in, nothing else yet. */
const HAVEN_DAY_ONE: ParkFacts = {
  ...NOTHING, longTermLots: 21, lotsWithRates: 21, parkOwnedHomes: 1,
};

describe("the template", () => {
  it("describes every stream in the owner's language", () => {
    for (const s of REVENUE_STREAMS) {
      const spec = STREAM_SPEC[s];
      expect(spec.label.length).toBeGreaterThan(3);
      expect(spec.what.length).toBeGreaterThan(20);
      expect(spec.example.length).toBeGreaterThan(5);
      // No jargon leaking out of the schema into his setup screen.
      expect(spec.what).not.toMatch(/lot_reservations|site_type|rental_mode|null/i);
    }
  });

  it("says nothing about a stream he never turned on", () => {
    // Listing missing steps for something he didn't choose is noise.
    const s = streamStatus("boat_slips", false, NOTHING);
    expect(s.on).toBe(false);
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual([]);
  });

  it("is never READY without inventory", () => {
    for (const stream of REVENUE_STREAMS) {
      expect(streamStatus(stream, true, NOTHING).ready).toBe(false);
    }
  });
});

describe("The Haven, stream by stream", () => {
  it("has its lots ready on day one", () => {
    const s = streamStatus("long_term_lots", true, HAVEN_DAY_ONE);
    expect(s.ready).toBe(true);
    expect(s.count).toBe(21);
  });

  it("REFUSES to call lots ready when nothing is priced", () => {
    // An owner who thinks lots are switched on and hasn't priced them finds
    // out from a customer.
    const s = streamStatus("long_term_lots", true, { ...HAVEN_DAY_ONE, lotsWithRates: 0 });
    expect(s.ready).toBe(false);
    expect(s.missing[0]).toMatch(/rents for/i);
  });

  it("knows the double-wide counts as a park-owned rental", () => {
    expect(streamStatus("park_owned_rentals", true, HAVEN_DAY_ONE).ready).toBe(true);
  });

  it("tells him the slips need adding before they earn", () => {
    const s = streamStatus("boat_slips", true, HAVEN_DAY_ONE);
    expect(s.ready).toBe(false);
    expect(s.missing[0]).toMatch(/add your slips/i);
  });

  it("distinguishes STR homes he hasn't bought from ones that don't exist", () => {
    // Nothing at all: add them.
    const none = streamStatus("short_term_homes", true, HAVEN_DAY_ONE);
    expect(none.missing[0]).toMatch(/planned/i);

    // Four planned: not "add them" — they're there, just not live.
    const planned = streamStatus("short_term_homes", true, { ...HAVEN_DAY_ONE, notYetLive: 4 });
    expect(planned.coming).toBe(4);
    expect(planned.missing[0]).toMatch(/not live yet/i);
    expect(planned.ready).toBe(false);

    // Live: earning.
    const live = streamStatus("short_term_homes", true, { ...HAVEN_DAY_ONE, shortTermLots: 4 });
    expect(live.ready).toBe(true);
  });

  it("won't let him split a bill across a park with no lots", () => {
    const s = streamStatus("cost_recovery", true, NOTHING);
    expect(s.missing[0]).toMatch(/lots first/i);
  });

  it("points at the grounds fee as the usual first one", () => {
    const s = streamStatus("fees", true, HAVEN_DAY_ONE);
    expect(s.ready).toBe(false);
    expect(s.missing[0]).toMatch(/grounds fee/i);

    // And once one exists, it is ready.
    expect(streamStatus("fees", true, { ...HAVEN_DAY_ONE, feesConfigured: 1 }).ready).toBe(true);
  });
});

describe("the summary line", () => {
  it("counts what is EARNING, not what is ticked", () => {
    const on = ["long_term_lots", "park_owned_rentals", "boat_slips", "short_term_homes"];
    const st = allStreamStatuses(on, HAVEN_DAY_ONE);
    // Lots and the owned home work; slips and STR homes don't exist yet.
    expect(setupSummary(st)).toBe("2 of 4 income streams ready — the rest still need something.");
    expect(streamsNeedingWork(st).map((s) => s.stream))
      .toEqual(["short_term_homes", "boat_slips"] as RevenueStream[]);
  });

  it("invites him in when nothing is chosen", () => {
    expect(setupSummary(allStreamStatuses([], NOTHING))).toMatch(/pick what your park earns/i);
  });

  it("says so when everything works", () => {
    const st = allStreamStatuses(["long_term_lots"], HAVEN_DAY_ONE);
    expect(setupSummary(st)).toMatch(/all 1 of your income streams/i);
  });
});
