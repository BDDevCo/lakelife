import { describe, it, expect } from "vitest";
import {
  serviceMinutes, visitMinutes, sizeOf, sellableWindow, sellableMinutes,
  fitsInDay, clockLabel, FALLBACK_JOB_MINUTES, MAX_JOB_MINUTES,
  type DurationBands,
} from "./duration";
import type { PricingProfile, ServiceRule } from "./pricing";

const profile = (over: Partial<PricingProfile> = {}): PricingProfile => ({
  sqft: 2400, beds: 3, baths: 2,
  pier_sections: 8, boat_lifts: 1, toy_lifts: 0, jet_skis: 0, pwc_lifts: 0,
  lawn_band: "medium", boats: [], toys: [], ...over,
});

// The real seeded rules, straight from production.
const PIER: ServiceRule & { est_minutes: number; duration_bands: DurationBands } = {
  name: "Pier install / removal", pricing_model: "per_section",
  base: 220, unit_rate: 48, band_pricing: { count_field: "pier_sections" },
  est_minutes: 180,
  duration_bands: { rungs: [
    { max: 5, minutes: 120 }, { max: 9, minutes: 180 },
    { max: 13, minutes: 255 }, { max: null, minutes: 330 },
  ] },
};
const LAWN: ServiceRule & { est_minutes: number; duration_bands: DurationBands } = {
  name: "Lawn mowing & trim", pricing_model: "band",
  base: 0, unit_rate: 0, band_pricing: { small: 65, medium: 85, large: 110 },
  est_minutes: 45,
  duration_bands: { by_band: { small: 30, medium: 50, large: 90 } },
};
const CLEAN: ServiceRule & { est_minutes: number; duration_bands: DurationBands } = {
  name: "Housekeeping", pricing_model: "per_sqft_band",
  base: 0, unit_rate: 0,
  band_pricing: { tiers: [{ max: 1800, price: 80 }, { max: 2800, price: 95 }, { max: null, price: 120 }] },
  est_minutes: 90,
  duration_bands: { rungs: [
    { max: 1800, minutes: 75 }, { max: 2800, minutes: 105 }, { max: null, minutes: 150 },
  ] },
};

describe("the schedule finally moves with the property", () => {
  it("times a pier by its sections — the number that already prices it", () => {
    expect(serviceMinutes(PIER, profile({ pier_sections: 4 }))).toBe(120);
    expect(serviceMinutes(PIER, profile({ pier_sections: 8 }))).toBe(180);
    expect(serviceMinutes(PIER, profile({ pier_sections: 12 }))).toBe(255);
    expect(serviceMinutes(PIER, profile({ pier_sections: 16 }))).toBe(330);
  });

  it("Brendon's example: 8 sections to 12 is +$192 AND +75 minutes", () => {
    // Before this engine both piers were 180 minutes and the day drifted by
    // exactly the difference, every single time.
    const eight = serviceMinutes(PIER, profile({ pier_sections: 8 }));
    const twelve = serviceMinutes(PIER, profile({ pier_sections: 12 }));
    expect(twelve - eight).toBe(75);
  });

  it("times a lawn by its band, not by a number", () => {
    expect(serviceMinutes(LAWN, profile({ lawn_band: "small" }))).toBe(30);
    expect(serviceMinutes(LAWN, profile({ lawn_band: "medium" }))).toBe(50);
    expect(serviceMinutes(LAWN, profile({ lawn_band: "large" }))).toBe(90);
  });

  it("times housekeeping by square footage", () => {
    expect(serviceMinutes(CLEAN, profile({ sqft: 1600 }))).toBe(75);
    expect(serviceMinutes(CLEAN, profile({ sqft: 2400 }))).toBe(105);
    expect(serviceMinutes(CLEAN, profile({ sqft: 4200 }))).toBe(150);
  });

  it("eight large lawns no longer fit a day that cannot hold them", () => {
    // The old flat 45 said 8 x 45 = 360 minutes — a comfortable day. The
    // truth is twice that, and the crew was the one absorbing it.
    const each = serviceMinutes(LAWN, profile({ lawn_band: "large" }));
    expect(each * 8).toBe(720);
    expect(sellableMinutes({ startHour: 7, endHour: 16 })).toBe(540);
    expect(each * 8).toBeGreaterThan(sellableMinutes({ startHour: 7, endHour: 16 }));
  });
});

