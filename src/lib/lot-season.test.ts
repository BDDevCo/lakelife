import { describe, it, expect } from "vitest";
import { effectiveSeason, isSeasonal, seasonEndAfter, isAvailable, type Lot, type ParkSeason } from "@/lib/parks";
import { agreementEnd, planRenewal, type AgreementTerms, type PriorAgreement } from "@/app/park/agreement-helpers";

/** The Haven: pads year-round, slips April to October. */
const SLIP_SEASON: ParkSeason = { openMonth: 4, openDay: 1, closeMonth: 10, closeDay: 31 };
const YEAR_ROUND: ParkSeason = { openMonth: null, openDay: null, closeMonth: null, closeDay: null };

const lot = (over: Partial<Lot> = {}): Lot => ({
  id: "l1", lotNumber: "S1", siteType: "slip",
  maxLengthFt: null, amperage: null,
  hasWater: false, hasSewer: false, slipIncluded: false,
  active: true, ...over,
} as Lot);

describe("whose season governs a lot", () => {
  it("uses the LOT's own window when it has one", () => {
    expect(effectiveSeason(SLIP_SEASON, YEAR_ROUND)).toEqual(SLIP_SEASON);
  });

  it("falls back to the park when the lot has none", () => {
    expect(effectiveSeason(null, SLIP_SEASON)).toEqual(SLIP_SEASON);
    expect(effectiveSeason({}, SLIP_SEASON)).toEqual(SLIP_SEASON);
  });

  it("is year-round when neither says otherwise — The Haven's pads", () => {
    expect(isSeasonal(effectiveSeason(null, null))).toBe(false);
    expect(isSeasonal(effectiveSeason(null, YEAR_ROUND))).toBe(false);
  });

  it("ignores a HALF season rather than reading it as a window", () => {
    // The database refuses this shape; the reader must not trust it either.
    const half = { openMonth: 4, openDay: 1, closeMonth: null, closeDay: null };
    expect(isSeasonal(effectiveSeason(half, null))).toBe(false);
  });
});

describe("a slip cannot be sold out of season", () => {
  it("REFUSES January — the bug this whole migration exists for", () => {
    const jan = { start: "2027-01-05", end: "2027-01-12" };
    expect(isAvailable(lot(), jan, [], SLIP_SEASON)).toBe(false);
    // And with no season it would have gone through, which is exactly what
    // was happening before: a park that is year-round, so nothing said no.
    expect(isAvailable(lot(), jan, [])).toBe(true);
  });

  it("allows a stay inside the season", () => {
    expect(isAvailable(lot(), { start: "2027-06-01", end: "2027-07-01" }, [], SLIP_SEASON)).toBe(true);
  });

  it("refuses a stay that STARTS in season and runs past the close", () => {
    expect(isAvailable(lot(), { start: "2027-10-01", end: "2027-12-01" }, [], SLIP_SEASON)).toBe(false);
  });

  it("still refuses when somebody else holds it, in season", () => {
    const held = [{ during: { start: "2027-06-01", end: "2027-07-01" }, status: "active" }];
    expect(isAvailable(lot(), { start: "2027-06-15", end: "2027-06-20" }, held, SLIP_SEASON)).toBe(false);
  });
});

describe("seasonEndAfter", () => {
  it("returns the morning AFTER the last night", () => {
    // Season closes Oct 31, so the guest's last night is the 31st.
    expect(seasonEndAfter("2027-06-01", SLIP_SEASON)).toBe("2027-11-01");
  });

  it("rolls to next year when the close has already passed", () => {
    expect(seasonEndAfter("2027-11-05", SLIP_SEASON)).toBe("2028-11-01");
  });

  it("is null for a year-round lot — nothing to clamp to", () => {
    expect(seasonEndAfter("2027-06-01", YEAR_ROUND)).toBeNull();
  });
});

describe("an agreement ends at whichever comes first", () => {
  const HAVEN_SLIP: AgreementTerms = {
    maxAgreementMonths: 3,
    depositAmount: 400,
    seasonEnd: seasonEndAfter("2027-09-01", SLIP_SEASON),
  };

  it("clamps a September slip to the season close, not three months out", () => {
    // Three months would run to Dec 1, and the slips are out of the water.
    expect(agreementEnd("2027-09-01", HAVEN_SLIP)).toBe("2027-11-01");
  });

  it("uses the term cap when the season ends later", () => {
    const terms: AgreementTerms = {
      maxAgreementMonths: 3, depositAmount: 400,
      seasonEnd: seasonEndAfter("2027-05-01", SLIP_SEASON),   // Nov 1
    };
    expect(agreementEnd("2027-05-01", terms)).toBe("2027-08-01");
  });

  it("leaves a year-round pad on the plain three-month term", () => {
    expect(agreementEnd("2026-12-15", { maxAgreementMonths: 3, depositAmount: 400 }))
      .toBe("2027-03-15");
  });

  it("refuses to renew into a closed season", () => {
    const prior: PriorAgreement = {
      id: "a", chainId: "c", seq: 1,
      start: "2027-08-01", end: "2027-11-01", quotedAmount: 100, term: "monthly",
    };
    const r = planRenewal(prior, {
      maxAgreementMonths: 3, depositAmount: 400,
      seasonEnd: "2027-11-01",
    }, "2027-10-25");
    expect(r.ok).toBe(false);
    expect(r.refusal).toBe("season_closed");
  });
});
