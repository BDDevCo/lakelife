import { describe, it, expect } from "vitest";
import {
  toStay, buildRentRoll, summarise, coversDay, canApprove,
  buildLotRow, buildParkProfileRow, buildRateRows, previewStayValue,
  type RawReservation, type Stay, type LotFormInput, type ParkProfileInput,
} from "./park-helpers";
import { parseDaterange, toDaterange, type Lot } from "@/lib/parks";

const lot = (over: Partial<Lot> = {}): Lot => ({
  id: "l1", lotNumber: "12", siteType: "rv_full", maxLengthFt: 40, amperage: 50,
  hasWater: true, hasSewer: true, slipIncluded: false, active: true, ...over,
});

const raw = (over: Partial<RawReservation> = {}): RawReservation => ({
  id: "r1", park_lot_id: "l1", renter_user_id: "u1", renter_unit_id: null,
  during: "[2026-07-01,2026-07-08)", term: "weekly", quoted_amount: 315,
  status: "approved", decided_at: null, created_at: "2026-06-01T00:00:00Z", ...over,
});

const stay = (over: Partial<RawReservation> = {}): Stay => toStay(raw(over));

// ---------------------------------------------------------------------------
describe("parseDaterange — Postgres hands back text, and an off-by-one is a billed night", () => {
  it("reads the ordinary half-open form", () => {
    expect(parseDaterange("[2026-07-01,2026-07-08)")).toEqual({ start: "2026-07-01", end: "2026-07-08" });
  });
  it("normalises an inclusive end to half-open", () => {
    // Postgres can render a date range as [a,b]; that b is a night we owe.
    expect(parseDaterange("[2026-07-01,2026-07-07]")).toEqual({ start: "2026-07-01", end: "2026-07-08" });
  });
  it("normalises an exclusive start", () => {
    expect(parseDaterange("(2026-06-30,2026-07-08)")).toEqual({ start: "2026-07-01", end: "2026-07-08" });
  });
  it("tolerates whitespace", () => {
    expect(parseDaterange(" [ 2026-07-01 , 2026-07-08 ) ")).toEqual({ start: "2026-07-01", end: "2026-07-08" });
  });
  it("returns null for junk, empty and null — never a made-up date", () => {
    for (const bad of ["", "empty", "[2026-07-01,)", "2026-07-01", null, undefined, "[nope,2026-07-08)"]) {
      expect(parseDaterange(bad as string | null)).toBeNull();
    }
  });
  it("returns null for a backwards or empty range", () => {
    expect(parseDaterange("[2026-07-08,2026-07-01)")).toBeNull();
    expect(parseDaterange("[2026-07-01,2026-07-01)")).toBeNull();
  });
  it("round-trips through toDaterange", () => {
    const r = { start: "2026-07-01", end: "2026-07-08" };
    expect(parseDaterange(toDaterange(r))).toEqual(r);
  });
});