describe("MONEY ROUNDS DOWN, TIME ROUNDS UP", () => {
  it("an unmeasured house books the LONGEST clean, not the cheapest one", () => {
    // sqft 0 lands in the $80 tier for pricing — an honest floor to charge.
    // For the schedule the same arithmetic would book 75 minutes for the
    // house we know least about, and the crew finds out at 3pm.
    expect(serviceMinutes(CLEAN, profile({ sqft: 0 }))).toBe(150);
  });

  it("a pier with no section count booked at the top rung", () => {
    expect(serviceMinutes(PIER, profile({ pier_sections: 0 }))).toBe(330);
  });

  it("a lawn with no band takes the largest of the three", () => {
    const noBand = profile();
    (noBand as { lawn_band: string }).lawn_band = "";
    expect(serviceMinutes(LAWN, noBand)).toBe(90);
  });

  it("a size above every rung still lands somewhere — the ladder terminates", () => {
    expect(serviceMinutes(PIER, profile({ pier_sections: 400 }))).toBe(330);
  });
});

describe("nothing is ever budgeted at zero", () => {
  it("a service with no ladder falls back to its flat est_minutes", () => {
    const flat = { ...PIER, duration_bands: null };
    expect(serviceMinutes(flat, profile({ pier_sections: 12 }))).toBe(180);
  });

  it("a service with neither takes the fallback, never zero", () => {
    const bare: ServiceRule & { est_minutes: number; duration_bands: null } = {
      name: "New thing", pricing_model: "flat", base: 100, unit_rate: 0,
      band_pricing: null, est_minutes: 0, duration_bands: null,
    };
    // A zero-minute job is a job the time budget cannot see, which is exactly
    // how a day silently overfills.
    expect(serviceMinutes(bare, profile())).toBe(FALLBACK_JOB_MINUTES);
  });

  it("an empty ladder is ignored rather than believed", () => {
    expect(serviceMinutes({ ...PIER, duration_bands: { rungs: [] } }, profile())).toBe(180);
  });

  it("a rung with nonsense minutes is skipped, not applied", () => {
    const bad = { ...PIER, duration_bands: { rungs: [{ max: 5, minutes: 0 }, { max: null, minutes: 200 }] } };
    expect(serviceMinutes(bad, profile({ pier_sections: 4 }))).toBe(200);
  });

  it("caps a single visit so one bad dial cannot eat a whole week", () => {
    const silly = { ...PIER, duration_bands: { rungs: [{ max: null, minutes: 99999 }] } };
    expect(serviceMinutes(silly, profile())).toBe(MAX_JOB_MINUTES);
  });
});

describe("sizeOf reads the SAME field the price reads", () => {
  it("follows count_field rather than assuming pier sections", () => {
    const lifts: ServiceRule = {
      name: "Boat lift set / pull", pricing_model: "per_section",
      base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 },
    };
    expect(sizeOf(lifts, profile({ boat_lifts: 3 }))).toBe(3);
  });

  it("honours the pricing floor, so time and price count the same thing", () => {
    const lifts: ServiceRule = {
      name: "Boat lift set / pull", pricing_model: "per_section",
      base: 0, unit_rate: 495, band_pricing: { count_field: "boat_lifts", min_count: 1 },
    };
    expect(sizeOf(lifts, profile({ boat_lifts: 0 }))).toBe(1);
  });

  it("measures a boat job by total feet across the fleet", () => {
    const boat: ServiceRule = {
      name: "Boat storage & winterize", pricing_model: "per_foot",
      base: 0, unit_rate: 50, band_pricing: null,
    };
    expect(sizeOf(boat, profile({ boats: [{ length_ft: 19 }, { length_ft: 24 }] }))).toBe(43);
  });

  it("a flat service has no size, which is different from a size of zero", () => {
    const flat: ServiceRule = {
      name: "Spring opening", pricing_model: "flat", base: 430, unit_rate: 0, band_pricing: null,
    };
    expect(sizeOf(flat, profile())).toBeNull();
  });
});

