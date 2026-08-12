import { describe, it, expect } from "vitest";
import {
  toStay, buildRentRoll, summarise, coversDay, canApprove,
  buildLotRow, buildLotRange, buildParkProfileRow, buildRateRows, previewStayValue,
  planBulkRates, buildTenant, buildParkDialsRow, dialsWarning, noticeShape,
  type BulkRateTarget, type TenantInput,
  type RawReservation, type Stay, type LotFormInput, type LotRangeInput, type ParkProfileInput,
  buildTenantEdit,
  type TenantEditInput,
  parseLotSeason,
} from "./park-helpers";
import { parseDaterange, toDaterange, type Lot } from "@/lib/parks";

const lot = (over: Partial<Lot> = {}): Lot => ({
  id: "l1", lotNumber: "12", siteType: "rv_site", maxLengthFt: 40, amperage: 50,
  hasWater: true, hasSewer: true, slipIncluded: false, active: true, ...over,
});

const raw = (over: Partial<RawReservation> = {}): RawReservation => ({
  id: "r1", park_lot_id: "l1", renter_id: "pr1", renter_unit_id: null,
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
      // 0065: inventory that isn't real yet, counted apart from occupancy.
      planned: 0, renovating: 0, shortTermLots: 0,
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
    lotNumber: "12", siteType: "rv_site", maxLengthFt: "40", amperage: "50",
    hasWater: true, hasSewer: true, slipIncluded: false, notes: "", active: true, ...over,
  });
  it("shapes a good lot", () => {
    const res = buildLotRow(form());
    expect(res.ok).toBe(true);
    expect(res.row).toMatchObject({ lot_number: "12", site_type: "rv_site", max_length_ft: 40, amperage: 50 });
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
    expect(buildLotRow(form({ siteType: "mh_single", hasSewer: false })).error).toMatch(/needs sewer/i);
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

// ---------------------------------------------------------------------------
// THE LOT GENERATOR. Without it the importer has nothing to import into —
// park_lots is empty on closing morning and the join key is lot_number. A real
// owner walked through the one-at-a-time form and quit at lot 22, having never
// reached the part that helps them.
// ---------------------------------------------------------------------------
describe("buildLotRange — a whole park in one form", () => {
  const range = (over: Partial<LotRangeInput> = {}): LotRangeInput => ({
    prefix: "", from: "1", to: "79", siteType: "mh_single",
    maxLengthFt: "", amperage: "", ...over,
  });

  it("makes 79 lots for a 79-lot park", () => {
    const res = buildLotRange(range());
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(79);
    expect(res.rows![0].lot_number).toBe("1");
    expect(res.rows![78].lot_number).toBe("79");
  });

  it("a mobile-home pad comes with sewer, so our own validator stops refusing it", () => {
    // The trap this fixes: a new lot defaulted to rv_full + hasSewer:false, and
    // buildLotRow REFUSES an mh_pad without sewer. Setting up a park of pads hit
    // that refusal on every single lot, caused by a default nobody chose.
    const res = buildLotRange(range({ siteType: "mh_single" }));
    expect(res.ok).toBe(true);
    expect(res.rows!.every((r) => r.has_sewer)).toBe(true);
  });

  it("an RV site defaults to FULL hookup — the owner unchecks sewer for the smaller row", () => {
    // 0057 removed rv_full/rv_we as separate TYPES: they were the same lot with
    // different equipment, and duplicating the fact let a lot claim
    // site_type=rv_full with has_sewer=false — storable and meaningless.
    // Hookups now live only in has_water/has_sewer/amperage.
    const res = buildLotRange(range({ siteType: "rv_site", to: "5" }));
    expect(res.rows!.every((r) => r.site_type === "rv_site")).toBe(true);
    expect(res.rows!.every((r) => r.has_water && r.has_sewer)).toBe(true);
  });

  it("both pad widths exist, and both come with sewer", () => {
    // The gap this migration closed: mh_pad collapsed single and double into
    // one type, so a park with both was unrepresentable.
    for (const t of ["mh_single", "mh_double"]) {
      const res = buildLotRange(range({ siteType: t, to: "3" }));
      expect(res.ok).toBe(true);
      expect(res.rows!.every((r) => r.site_type === t && r.has_sewer)).toBe(true);
    }
  });

  it("a tent site and a slip carry no hookups by default", () => {
    for (const t of ["tent", "slip"]) {
      const res = buildLotRange(range({ siteType: t, to: "3" }));
      expect(res.rows!.every((r) => !r.has_water && !r.has_sewer)).toBe(true);
    }
  });

  it("a retired type name is refused rather than silently stored", () => {
    for (const dead of ["rv_full", "rv_we", "mh_pad", "slip_only"]) {
      expect(buildLotRange(range({ siteType: dead })).ok).toBe(false);
    }
  });

  it("supports a prefix — A1 through A20", () => {
    const res = buildLotRange(range({ prefix: "A", from: "1", to: "20" }));
    expect(res.rows).toHaveLength(20);
    expect(res.rows![0].lot_number).toBe("A1");
    expect(res.rows![19].lot_number).toBe("A20");
  });

  it("SKIPS lots that already exist rather than dying on the first collision", () => {
    // Re-running "1 to 79" after adding lot 3 by hand must quietly do the rest,
    // not fail and leave the park half-built.
    const res = buildLotRange(range({ to: "5" }), ["2", "4"]);
    expect(res.ok).toBe(true);
    expect(res.rows!.map((r) => r.lot_number)).toEqual(["1", "3", "5"]);
    expect(res.skipped).toEqual(["2", "4"]);
  });

  it("says so plainly when the whole range already exists", () => {
    const res = buildLotRange(range({ to: "3" }), ["1", "2", "3"]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exist/i);
    expect(res.skipped).toEqual(["1", "2", "3"]);
  });

  it("catches the fat finger — 1 to 7900 is a sentence, not 90 seconds of inserts", () => {
    const res = buildLotRange(range({ to: "7900" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/7,900 lots/);
  });

  it("refuses a backwards or non-numeric range", () => {
    expect(buildLotRange(range({ from: "79", to: "1" })).ok).toBe(false);
    expect(buildLotRange(range({ from: "one", to: "ten" })).ok).toBe(false);
    expect(buildLotRange(range({ from: "-3", to: "5" })).ok).toBe(false);
  });

  it("a single lot is a valid range", () => {
    const res = buildLotRange(range({ from: "12", to: "12" }));
    expect(res.rows).toHaveLength(1);
    expect(res.rows![0].lot_number).toBe("12");
  });

  it("every generated row passes the SAME validator a hand-typed lot does", () => {
    // If the generator could emit a row the form would reject, the two paths
    // would drift and only one of them would be right.
    const res = buildLotRange(range({ siteType: "mh_single", maxLengthFt: "60", amperage: "100", to: "10" }));
    for (const row of res.rows!) {
      const reBuilt = buildLotRow({
        lotNumber: row.lot_number, siteType: row.site_type,
        maxLengthFt: String(row.max_length_ft ?? ""), amperage: String(row.amperage ?? ""),
        hasWater: row.has_water, hasSewer: row.has_sewer,
        slipIncluded: row.slip_included, notes: row.notes ?? "", active: row.active,
      });
      expect(reBuilt.ok).toBe(true);
    }
  });

  it("rejects a bad amperage once, for the whole range, before writing anything", () => {
    const res = buildLotRange(range({ amperage: "42" }));
    expect(res.ok).toBe(false);
    expect(res.rows).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BULK RATES. The generator solved "79 lots, one form"; this is the identical
// problem one step later. Without it, pricing a park means opening a panel per
// lot — the same wall the owner already quit at.
// ---------------------------------------------------------------------------
describe("planBulkRates — price a park without clobbering what was tuned by hand", () => {
  const t = (lotId: string, siteType = "mh_single", existingRateCount = 0): BulkRateTarget =>
    ({ lotId, siteType, existingRateCount });

  it("prices every unpriced lot", () => {
    const plan = planBulkRates([t("a"), t("b"), t("c")], { monthly: "340" });
    expect(plan.ok).toBe(true);
    expect(plan.lotIds).toEqual(["a", "b", "c"]);
    expect(plan.rows).toEqual([{ term: "monthly", amount: 340 }]);
  });

  it("SKIPS lots that already have rates — a silent overwrite is unrecoverable", () => {
    // There is no undo on a rate card, and the damage stays invisible until a
    // renter is quoted the wrong number.
    const plan = planBulkRates([t("a"), t("b", "mh_single", 2), t("c")], { monthly: "340" });
    expect(plan.lotIds).toEqual(["a", "c"]);
    expect(plan.skippedPriced).toBe(1);
  });

  it("replaces existing only when explicitly asked", () => {
    const plan = planBulkRates(
      [t("a"), t("b", "mh_single", 2)], { monthly: "340" }, { replaceExisting: true },
    );
    expect(plan.lotIds).toEqual(["a", "b"]);
    expect(plan.skippedPriced).toBe(0);
  });

  it("can target one site type — pads at $340, RV sites at $55 a night", () => {
    const plan = planBulkRates(
      [t("a", "mh_single"), t("b", "rv_site"), t("c", "mh_single")],
      { monthly: "340" }, { siteType: "mh_single" },
    );
    expect(plan.lotIds).toEqual(["a", "c"]);
    expect(plan.skippedType).toBe(1);
  });

  it("refuses an empty card rather than pricing 79 lots at nothing", () => {
    expect(planBulkRates([t("a")], {}).ok).toBe(false);
    expect(planBulkRates([t("a")], { monthly: "" }).ok).toBe(false);
    expect(planBulkRates([t("a")], { monthly: "0" }).ok).toBe(false);
  });

  it("passes a bad amount straight through the same validator a single lot uses", () => {
    expect(planBulkRates([t("a")], { monthly: "-5" }).ok).toBe(false);
    expect(planBulkRates([t("a")], { monthly: "abc" }).ok).toBe(false);
  });

  it("says something ACTIONABLE when every lot was already priced", () => {
    const plan = planBulkRates([t("a", "mh_single", 1), t("b", "mh_single", 1)], { monthly: "340" });
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/replace existing/i);
    expect(plan.skippedPriced).toBe(2);
  });

  it("accepts money typed the way a person types it", () => {
    const plan = planBulkRates([t("a")], { monthly: "$1,250.50" });
    expect(plan.rows).toEqual([{ term: "monthly", amount: 1250.5 }]);
  });
});

// ---------------------------------------------------------------------------
// TIER AND FEATURES. Premium is an ATTRIBUTE, not a site type — make it a type
// and "premium double-wide" becomes inexpressible, which is exactly the model
// starting to lie.
// ---------------------------------------------------------------------------
describe("tier and features — what a lot is WORTH, separate from what it IS", () => {
  const form = (over: Partial<LotFormInput> = {}): LotFormInput => ({
    lotNumber: "12", siteType: "rv_site", maxLengthFt: "", amperage: "",
    hasWater: true, hasSewer: true, slipIncluded: false, notes: "", active: true, ...over,
  });

  it("a premium double-wide is sayable — the whole point of splitting them", () => {
    const res = buildLotRow(form({ siteType: "mh_double", tier: "premium", features: ["waterfront", "corner"] }));
    expect(res.ok).toBe(true);
    expect(res.row).toMatchObject({ site_type: "mh_double", tier: "premium" });
    expect(res.row!.features).toEqual(["waterfront", "corner"]);
  });

  it("defaults to standard with no features", () => {
    const res = buildLotRow(form());
    expect(res.row).toMatchObject({ tier: "standard" });
    expect(res.row!.features).toEqual([]);
  });

  it("refuses a tier we do not know", () => {
    expect(buildLotRow(form({ tier: "deluxe" })).ok).toBe(false);
  });

  it("DROPS an unrecognised feature rather than storing it", () => {
    // Free text on a housing listing is where a fair-housing problem gets
    // typed. The database allowlist is the real guard; this is the soft one.
    const res = buildLotRow(form({ features: ["waterfront", "no kids", "shade"] }));
    expect(res.row!.features).toEqual(["waterfront", "shade"]);
  });

  it("a whole row of lots can be made premium in one action", () => {
    const res = buildLotRange({
      prefix: "W", from: "1", to: "6", siteType: "rv_site",
      maxLengthFt: "", amperage: "", tier: "premium",
    });
    expect(res.rows).toHaveLength(6);
    expect(res.rows!.every((r) => r.tier === "premium")).toBe(true);
  });

  it("bulk rates can price PREMIUM differently, which is why premium exists", () => {
    const plan = planBulkRates(
      [
        { lotId: "a", siteType: "rv_site", tier: "premium" },
        { lotId: "b", siteType: "rv_site", tier: "standard" },
        { lotId: "c", siteType: "rv_site", tier: "premium" },
      ].map((x) => ({ ...x, existingRateCount: 0 })),
      { nightly: "75" },
      { tier: "premium" },
    );
    expect(plan.lotIds).toEqual(["a", "c"]);
    expect(plan.skippedType).toBe(1);
  });

  it("a lot with no tier recorded counts as standard", () => {
    const plan = planBulkRates(
      [{ lotId: "a", siteType: "rv_site", existingRateCount: 0 }],
      { nightly: "55" }, { tier: "standard" },
    );
    expect(plan.lotIds).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// THE SITTING TENANT. The person already living there when he bought the park.
// Until these exist in the system the rent roll is empty and he keeps using
// the notebook — at which point nothing else we built matters.
// ---------------------------------------------------------------------------
describe("buildTenant — the tenant who was already there", () => {
  const TODAY = "2026-08-09";
  const input = (over: Partial<TenantInput> = {}): TenantInput => ({
    displayName: "Donna Reyes", mobile: "", email: "",
    movedInOn: "", term: "monthly", rent: "", source: "seller_roll", ...over,
  });

  it("a NAME alone is enough to start", () => {
    // A form that demands rent and a date before it saves is a form abandoned
    // at lot 9. A name and a lot already beat a notebook.
    const res = buildTenant(input(), TODAY);
    expect(res.ok).toBe(true);
    expect(res.renter!.display_name).toBe("Donna Reyes");
    expect(res.tenancy!.quoted_amount).toBeNull();
  });

  it("NEVER asks for a move-out date — it writes a finite range silently", () => {
    // Unbounded ranges are forbidden: parseDaterange returns null for
    // "[2019-05-01,)", a null range makes coversDay false, and the rent roll
    // would report the lot VACANT while someone lives on it.
    const res = buildTenant(input({ movedInOn: "2019-05-01" }), TODAY);
    expect(res.tenancy!.start).toBe("2019-05-01");
    expect(res.tenancy!.end).toBe("2020-04-30");
    expect(parseDaterange(toDaterange({ start: res.tenancy!.start, end: res.tenancy!.end }))).not.toBeNull();
  });

  it("blank move-in means ALREADY HERE and dates the record, not the person", () => {
    const res = buildTenant(input({ movedInOn: "" }), TODAY);
    expect(res.tenancy!.start).toBe(TODAY);
  });

  it("refuses a future move-in — that is a booking, not a sitting tenant", () => {
    expect(buildTenant(input({ movedInOn: "2027-01-01" }), TODAY).ok).toBe(false);
  });

  it("defaults to PAPER even when the owner types a phone number in", () => {
    // This test used to assert the opposite, and that assertion was the bug:
    // a number the OWNER read off a seller's roll flipped the household to
    // 'sms', and remindExpiringStays then texted them from a nightly cron.
    // A number somebody else wrote down is not consent from its owner.
    expect(buildTenant(input(), TODAY).renter!.contact_pref).toBe("paper");
    expect(buildTenant(input({ mobile: "(260) 555-0142" }), TODAY).renter!.contact_pref).toBe("paper");
  });

  it("keeps the phone number in a shape we can text", () => {
    const res = buildTenant(input({ mobile: "(260) 555-0142" }), TODAY);
    expect(res.renter!.mobile_e164).toBe("2605550142");
  });

  it("carries PROVENANCE, so the roll can later show its work", () => {
    expect(buildTenant(input({ source: "seller_roll" }), TODAY).renter!.source).toBe("seller_roll");
    expect(buildTenant(input({ source: "owner_knowledge" }), TODAY).renter!.source).toBe("owner_knowledge");
    expect(buildTenant(input({ source: "invented" }), TODAY).ok).toBe(false);
  });

  it("takes rent the way a person types it, and refuses nonsense", () => {
    expect(buildTenant(input({ rent: "$1,250" }), TODAY).tenancy!.quoted_amount).toBe(1250);
    expect(buildTenant(input({ rent: "-5" }), TODAY).ok).toBe(false);
    expect(buildTenant(input({ rent: "9999999" }), TODAY).ok).toBe(false);
  });

  it("needs a name, and catches a short phone or a bad email", () => {
    expect(buildTenant(input({ displayName: "  " }), TODAY).ok).toBe(false);
    expect(buildTenant(input({ mobile: "555" }), TODAY).ok).toBe(false);
    expect(buildTenant(input({ email: "donna@" }), TODAY).ok).toBe(false);
  });

  it("the range it writes always survives a round trip through Postgres", () => {
    for (const start of ["2019-05-01", "2024-02-29", "2026-12-31"]) {
      const res = buildTenant(input({ movedInOn: start }), "2027-01-01");
      const back = parseDaterange(toDaterange({ start: res.tenancy!.start, end: res.tenancy!.end }));
      expect(back).toEqual({ start: res.tenancy!.start, end: res.tenancy!.end });
    }
  });
});

// ---------------------------------------------------------------------------
// EDITING A TENANT. The importer's receipt promises the seller-roll figure will
// split as he confirms people at the window. This is the only thing that can
// make that true, so the provenance rules are the test.
// ---------------------------------------------------------------------------
describe("buildTenantEdit", () => {
  const TODAY = "2026-08-09";
  const current = { rent: 385, dueDay: 1 };

  it("fixes a typo without touching the money or its provenance", () => {
    const r = buildTenantEdit(
      { displayName: "Wexler, Donna", rent: "385", dueDay: "1", confirmedWithTenant: false },
      current, TODAY,
    );
    expect(r.ok).toBe(true);
    expect(r.renter!.display_name).toBe("Wexler, Donna");
    expect(r.tenancy!.quoted_amount).toBe(385);
    // THE ONE THAT MATTERS: an unchanged amount keeps its provenance. If a name
    // edit promoted a seller's number, the "still exposed on" figure would
    // decay to zero by accident and stop meaning anything.
    expect(r.tenancy!.amount_source).toBeUndefined();
    expect(r.renter!.confirmed_at).toBeNull();
  });

  it("a rent he retypes becomes HIS number, not the seller's", () => {
    const r = buildTenantEdit(
      { displayName: "Wexler, Donna", rent: "410", dueDay: "1", confirmedWithTenant: false },
      current, TODAY,
    );
    expect(r.tenancy!.quoted_amount).toBe(410);
    expect(r.tenancy!.amount_source).toBe("owner_knowledge");
  });

  it("confirming with the tenant is the only thing that reaches tenant_confirmed", () => {
    const r = buildTenantEdit(
      { displayName: "Wexler, Donna", rent: "385", dueDay: "1", confirmedWithTenant: true },
      current, TODAY,
    );
    // Unchanged number, but CONFIRMED — proving the seller right is worth
    // exactly as much as correcting him.
    expect(r.tenancy!.quoted_amount).toBe(385);
    expect(r.tenancy!.amount_source).toBe("tenant_confirmed");
    expect(r.renter!.confirmed_at).toBe(TODAY);
  });

  it("confirmation beats a correction when he does both at once", () => {
    const r = buildTenantEdit(
      { displayName: "Wexler, Donna", rent: "410", dueDay: "1", confirmedWithTenant: true },
      current, TODAY,
    );
    expect(r.tenancy!.amount_source).toBe("tenant_confirmed");
  });

  it("lets him clear a rent he doesn't actually know", () => {
    const r = buildTenantEdit(
      { displayName: "Wexler, Donna", rent: "", dueDay: "1", confirmedWithTenant: false },
      current, TODAY,
    );
    expect(r.tenancy!.quoted_amount).toBeNull();
    expect(r.tenancy!.amount_source).toBe("owner_knowledge");
  });

  it("accepts money the way people type it", () => {
    for (const [typed, want] of [["$1,250.00", 1250], ["410 ", 410], ["385.50", 385.5]] as const) {
      const r = buildTenantEdit(
        { displayName: "X Y", rent: typed, dueDay: "", confirmedWithTenant: false },
        current, TODAY,
      );
      expect(r.tenancy!.quoted_amount, typed).toBe(want);
    }
  });

  it("refuses what the database would refuse anyway, in words", () => {
    const bad = (over: Partial<TenantEditInput>) =>
      buildTenantEdit(
        { displayName: "X Y", rent: "385", dueDay: "1", confirmedWithTenant: false, ...over },
        current, TODAY,
      );
    expect(bad({ displayName: "   " }).ok).toBe(false);
    expect(bad({ displayName: "x".repeat(121) }).ok).toBe(false);
    expect(bad({ rent: "four hundred" }).ok).toBe(false);
    expect(bad({ rent: "-5" }).ok).toBe(false);
    expect(bad({ dueDay: "41" }).ok).toBe(false);   // lot_res_due_day_check
    expect(bad({ dueDay: "0" }).ok).toBe(false);
    expect(bad({ dueDay: "2.5" }).ok).toBe(false);
    for (const b of [{ displayName: "   " }, { rent: "four hundred" }, { dueDay: "41" }]) {
      expect(bad(b).error, JSON.stringify(b)).toMatch(/[a-z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// A LOT'S OWN SEASON. The Haven's slips come out of the water in October while
// the pads beside them run year-round — a shape a park-level season alone
// cannot express.
// ---------------------------------------------------------------------------
describe("parseLotSeason", () => {
  const blank = {
    season_open_month: null, season_open_day: null,
    season_close_month: null, season_close_day: null,
  };

  it("blank on both means: inherit the park", () => {
    expect(parseLotSeason("", "")).toEqual({ ok: true, row: blank });
    expect(parseLotSeason(undefined, undefined)).toEqual({ ok: true, row: blank });
  });

  it("reads a real slip season", () => {
    expect(parseLotSeason("04-01", "10-31").row).toEqual({
      season_open_month: 4, season_open_day: 1,
      season_close_month: 10, season_close_day: 31,
    });
  });

  it("REFUSES half a season", () => {
    // An open date with no close reads as year-round and sells a slip in
    // February. Both or neither.
    expect(parseLotSeason("04-01", "").ok).toBe(false);
    expect(parseLotSeason("", "10-31").ok).toBe(false);
    expect(parseLotSeason("04-01", "").error).toMatch(/both/i);
  });

  it("refuses nonsense dates in words", () => {
    for (const bad of [["13-01", "10-31"], ["04-32", "10-31"], ["April", "October"], ["4/1", "10/31"]]) {
      const r = parseLotSeason(bad[0], bad[1]);
      expect(r.ok, bad.join(" ")).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });

  it("carries the season onto the lot row", () => {
    const r = buildLotRow({
      lotNumber: "S1", siteType: "slip", maxLengthFt: "", amperage: "",
      hasWater: false, hasSewer: false, slipIncluded: true, notes: "",
      active: true, seasonOpen: "04-01", seasonClose: "10-31",
    });
    expect(r.ok).toBe(true);
    expect(r.row!.season_open_month).toBe(4);
    expect(r.row!.season_close_day).toBe(31);
  });

  it("leaves a year-round pad with no season at all", () => {
    const r = buildLotRow({
      lotNumber: "1", siteType: "mh_single", maxLengthFt: "", amperage: "",
      hasWater: true, hasSewer: true, slipIncluded: false, notes: "",
      active: true,
    });
    expect(r.row!.season_open_month).toBeNull();
  });
});

// ------------------------------------------------------------ park dials ---

describe("park dials — the numbers nothing could write", () => {
  const blank = {
    maxAgreementMonths: "", depositAmount: "", rentDueDay: "",
    officeRecordingLagDays: "", rentNoticeDays: "", cutoverOn: "",
  };

  it("writes the owner's three-month cap, which the 0062 trigger reads", () => {
    const r = buildParkDialsRow({ ...blank, maxAgreementMonths: "3" });
    expect(r.ok).toBe(true);
    expect(r.row!.max_agreement_months).toBe(3);
  });

  it("treats a blank cap as NO cap rather than as zero", () => {
    const r = buildParkDialsRow(blank);
    expect(r.row!.max_agreement_months).toBeNull();
  });

  it("leaves a NOT NULL dial alone when the box is blank, rather than nulling it", () => {
    // rent_due_day is NOT NULL with a default. Clearing the field must mean
    // "don't change it", never "have no due day" — which would fail the insert.
    const r = buildParkDialsRow(blank);
    expect("rent_due_day" in r.row!).toBe(false);
    expect("office_recording_lag_days" in r.row!).toBe(false);
    expect("rent_notice_days" in r.row!).toBe(false);
  });

  it("takes the 45-day notice period he actually asked for", () => {
    const r = buildParkDialsRow({ ...blank, rentNoticeDays: "45" });
    expect(r.row!.rent_notice_days).toBe(45);
  });

  it("refuses a due day past the 28th — no park bills on a day February lacks", () => {
    expect(buildParkDialsRow({ ...blank, rentDueDay: "31" }).ok).toBe(false);
    expect(buildParkDialsRow({ ...blank, rentDueDay: "28" }).ok).toBe(true);
  });

  it("refuses junk without pretending it understood", () => {
    expect(buildParkDialsRow({ ...blank, maxAgreementMonths: "three" }).ok).toBe(false);
    expect(buildParkDialsRow({ ...blank, depositAmount: "lots" }).ok).toBe(false);
    expect(buildParkDialsRow({ ...blank, cutoverOn: "December" }).ok).toBe(false);
  });

  it("takes a deposit with a dollar sign and commas", () => {
    expect(buildParkDialsRow({ ...blank, depositAmount: "$1,200" }).row!.deposit_amount).toBe(1200);
  });

  it("warns only when the roll already runs longer than the new cap", () => {
    expect(dialsWarning(3, 365)).toMatch(/stay exactly as they are/);
    expect(dialsWarning(3, 90)).toBeNull();
    expect(dialsWarning(null, 365)).toBeNull();
  });
});

describe("adding a tenant under an agreement cap", () => {
  const input = {
    displayName: "Roy Amberg", movedInOn: "", term: "monthly",
    rent: "395", mobile: "", email: "", source: "owner_knowledge",
  };

  it("writes a 365-day range when the park has NO cap", () => {
    const r = buildTenant(input, "2026-08-11", null);
    expect(r.tenancy!.end).toBe("2027-08-11");
  });

  it("shortens the tenancy to the cap, so the 0062 trigger cannot refuse it", () => {
    // The trigger refuses span_days > cap*31 + 1. At a 3-month cap that is 94.
    const r = buildTenant(input, "2026-08-11", 3);
    expect(r.tenancy!.end).toBe("2026-11-11");
    const span =
      (Date.UTC(2026, 10, 11) - Date.UTC(2026, 7, 11)) / 86_400_000;
    expect(span).toBeLessThanOrEqual(3 * 31 + 1);
  });

  it("clamps a short month instead of producing an impossible date", () => {
    const r = buildTenant({ ...input, movedInOn: "2026-01-31" }, "2026-08-11", 1);
    expect(r.tenancy!.end).toBe("2026-02-28");
  });

  it("a cap shortens the agreement, it never refuses the person", () => {
    expect(buildTenant(input, "2026-08-11", 1).ok).toBe(true);
  });
});

describe("what a notice period costs, in dates", () => {
  it("turns an abstract number into a date he can hold to a calendar", () => {
    const s = noticeShape(45, 3, "2026-08-11");
    expect(s.earliest).toBe("2026-09-25");
    expect(s.line).toContain("earliest a new rent could start is 2026-09-25");
  });

  it("says a 45-day notice costs NOTHING against 3-month agreements", () => {
    // Inside a fixed term the rent is the rent — increases land at renewal, so
    // notice served at the halfway point of a 90-day cycle constrains nothing.
    const s = noticeShape(45, 3, "2026-08-11");
    expect(s.fitsInTerm).toBe(true);
    expect(s.line).toMatch(/costs you nothing/);
    expect(s.line).toMatch(/only bites on month-to-month/);
  });

  it("warns when the notice is LONGER than a whole term", () => {
    // 120 days' notice against a 3-month cap means no increase can ever land
    // inside a term — every one slips a full cycle.
    const s = noticeShape(120, 3, "2026-08-11");
    expect(s.fitsInTerm).toBe(false);
    expect(s.line).toMatch(/slip a whole/);
  });

  it("still gives the date when the park has no cap at all", () => {
    const s = noticeShape(45, null, "2026-08-11");
    expect(s.earliest).toBe("2026-09-25");
    expect(s.fitsInTerm).toBe(true);
    expect(s.line).not.toMatch(/agreements/);
  });
});
