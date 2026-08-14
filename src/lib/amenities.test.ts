import { describe, it, expect } from "vitest";
import {
  quoteAmenity, priceLine, daysIn, dayWindow, offerDays, canTakeRun,
  runWindow, whoHasIt, type Amenity, type AmenityUnit,
} from "./amenities";

const NO_SEASON = { openMonth: null, openDay: null, closeMonth: null, closeDay: null };

const BOAT: Amenity = {
  id: "a1", name: "The pontoon", kind: "boat",
  chargeModel: "per_day", dayRate: 150, whoMayBook: "guests",
  maxDays: null, season: NO_SEASON, rules: null, active: true,
};
const UNIT: AmenityUnit = { id: "u1", amenityId: "a1", label: "The pontoon", active: true };

/** A three-night stay: in on the 14th, out on the 17th. */
const STAY = { start: "2026-07-14", end: "2026-07-17" };
const TODAY = "2026-07-14";

const offer = (over: Partial<Parameters<typeof offerDays>[0]> = {}) =>
  offerDays({
    amenity: BOAT, unit: UNIT, stay: STAY, held: [], today: TODAY,
    parkSeason: null, isShortStay: true, ...over,
  });

describe("what a day costs", () => {
  it("prices a run at the day rate", () => {
    expect(quoteAmenity(BOAT, 2)).toBe(300);
  });

  it("returns 0 for an included amenity — that is a real answer", () => {
    expect(quoteAmenity({ ...BOAT, chargeModel: "included", dayRate: null }, 3)).toBe(0);
  });

  it("returns NULL, not 0, when a priced amenity has no rate", () => {
    // 0115's lesson. A zero price is indistinguishable from "does not apply",
    // and every screen that conflates them eventually shows a wrong number.
    expect(quoteAmenity({ ...BOAT, dayRate: null }, 2)).toBe(null);
    expect(quoteAmenity({ ...BOAT, dayRate: 0 }, 2)).toBe(null);
  });

  it("never says '$0.00 a day' for something that comes free", () => {
    expect(priceLine({ ...BOAT, chargeModel: "included", dayRate: null }))
      .toBe("Included with your stay");
    expect(priceLine(BOAT)).toBe("$150.00 a day");
    expect(priceLine({ ...BOAT, dayRate: null })).toBe("No price set yet");
  });
});