describe("a visit is the sum of its legs — one truck, one driveway", () => {
  it("adds the legs up", () => {
    expect(visitMinutes([
      { rule: LAWN, profile: profile({ lawn_band: "small" }) },   // 30
      { rule: CLEAN, profile: profile({ sqft: 1600 }) },          // 75
    ])).toBe(105);
  });

  it("an empty visit still costs something", () => {
    expect(visitMinutes([])).toBe(FALLBACK_JOB_MINUTES);
  });

  it("caps the total too", () => {
    const legs = Array.from({ length: 12 }, () => ({ rule: PIER, profile: profile({ pier_sections: 16 }) }));
    expect(visitMinutes(legs)).toBe(MAX_JOB_MINUTES);
  });
});

describe("7 to 4 — what we SELL into a crew's day", () => {
  const PLATFORM = { startHour: 7, endHour: 16 };

  it("nine sellable hours by default", () => {
    expect(sellableMinutes(PLATFORM)).toBe(540);
  });

  it("a crew may open later than we do", () => {
    expect(sellableWindow(PLATFORM, { workStart: 9, workEnd: 16 }))
      .toEqual({ startHour: 9, endHour: 16 });
  });

  it("a crew may close earlier than we do", () => {
    expect(sellableWindow(PLATFORM, { workStart: 7, workEnd: 14 }))
      .toEqual({ startHour: 7, endHour: 14 });
  });

  it("A CREW MAY NOT PUSH THE CUTOFF LATER — that is the whole point", () => {
    // They are free to work past four on their own jobs. We do not fill it.
    expect(sellableWindow(PLATFORM, { workStart: 7, workEnd: 20 }))
      .toEqual({ startHour: 7, endHour: 16 });
  });

  it("a crew with no truck configured gets the platform window", () => {
    // All three live crews are in this state today — zero crew_units rows.
    expect(sellableWindow(PLATFORM, null)).toEqual(PLATFORM);
  });

  it("a backwards window sells NOTHING rather than reading as unlimited", () => {
    const w = sellableWindow(PLATFORM, { workStart: 15, workEnd: 8 });
    expect(sellableMinutes(w)).toBe(0);
  });
});

describe("would it still be done by four?", () => {
  const WIN = { startHour: 7, endHour: 16 };

  it("an empty day fits a long pier", () => {
    const r = fitsInDay(WIN, 0, 330);
    expect(r.fits).toBe(true);
    expect(clockLabel(r.endsAtMinutes)).toBe("12:30pm");
  });

  it("names how far past the cutoff it would run", () => {
    const r = fitsInDay(WIN, 480, 120);          // 8h booked, 2h more
    expect(r.fits).toBe(false);
    expect(r.overBy).toBe(60);
    expect(clockLabel(r.endsAtMinutes)).toBe("5:00pm");
  });

  it("exactly four o'clock still fits — the cutoff is when work ENDS", () => {
    expect(fitsInDay(WIN, 480, 60).fits).toBe(true);
  });

  it("SIX large lawns fill a 7-to-4 day exactly, and a seventh does not", () => {
    // 6 x 90 = 540 = the whole sellable day, finishing at 4:00 on the nose.
    // Under the old flat 45 minutes the machine would have booked twelve.
    const each = 90;
    expect(fitsInDay(WIN, each * 5, each).fits).toBe(true);
    expect(clockLabel(fitsInDay(WIN, each * 5, each).endsAtMinutes)).toBe("4:00pm");
    expect(fitsInDay(WIN, each * 6, each).fits).toBe(false);
    expect(fitsInDay(WIN, each * 6, each).overBy).toBe(90);
  });
});

describe("clock labels a person can read", () => {
  it("reads morning, noon, afternoon and midnight correctly", () => {
    expect(clockLabel(7 * 60)).toBe("7:00am");
    expect(clockLabel(12 * 60)).toBe("12:00pm");
    expect(clockLabel(16 * 60 + 30)).toBe("4:30pm");
    expect(clockLabel(0)).toBe("12:00am");
  });
});