// ---------------------------------------------------------------------------
describe("coversDay — the end date is checkout morning, not a night", () => {
  const r = { start: "2026-07-01", end: "2026-07-08" };
  it("covers the first night and every night through the 7th", () => {
    expect(coversDay(r, "2026-07-01")).toBe(true);
    expect(coversDay(r, "2026-07-07")).toBe(true);
  });
  it("does NOT cover checkout day — the lot is free that night", () => {
    expect(coversDay(r, "2026-07-08")).toBe(false);
  });
  it("does not cover the day before arrival, or a null range", () => {
    expect(coversDay(r, "2026-06-30")).toBe(false);
    expect(coversDay(null, "2026-07-02")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("buildRentRoll — the whole park on one screen", () => {
  it("an approved stay covering today reads OCCUPIED, with nights left", () => {
    const rows = buildRentRoll([lot()], [stay()], "2026-07-05");
    expect(rows[0].state).toBe("occupied");
    expect(rows[0].current?.id).toBe("r1");
    expect(rows[0].nightsLeft).toBe(3); // 5th, 6th, 7th
  });
  it("a future approved stay reads RESERVED, not occupied", () => {
    const rows = buildRentRoll([lot()], [stay()], "2026-06-01");
    expect(rows[0].state).toBe("reserved");
    expect(rows[0].current).toBeNull();
    expect(rows[0].next?.id).toBe("r1");
  });
  it("an empty lot reads VACANT — the row the owner most needs to see", () => {
    const rows = buildRentRoll([lot()], [], "2026-07-05");
    expect(rows[0].state).toBe("vacant");
    expect(rows[0].nightsLeft).toBeNull();
  });
  it("an inactive lot is INACTIVE even with a stay on it", () => {
    expect(buildRentRoll([lot({ active: false })], [stay()], "2026-07-05")[0].state).toBe("inactive");
  });
  it("an APPLICATION never makes a lot look occupied — it is a to-do, not a tenancy", () => {
    const rows = buildRentRoll([lot()], [stay({ status: "applied" })], "2026-07-05");
    expect(rows[0].state).toBe("vacant");
    expect(rows[0].pending).toHaveLength(1);
  });
  it("declined, cancelled and ended stays leave the lot vacant", () => {
    for (const status of ["declined", "cancelled", "ended"]) {
      expect(buildRentRoll([lot()], [stay({ status })], "2026-07-05")[0].state).toBe("vacant");
    }
  });
  it("picks the SOONEST upcoming stay as `next`", () => {
    const rows = buildRentRoll([lot()], [
      stay({ id: "far", during: "[2026-09-01,2026-09-08)" }),
      stay({ id: "soon", during: "[2026-08-01,2026-08-08)" }),
    ], "2026-07-05");
    expect(rows[0].next?.id).toBe("soon");
  });
  it("orders pending applications oldest first — first in, first answered", () => {
    const rows = buildRentRoll([lot()], [
      stay({ id: "b", status: "applied", created_at: "2026-06-10T00:00:00Z" }),
      stay({ id: "a", status: "applied", created_at: "2026-06-01T00:00:00Z" }),
    ], "2026-07-05");
    expect(rows[0].pending.map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("keeps each lot's stays to itself", () => {
    const rows = buildRentRoll(
      [lot({ id: "l1" }), lot({ id: "l2", lotNumber: "13" })],
      [stay({ park_lot_id: "l2" })],
      "2026-07-05",
    );
    expect(rows[0].state).toBe("vacant");
    expect(rows[1].state).toBe("occupied");
  });
  it("an unparseable range never occupies a lot — we do not guess at dates", () => {
    const rows = buildRentRoll([lot()], [stay({ during: "garbage" })], "2026-07-05");
    expect(rows[0].state).toBe("vacant");
  });
});

describe("summarise", () => {
  it("counts states and pending across the park", () => {
    const rows = buildRentRoll(
      [lot({ id: "a" }), lot({ id: "b" }), lot({ id: "c" }), lot({ id: "d", active: false })],
      [
        stay({ id: "1", park_lot_id: "a" }),
        stay({ id: "2", park_lot_id: "b", during: "[2026-08-01,2026-08-08)" }),
        stay({ id: "3", park_lot_id: "c", status: "applied" }),
      ],
      "2026-07-05",
    );
    expect(summarise(rows)).toEqual({
      lots: 3, occupied: 1, reserved: 1, vacant: 1, inactive: 1, pending: 1, occupancyPct: 33,
    });
  });
  it("an INACTIVE lot is not inventory — it never dilutes occupancy", () => {
    const rows = buildRentRoll([lot({ id: "a" }), lot({ id: "b", active: false })], [stay({ park_lot_id: "a" })], "2026-07-05");
    expect(summarise(rows).occupancyPct).toBe(100);
  });
  it("a park with no active lots is not '0% full' — it is null", () => {
    // Showing 0% to an owner on setup day is a discouraging lie.
    expect(summarise(buildRentRoll([], [], "2026-07-05")).occupancyPct).toBeNull();
    expect(summarise(buildRentRoll([lot({ active: false })], [], "2026-07-05")).occupancyPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("canApprove — a friendly sentence before the database says no", () => {
  const app = stay({ id: "app", status: "applied" });
  it("approves a free lot", () => {
    expect(canApprove(app, [], lot())).toEqual({ ok: true });
  });
  it("refuses when a decided stay already holds those nights", () => {
    const res = canApprove(app, [stay({ id: "held", during: "[2026-07-05,2026-07-12)" })], lot());
    expect(res).toEqual({ ok: false, problem: "lot_taken" });
  });
  it("allows a back-to-back approval — changeover day is not a conflict", () => {
    expect(canApprove(app, [stay({ id: "prior", during: "[2026-06-24,2026-07-01)" })], lot()).ok).toBe(true);
  });
  it("another APPLICATION never blocks — two people may apply, the owner picks", () => {
    expect(canApprove(app, [stay({ id: "rival", status: "applied" })], lot()).ok).toBe(true);
  });
  it("a declined or cancelled stay never blocks", () => {
    for (const status of ["declined", "cancelled", "ended"]) {
      expect(canApprove(app, [stay({ id: "old", status })], lot()).ok).toBe(true);
    }
  });
  it("refuses an already-decided application", () => {
    expect(canApprove(stay({ status: "approved" }), [], lot()).problem).toBe("not_pending");
  });
  it("refuses unusable dates rather than guessing", () => {
    expect(canApprove(stay({ id: "x", status: "applied", during: null }), [], lot()).problem).toBe("no_dates");
  });
  it("refuses an inactive lot", () => {
    expect(canApprove(app, [], lot({ active: false })).problem).toBe("lot_taken");
  });
  it("ignores stays on OTHER lots", () => {
    expect(canApprove(app, [stay({ id: "elsewhere", park_lot_id: "l2" })], lot()).ok).toBe(true);
  });
  it("does NOT veto on fit — the owner may put whoever they like on their own lot", () => {
    // A 40ft rig on a 30ft pad is a warning at apply time, never a block here.
    expect(canApprove(app, [], lot({ maxLengthFt: 20 })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("buildLotRow", () => {
  const form = (over: Partial<LotFormInput> = {}): LotFormInput => ({
    lotNumber: "12", siteType: "rv_full", maxLengthFt: "40", amperage: "50",
    hasWater: true, hasSewer: true, slipIncluded: false, notes: "", active: true, ...over,
  });
  it("shapes a good lot", () => {
    const res = buildLotRow(form());
    expect(res.ok).toBe(true);
    expect(res.row).toMatchObject({ lot_number: "12", site_type: "rv_full", max_length_ft: 40, amperage: 50 });
  });
  it("blank length and power are UNKNOWN, not zero", () => {
    const res = buildLotRow(form({ maxLengthFt: "", amperage: "" }));
    expect(res.row?.max_length_ft).toBeNull();
    expect(res.row?.amperage).toBeNull();
  });
  it("needs a lot number", () => {
    expect(buildLotRow(form({ lotNumber: "  " })).error).toMatch(/number or name/i);
  });
  it("rejects a non-whole or negative length", () => {
    expect(buildLotRow(form({ maxLengthFt: "40.5" })).ok).toBe(false);
    expect(buildLotRow(form({ maxLengthFt: "-3" })).ok).toBe(false);
    expect(buildLotRow(form({ maxLengthFt: "abc" })).ok).toBe(false);
  });
  it("rejects an amperage the database would refuse", () => {
    expect(buildLotRow(form({ amperage: "42" })).error).toMatch(/20, 30, 50 or 100/);
  });
  it("catches the mobile-home-pad-without-sewer typo", () => {
    // Left alone, the fit rules would silently hide this lot from every mobile
    // home that searched — a vacancy the owner never learns about.
    expect(buildLotRow(form({ siteType: "mh_pad", hasSewer: false })).error).toMatch(/needs sewer/i);
  });
  it("trims, and stores empty notes as null", () => {
    const res = buildLotRow(form({ lotNumber: "  7 ", notes: "   " }));
    expect(res.row?.lot_number).toBe("7");
    expect(res.row?.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("buildParkProfileRow — the setup interview", () => {
  const form = (over: Partial<ParkProfileInput> = {}): ParkProfileInput => ({
    name: "Pretty Lake Park", address: "1 Shore Rd", parkType: "mixed",
    ageRestricted: false, approvalRequired: true,
    seasonOpen: "", seasonClose: "", includedUtilities: ["water"], houseRules: "", ...over,
  });
  it("shapes a year-round park", () => {
    const res = buildParkProfileRow(form());
    expect(res.ok).toBe(true);
    expect(res.row).toMatchObject({
      name: "Pretty Lake Park", park_type: "mixed", approval_required: true,
      season_open_month: null, season_close_month: null,
    });
  });
  it("parses a seasonal window", () => {
    const res = buildParkProfileRow(form({ seasonOpen: "05-01", seasonClose: "10-15" }));
    expect(res.row).toMatchObject({
      season_open_month: 5, season_open_day: 1, season_close_month: 10, season_close_day: 15,
    });
  });
  it("REFUSES half a season — the engine would read it as year-round, the opposite of what was typed", () => {
    expect(buildParkProfileRow(form({ seasonOpen: "05-01" })).error).toMatch(/both/i);
    expect(buildParkProfileRow(form({ seasonClose: "10-15" })).error).toMatch(/both/i);
  });
  it("rejects an impossible date, allows Feb 29", () => {
    expect(buildParkProfileRow(form({ seasonOpen: "02-30", seasonClose: "10-15" })).ok).toBe(false);
    expect(buildParkProfileRow(form({ seasonOpen: "13-01", seasonClose: "10-15" })).ok).toBe(false);
    expect(buildParkProfileRow(form({ seasonOpen: "02-29", seasonClose: "10-15" })).ok).toBe(true);
  });
  it("needs a name and a valid park type", () => {
    expect(buildParkProfileRow(form({ name: " " })).ok).toBe(false);
    expect(buildParkProfileRow(form({ parkType: "castle" })).ok).toBe(false);
  });
  it("drops utilities it does not recognise instead of storing junk", () => {
    const res = buildParkProfileRow(form({ includedUtilities: ["water", "unicorns", "wifi"] }));
    expect(res.row?.included_utilities).toEqual(["water", "wifi"]);
  });
  it("carries the 55+ declaration through untouched — it gates whether age may be asked at all", () => {
    expect(buildParkProfileRow(form({ ageRestricted: true })).row?.age_restricted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("buildRateRows — a blank term is 'not for sale', never $0", () => {
  it("keeps the terms the owner priced", () => {
    const res = buildRateRows({ nightly: "55", weekly: "315", monthly: "", seasonal: "", annual: "" });
    expect(res.rows).toEqual([{ term: "nightly", amount: 55 }, { term: "weekly", amount: 315 }]);
  });
  it("drops a zero — a stored 0 would quote a FREE stay", () => {
    expect(buildRateRows({ nightly: "0", weekly: "315" }).rows).toEqual([{ term: "weekly", amount: 315 }]);
  });
  it("accepts $ and commas the way a person types them", () => {
    expect(buildRateRows({ monthly: "$1,250.50" }).rows).toEqual([{ term: "monthly", amount: 1250.5 }]);
  });
  it("rejects negatives and nonsense", () => {
    expect(buildRateRows({ nightly: "-5" }).ok).toBe(false);
    expect(buildRateRows({ nightly: "abc" }).ok).toBe(false);
  });
  it("catches a fat-finger typo", () => {
    expect(buildRateRows({ nightly: "5500000" }).error).toMatch(/typo/i);
  });
  it("an all-blank card is valid — a park may not have priced anything yet", () => {
    expect(buildRateRows({})).toEqual({ ok: true, rows: [] });
  });
});

describe("previewStayValue", () => {
  const rates = [{ term: "weekly" as const, amount: 315 }];
  it("uses the owner's own card", () => {
    expect(previewStayValue(rates, "weekly", { start: "2026-07-01", end: "2026-07-08" })).toBe(315);
  });
  it("is null for a term they do not sell, and for missing dates", () => {
    expect(previewStayValue(rates, "monthly", { start: "2026-07-01", end: "2026-08-01" })).toBeNull();
    expect(previewStayValue(rates, "weekly", null)).toBeNull();
  });
});
