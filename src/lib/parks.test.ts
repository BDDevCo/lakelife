import { describe, it, expect } from "vitest";
import {
  lotFits, overlaps, isAvailable, isRealRange, nightsIn,
  quoteStay, fromPrice, parkOpenFor,
  type Lot, type RenterUnit, type DateRange, type RateCard,
} from "@/lib/parks";

const lot = (over: Partial<Lot> = {}): Lot => ({
  id: "l1", lotNumber: "12", siteType: "rv_site",
  maxLengthFt: 40, amperage: 50,
  hasWater: true, hasSewer: true, slipIncluded: false, active: true, lifecycle: "live",
  ...over,
});
const unit = (over: Partial<RenterUnit> = {}): RenterUnit => ({
  unitType: "travel_trailer", lengthFt: 30, needsAmps: 30, ...over,
});
const r = (start: string, end: string): DateRange => ({ start, end });

describe("lotFits — a lot the unit cannot physically use is never offered", () => {
  it("a normal trailer on a full-hookup lot fits", () => {
    expect(lotFits(lot(), unit()).fits).toBe(true);
  });
  it("a rig longer than the pad does not fit, and says why", () => {
    const res = lotFits(lot({ maxLengthFt: 30 }), unit({ lengthFt: 40 }));
    expect(res.fits).toBe(false);
    expect(res.problems).toContain("too_short");
  });
  it("exactly the pad length fits — the boundary is inclusive", () => {
    expect(lotFits(lot({ maxLengthFt: 40 }), unit({ lengthFt: 40 })).fits).toBe(true);
  });
  it("a 50-amp rig will not take a 30-amp lot", () => {
    expect(lotFits(lot({ amperage: 30 }), unit({ needsAmps: 50 })).problems).toContain("not_enough_power");
  });
  it("a mobile home needs a pad, not an RV site", () => {
    expect(lotFits(lot({ siteType: "rv_site" }), unit({ unitType: "mobile_home" })).problems)
      .toContain("wrong_site_type");
  });
  it("a mobile home needs sewer — it is not visiting a dump station", () => {
    expect(lotFits(lot({ siteType: "mh_single", hasSewer: false }), unit({ unitType: "mobile_home" })).problems)
      .toContain("needs_sewer");
  });
  it("an inactive lot never fits, whatever the unit", () => {
    expect(lotFits(lot({ active: false }), unit()).fits).toBe(false);
  });
  it("reports EVERY problem, not just the first — one fix at a time is a support call", () => {
    const res = lotFits(lot({ maxLengthFt: 20, amperage: 20, siteType: "tent" }), unit({ lengthFt: 40, needsAmps: 50 }));
    expect(res.problems.length).toBeGreaterThanOrEqual(3);
  });
  it("UNKNOWN values never block — a renter who skipped a field still sees the lot", () => {
    expect(lotFits(lot(), unit({ lengthFt: null, needsAmps: null })).fits).toBe(true);
    expect(lotFits(lot({ maxLengthFt: null, amperage: null }), unit({ lengthFt: 45, needsAmps: 50 })).fits).toBe(true);
  });
});

describe("overlaps — must agree EXACTLY with the database's exclusion constraint", () => {
  it("plain overlap collides", () => {
    expect(overlaps(r("2026-06-01", "2026-06-10"), r("2026-06-05", "2026-06-15"))).toBe(true);
  });
  it("back-to-back is NOT a collision — changeover day is normal", () => {
    // If this were treated as a conflict, every turnover would strand a night.
    expect(overlaps(r("2026-06-01", "2026-06-10"), r("2026-06-10", "2026-06-20"))).toBe(false);
  });
  it("fully contained collides, in both directions", () => {
    expect(overlaps(r("2026-06-01", "2026-06-30"), r("2026-06-10", "2026-06-12"))).toBe(true);
    expect(overlaps(r("2026-06-10", "2026-06-12"), r("2026-06-01", "2026-06-30"))).toBe(true);
  });
  it("a single shared night collides", () => {
    expect(overlaps(r("2026-06-01", "2026-06-02"), r("2026-06-01", "2026-06-02"))).toBe(true);
  });
  it("is symmetric across thousands of random pairs", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 4000; i++) {
      const s1 = 1 + Math.floor(rnd() * 300), l1 = 1 + Math.floor(rnd() * 40);
      const s2 = 1 + Math.floor(rnd() * 300), l2 = 1 + Math.floor(rnd() * 40);
      const d = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);
      const a = r(d(s1), d(s1 + l1)), b = r(d(s2), d(s2 + l2));
      expect(overlaps(a, b)).toBe(overlaps(b, a));
    }
  });
});