describe("which days a guest is offered", () => {
  it("offers exactly the nights of the stay, not the checkout day", () => {
    // Half-open: in on the 14th, out on the 17th, so three days — and the
    // 17th is the morning they leave, not a day they can take the boat.
    const days = offer().map((d) => d.day);
    expect(days).toEqual(["2026-07-14", "2026-07-15", "2026-07-16"]);
  });

  it("says who has it without saying who", () => {
    // Which household has the boat is the park's business, not the next
    // guest's — but "unavailable" with no reason is what makes people ring.
    const states = offer({
      held: [{ unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" } }],
    });
    const fifteenth = states.find((d) => d.day === "2026-07-15")!;
    expect(fifteenth.open).toBe(false);
    expect(fifteenth.open === false && fifteenth.why).toBe("Someone has it that day.");
    expect(JSON.stringify(states)).not.toMatch(/lot|Lot/i);
  });

  it("says YOU have it, not 'someone', about her own day", () => {
    // The page looked like it had lost her booking: she tapped Saturday, and
    // Saturday came back "Someone has it that day."
    const states = offer({
      held: [{ unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, mine: true }],
    });
    const d = states.find((x) => x.day === "2026-07-15")!;
    expect(d.open).toBe(false);
    expect(d.open === false && d.why).toBe("You have it.");
    expect(d.open === false && d.mine).toBe(true);
  });

  it("still keeps another guest anonymous", () => {
    const states = offer({
      held: [{ unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, mine: false }],
    });
    const d = states.find((x) => x.day === "2026-07-15")!;
    expect(d.open === false && d.why).toBe("Someone has it that day.");
  });

  it("stops offering days once she has her allowance", () => {
    // FOUND ON SCREEN. She held two of a two-day cap and Monday still said
    // "Take it" — a button for something the database would always refuse.
    const states = offer({
      amenity: { ...BOAT, maxDays: 2 },
      held: [
        { unitId: "u1", during: { start: "2026-07-14", end: "2026-07-15" }, mine: true },
        { unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, mine: true },
      ],
    });
    const free = states.find((d) => d.day === "2026-07-16")!;
    expect(free.open).toBe(false);
    expect(free.open === false && free.why).toContain("give one back to swap");
  });

  it("keeps offering while she is under it", () => {
    const states = offer({
      amenity: { ...BOAT, maxDays: 2 },
      held: [{ unitId: "u1", during: { start: "2026-07-14", end: "2026-07-15" }, mine: true }],
    });
    expect(states.filter((d) => d.open).map((d) => d.day))
      .toEqual(["2026-07-15", "2026-07-16"]);
  });

  it("does not count another guest's days against her allowance", () => {
    const states = offer({
      amenity: { ...BOAT, maxDays: 2 },
      held: [
        { unitId: "u1", during: { start: "2026-07-14", end: "2026-07-15" }, mine: false },
        { unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, mine: false },
      ],
    });
    expect(states.find((d) => d.day === "2026-07-16")!.open).toBe(true);
  });

  it("ignores a hold on a different unit", () => {
    // Four kayaks: somebody having kayak 2 says nothing about kayak 1.
    const states = offer({
      held: [{ unitId: "u2", during: { start: "2026-07-15", end: "2026-07-16" } }],
    });
    expect(states.every((d) => d.open)).toBe(true);
  });

  it("refuses a day that has already passed", () => {
    const states = offer({ today: "2026-07-16" });
    expect(states.filter((d) => d.open).map((d) => d.day)).toEqual(["2026-07-16"]);
    const past = states[0];
    expect(past.open === false && past.why).toBe("That day has passed.");
  });

  it("says it is out of the water rather than 'unavailable'", () => {
    const states = offer({
      amenity: { ...BOAT, season: { openMonth: 5, openDay: 1, closeMonth: 6, closeDay: 30 } },
    });
    expect(states.every((d) => !d.open)).toBe(true);
    expect(states[0].open === false && states[0].why).toBe("It's out of the water then.");
  });

  it("falls back to the park's season when the amenity sets none", () => {
    const states = offer({ parkSeason: { openMonth: 5, openDay: 1, closeMonth: 6, closeDay: 30 } });
    expect(states.every((d) => !d.open)).toBe(true);
  });

  it("answers once for the whole amenity when nobody could book it", () => {
    // A blanket refusal must not masquerade as "someone has it" — that would
    // be a true-sounding sentence about the wrong thing.
    const resident = offer({ isShortStay: false });
    expect(resident.every((d) => !d.open)).toBe(true);
    expect(resident[0].open === false && resident[0].why).toBe("This one is for short-stay guests.");

    const off = offer({ amenity: { ...BOAT, active: false } });
    expect(off[0].open === false && off[0].why).toBe("This one isn't open for booking at the moment.");
  });

  it("lets a resident take a residents-only or shared amenity", () => {
    const shared = offer({ amenity: { ...BOAT, whoMayBook: "both" }, isShortStay: false });
    expect(shared.every((d) => d.open)).toBe(true);
    const residentsOnly = offer({ amenity: { ...BOAT, whoMayBook: "residents" }, isShortStay: false });
    expect(residentsOnly.every((d) => d.open)).toBe(true);
  });
});

describe("taking a run of days", () => {
  const states = offer();

  it("takes consecutive open days", () => {
    expect(canTakeRun(BOAT, ["2026-07-14", "2026-07-15"], states)).toEqual({ ok: true });
  });

  it("refuses a gap — one booking is ONE window", () => {
    // The exclusion constraint stores a single range; Monday-and-Thursday is
    // two bookings, and pretending otherwise would silently hold Tuesday and
    // Wednesday too.
    const r = canTakeRun(BOAT, ["2026-07-14", "2026-07-16"], states);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("run together");
  });

  it("refuses a run past the park's own cap", () => {
    const r = canTakeRun({ ...BOAT, maxDays: 1 }, ["2026-07-14", "2026-07-15"], states);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("1 day at a time");
  });

  it("passes a closed day's own reason through rather than inventing one", () => {
    const withHold = offer({
      held: [{ unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" } }],
    });
    const r = canTakeRun(BOAT, ["2026-07-15"], withHold);
    expect(r.ok === false && r.why).toBe("Someone has it that day.");
  });

  it("turns a run into one half-open window", () => {
    expect(runWindow(["2026-07-15", "2026-07-14"]))
      .toEqual({ start: "2026-07-14", end: "2026-07-16" });
    expect(runWindow([])).toBe(null);
  });

  it("makes back-to-back runs not collide", () => {
    // [14,16) and [16,17) — the changeover day belongs to the second booking.
    const a = runWindow(["2026-07-14", "2026-07-15"])!;
    const b = runWindow(["2026-07-16"])!;
    expect(a.end).toBe(b.start);
  });
});

describe("what the owner sees about a day", () => {
  const units: AmenityUnit[] = [
    { id: "u1", amenityId: "a1", label: "The pontoon", active: true },
    { id: "u2", amenityId: "a1", label: "Kayak 1", active: true },
  ];

  it("names who has what and what is free — counts, not percentages", () => {
    const r = whoHasIt(units, [
      { unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, who: "Meredith K.", status: "booked" },
    ], "2026-07-15");
    expect(r.taken).toEqual([{ unit: "The pontoon", who: "Meredith K." }]);
    expect(r.free).toEqual(["Kayak 1"]);
  });

  it("calls the park's own blackout what it is", () => {
    const r = whoHasIt(units, [
      { unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, who: null, status: "blackout" },
    ], "2026-07-15");
    expect(r.taken).toEqual([{ unit: "The pontoon", who: "held back" }]);
  });

  it("does not count a cancelled booking as taken", () => {
    const r = whoHasIt(units, [
      { unitId: "u1", during: { start: "2026-07-15", end: "2026-07-16" }, who: "Gone", status: "cancelled" },
    ], "2026-07-15");
    expect(r.taken).toEqual([]);
    expect(r.free).toEqual(["The pontoon", "Kayak 1"]);
  });
});

describe("day arithmetic", () => {
  it("expands a window into its whole days", () => {
    expect(daysIn({ start: "2026-07-14", end: "2026-07-17" }))
      .toEqual(["2026-07-14", "2026-07-15", "2026-07-16"]);
  });

  it("crosses a month end", () => {
    expect(daysIn({ start: "2026-07-31", end: "2026-08-02" }))
      .toEqual(["2026-07-31", "2026-08-01"]);
  });

  it("crosses a leap day", () => {
    expect(daysIn({ start: "2028-02-28", end: "2028-03-01" }))
      .toEqual(["2028-02-28", "2028-02-29"]);
  });

  it("makes a single day a one-night window", () => {
    expect(dayWindow("2026-07-14")).toEqual({ start: "2026-07-14", end: "2026-07-15" });
  });
});
