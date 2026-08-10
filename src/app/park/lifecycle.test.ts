import { describe, it, expect } from "vitest";
import { summarise, buildRentRoll, toStay, type RawReservation } from "./park-helpers";
import type { Lot } from "@/lib/parks";

const TODAY = "2027-06-15";

const lot = (over: Partial<Lot> & { id: string; lotNumber: string }): Lot => ({
  siteType: "mh_single", maxLengthFt: null, amperage: null,
  hasWater: true, hasSewer: true, slipIncluded: false, active: true,
  ...over,
} as Lot);

const stay = (lotId: string): RawReservation => ({
  id: `r-${lotId}`, park_lot_id: lotId, renter_id: `x-${lotId}`, renter_unit_id: null,
  during: "[2027-01-01,2027-12-31)", term: "monthly", quoted_amount: 400,
  status: "active", decided_at: null, created_at: null,
});

describe("THE NUMBER THAT GOES IN FRONT OF A LENDER", () => {
  it("keeps four unbuilt STR homes out of occupancy entirely", () => {
    // The Haven: 22 real lots, 20 of them occupied — and four short-term homes
    // he has not bought yet.
    const real = Array.from({ length: 22 }, (_, i) => lot({ id: `l${i}`, lotNumber: String(i + 1) }));
    const planned = Array.from({ length: 4 }, (_, i) =>
      lot({ id: `s${i}`, lotNumber: `H${i + 1}`, lifecycle: "planned", rentalMode: "short_term" }));
    const stays = real.slice(0, 20).map((l) => toStay(stay(l.id)));

    const rows = buildRentRoll([...real, ...planned], stays, TODAY);
    const s = summarise(rows);

    expect(s.lots).toBe(22);
    expect(s.occupied).toBe(20);
    expect(s.planned).toBe(4);
    // 20/22 = 91%, NOT 20/26 = 77%.
    expect(s.occupancyPct).toBe(91);
  });

  it("a home being renovated is not vacant either", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "1" }), lot({ id: "b", lotNumber: "H1", lifecycle: "renovating" })],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.renovating).toBe(1);
    expect(s.vacant).toBe(0);
    expect(s.lots).toBe(1);
    expect(s.occupancyPct).toBe(100);
  });

  it("counts nightly homes apart once they ARE live", () => {
    // Occupancy for a nightly home is 19 nights of 30, not "somebody lives
    // here". Averaging the two describes neither.
    const rows = buildRentRoll(
      [
        lot({ id: "a", lotNumber: "1" }),
        lot({ id: "b", lotNumber: "H1", lifecycle: "live", rentalMode: "short_term" }),
      ],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.shortTermLots).toBe(1);
    expect(s.lots).toBe(1);
    expect(s.occupancyPct).toBe(100);
  });

  it("a retired lot leaves the numbers without deleting its history", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "1" }), lot({ id: "b", lotNumber: "9", lifecycle: "retired" })],
      [toStay(stay("a"))],
      TODAY,
    );
    const s = summarise(rows);
    expect(s.lots).toBe(1);
    expect(rows).toHaveLength(2);   // still in the roll, just not in the maths
  });

  it("treats a lot with no lifecycle as live — every park that existed before", () => {
    const rows = buildRentRoll([lot({ id: "a", lotNumber: "1" })], [toStay(stay("a"))], TODAY);
    const s = summarise(rows);
    expect(s.lots).toBe(1);
    expect(s.occupied).toBe(1);
    expect(s.planned).toBe(0);
  });

  it("a brand-new park with only planned lots is not 0% full", () => {
    const rows = buildRentRoll(
      [lot({ id: "a", lotNumber: "H1", lifecycle: "planned" })], [], TODAY,
    );
    const s = summarise(rows);
    expect(s.lots).toBe(0);
    expect(s.planned).toBe(1);
    expect(s.occupancyPct).toBeNull();
  });
});