describe("isAvailable — only a DECIDED reservation holds the dates", () => {
  const want = r("2026-07-01", "2026-07-08");

  // 0065: BOOKABLE = ACTIVE AND LIFECYCLE = LIVE. Only the first half was ever
  // checked, so a retired pad kept listing publicly at a price and somebody
  // could apply for it — the database refused the booking at the very end.
  it("a RETIRED lot is not available, however empty it is", () => {
    expect(isAvailable(lot({ lifecycle: "retired" }), want, [])).toBe(false);
  });
  it("a PLANNED lot is not available — it does not exist yet", () => {
    expect(isAvailable(lot({ lifecycle: "planned" }), want, [])).toBe(false);
  });
  it("a lot being WORKED ON is not available", () => {
    expect(isAvailable(lot({ lifecycle: "renovating" }), want, [])).toBe(false);
  });
  it("a live, active, empty lot still is", () => {
    expect(isAvailable(lot(), want, [])).toBe(true);
  });
  it("an approved stay blocks the lot", () => {
    expect(isAvailable(lot(), want, [{ during: r("2026-07-05", "2026-07-12"), status: "approved" }])).toBe(false);
  });
  it("an active stay blocks the lot", () => {
    expect(isAvailable(lot(), want, [{ during: r("2026-07-05", "2026-07-12"), status: "active" }])).toBe(false);
  });
  it("an APPLICATION does not block — two people may apply, the owner picks", () => {
    expect(isAvailable(lot(), want, [{ during: r("2026-07-05", "2026-07-12"), status: "applied" }])).toBe(true);
  });
  it("declined, cancelled and ended stays release the dates", () => {
    for (const status of ["declined", "cancelled", "ended"]) {
      expect(isAvailable(lot(), want, [{ during: want, status }])).toBe(true);
    }
  });
  it("an inactive lot is never available", () => {
    expect(isAvailable(lot({ active: false }), want, [])).toBe(false);
  });
  it("a backwards or empty range is never available", () => {
    expect(isAvailable(lot(), r("2026-07-08", "2026-07-01"), [])).toBe(false);
    expect(isAvailable(lot(), r("2026-07-01", "2026-07-01"), [])).toBe(false);
  });
});

describe("isRealRange / nightsIn", () => {
  it("counts nights, not days", () => {
    expect(nightsIn(r("2026-07-01", "2026-07-08"))).toBe(7);
    expect(nightsIn(r("2026-07-01", "2026-07-02"))).toBe(1);
  });
  it("spans a month, a year and a leap day without drift", () => {
    expect(nightsIn(r("2026-01-31", "2026-02-01"))).toBe(1);
    expect(nightsIn(r("2026-12-31", "2027-01-01"))).toBe(1);
    expect(nightsIn(r("2028-02-28", "2028-03-01"))).toBe(2); // 2028 is a leap year
  });
  it("rejects malformed and inverted ranges", () => {
    expect(isRealRange(r("nope", "2026-07-08"))).toBe(false);
    expect(isRealRange(r("2026-07-08", "2026-07-01"))).toBe(false);
  });
});

describe("quoteStay — the park owner's card, never a number we invented", () => {
  const rates: RateCard[] = [
    { term: "nightly", amount: 55 },
    { term: "weekly", amount: 315 },
    { term: "monthly", amount: 900 },
  ];
  it("multiplies whole periods", () => {
    expect(quoteStay(rates, "nightly", r("2026-07-01", "2026-07-04"))).toBe(165);
    expect(quoteStay(rates, "weekly", r("2026-07-01", "2026-07-08"))).toBe(315);
    expect(quoteStay(rates, "monthly", r("2026-07-01", "2026-07-31"))).toBe(900);
  });
  it("rounds UP to a whole period — a park sells months, not part-months", () => {
    expect(quoteStay(rates, "weekly", r("2026-07-01", "2026-07-10"))).toBe(630); // 9 nights -> 2 weeks
    expect(quoteStay(rates, "monthly", r("2026-07-01", "2026-09-15"))).toBe(2700); // 76 nights -> 3 months
  });
  it("returns NULL for a term the park does not sell — never a silent substitution", () => {
    expect(quoteStay(rates, "annual", r("2026-07-01", "2027-07-01"))).toBeNull();
    expect(quoteStay(rates, "seasonal", r("2026-05-01", "2026-10-01"))).toBeNull();
  });
  it("never returns a negative or NaN amount", () => {
    for (const term of ["nightly", "weekly", "monthly"] as const) {
      const q = quoteStay(rates, term, r("2026-07-01", "2026-07-20"));
      expect(q).not.toBeNull();
      expect(Number.isFinite(q!)).toBe(true);
      expect(q!).toBeGreaterThan(0);
    }
  });
  it("is cents-exact — no float drift on long stays", () => {
    const odd: RateCard[] = [{ term: "monthly", amount: 333.33 }];
    // Jan 1 -> Dec 31 is 364 nights, which rounds UP to 13 monthly periods
    // (not 12 — a part-month is still a month the park sells).
    expect(nightsIn(r("2026-01-01", "2026-12-31"))).toBe(364);
    expect(quoteStay(odd, "monthly", r("2026-01-01", "2026-12-31"))).toBe(4333.29);
  });
});

describe("fromPrice — the 'from $X' line on the public park page", () => {
  it("picks the cheapest priced term", () => {
    expect(fromPrice([{ term: "monthly", amount: 900 }, { term: "nightly", amount: 55 }]))
      .toEqual({ term: "nightly", amount: 55 });
  });
  it("is null when the park has priced nothing — never shows 'from $0'", () => {
    expect(fromPrice([])).toBeNull();
    expect(fromPrice([{ term: "nightly", amount: 0 }])).toBeNull();
  });
});

describe("parkOpenFor — a seasonal park must not sell a January week", () => {
  const summer = { openMonth: 5, openDay: 1, closeMonth: 10, closeDay: 15 };
  it("a stay inside the season is fine", () => {
    expect(parkOpenFor(summer, r("2026-06-01", "2026-06-08"))).toBe(true);
  });
  it("a stay wholly outside the season is refused", () => {
    expect(parkOpenFor(summer, r("2026-01-05", "2026-01-12"))).toBe(false);
  });
  it("a stay that STRADDLES the close date is refused — every night must be open", () => {
    expect(parkOpenFor(summer, r("2026-10-10", "2026-10-25"))).toBe(false);
  });
  it("a stay ending the morning the park closes is fine — `end` is exclusive", () => {
    expect(parkOpenFor(summer, r("2026-10-10", "2026-10-16"))).toBe(true);
  });
  it("null dates mean YEAR-ROUND, not closed", () => {
    // Deliberately the opposite of the LAKE water-season gate, which fails
    // closed: an unknown lake season might mean ice, but an unconfigured park
    // season just means the owner never told us they close.
    expect(parkOpenFor({ openMonth: null, openDay: null, closeMonth: null, closeDay: null },
      r("2026-01-05", "2026-01-12"))).toBe(true);
  });
  it("handles a window that wraps the New Year", () => {
    const winter = { openMonth: 11, openDay: 1, closeMonth: 3, closeDay: 31 };
    expect(parkOpenFor(winter, r("2026-12-20", "2027-01-05"))).toBe(true);
    expect(parkOpenFor(winter, r("2026-07-01", "2026-07-08"))).toBe(false);
  });
});
