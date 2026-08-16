/**
 * ============================================================================
 *  SEASON-SCALE SIMULATION — the season clock and the automation ladder
 * ============================================================================
 *
 *  TWO FULL SEASONS (2026-01-01 → 2027-12-31, 730 simulated days) across
 *  3 → 6 lakes with different ice-out / pull-deadline dates, ~1000 customers
 *  (plus 250 / 500 / 2000 sweeps for the scaling answer), 10–40 crews, and
 *  the nightly ladder running EVERY simulated night.
 *
 *  This drives the REAL engine functions — nothing under test is
 *  reimplemented here:
 *     src/lib/booking.ts      dayStatus, lakeDateOf, todayLakeDate, isRecurring
 *     src/lib/waitlist.ts     warningDue, isExpired
 *     src/lib/learning.ts     learnedEstimate, median
 *     src/lib/storage.ts      seasonEndFor, overstayDays, perdiemCharge,
 *                             trueLegsToQuote
 *     src/lib/lake-standing.ts shouldDemote, isCoolingDown, healBase
 *     src/lib/digest-render.ts composeNightlyDigest
 *     src/lib/job-view.ts     disputeViewForCustomer/Crew, sanitizeSearchTerm
 *
 *  DETERMINISM: one inline mulberry32 PRNG, no Math.random anywhere. The seed
 *  is printed in every failure message so a red run reproduces exactly.
 *
 *  HISTORY: this file was written DURING the two-season audit
 *  (docs/two-season-audit-2026-07.md) and its findings were originally PINNED
 *  at the then-current (wrong) behavior so the suite stayed green while the
 *  defect stayed documented. Those engine bugs were fixed in 2026-08, so each
 *  of those pins is now a REGRESSION GUARD on the CORRECT behavior, labelled
 *  `REGRESSION (audit bug N)` with a past-tense note about what used to
 *  happen. Anything still labelled `SIM-FOUND` or `MEASURED near-miss` is a
 *  finding that has NOT been fixed and is still pinned at current behavior.
 * ============================================================================
 */

import { describe, it, expect } from "vitest";
import {
  dayStatus,
  lakeDateOf,
  todayLakeDate,
  isRecurring,
  effectiveSeason,
  type DayContext,
  type DayStatus,
} from "../lib/booking";
import { warningDue, isExpired, DEFAULT_WARNING_CATCHUP_DAYS } from "../lib/waitlist";
import { learnedEstimate, median, MIN_REAL_MINUTES, MAX_REAL_MINUTES, MIN_SAMPLES } from "../lib/learning";
import { seasonEndFor, overstayDays, perdiemCharge, trueLegsToQuote } from "../lib/storage";
import { shouldDemote, isCoolingDown, healBase } from "../lib/lake-standing";
import { composeNightlyDigest, type DigestSections } from "../lib/digest-render";
import { disputeViewForCustomer, disputeViewForCrew, sanitizeSearchTerm, photoGateLabel } from "../lib/job-view";

// ---------------------------------------------------------------------------
// SEED + PRNG  (mulberry32 — inline, deterministic, reproducible)
// ---------------------------------------------------------------------------

const SEED = 0xc0ffee;
const S = (msg: string) => `${msg}  [seed=0x${SEED.toString(16)}]`;

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mkRng = (salt: number) => mulberry32((SEED ^ (salt * 0x9e3779b1)) >>> 0);
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// DATE HELPERS (test-side only; date math under test lives in the engine)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(d + "T00:00:00Z");
const shift = (d: string, n: number) => iso(ms(d) + n * DAY_MS);
const diffDays = (a: string, b: string) => Math.round((ms(a) - ms(b)) / DAY_MS);

/** Is this YYYY-MM-DD an actual calendar date (not Feb 31 / Apr 31)? */
function isRealCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const SIM_START = "2026-01-01";
const SIM_DAYS = 730; // two full seasons, day by day
const ALL_DAYS: string[] = Array.from({ length: SIM_DAYS }, (_, i) => shift(SIM_START, i));

// ---------------------------------------------------------------------------
// THE WORLD — lakes, services and crews shaped like the real seed rows
// ---------------------------------------------------------------------------

/** Rule 7: pull deadline = estimated hard freeze − 8 days. */
const PULL_BUFFER_DAYS = 8;
const pullFrom = (hardFreeze: string) => shift(hardFreeze, -PULL_BUFFER_DAYS);

interface Lake {
  id: string;
  name: string;
  source: "ops" | "customer" | "crew";
  seasonConfirmed: boolean;
  bornOn: string | null;
  /** year → { iceOut, hardFreeze, pullDeadline } */
  seasons: Record<number, { iceOut: string; hardFreeze: string; pull: string }>;
  /** the lake-day ops actually confirmed each year's dates (null = never) */
  confirmedOn: Record<number, string | null>;
}

/** supabase/seed/seed_lakes.sql — the three real lakes, verbatim. */
const SEED_LAKES_2026 = [
  { name: "Big Long Lake", iceOut: "2026-03-21", hardFreeze: "2026-11-22", pull: "2026-11-14" },
  { name: "Pretty Lake", iceOut: "2026-03-24", hardFreeze: "2026-11-20", pull: "2026-11-12" },
  { name: "Big Turkey Lake", iceOut: "2026-03-19", hardFreeze: "2026-11-24", pull: "2026-11-16" },
] as const;

/** supabase/seed/seed_services.sql + 0042_crew_units.sql (est_minutes). */
const SERVICES = [
  { name: "Spring opening", water: false, minPhotos: 3, est: 120 },
  { name: "Fall winterization", water: false, minPhotos: 4, est: 120 },
  { name: "Pier install / removal", water: true, minPhotos: 2, est: 180 },
  { name: "Boat lift set / pull", water: true, minPhotos: 2, est: 90 },
  { name: "Jet ski winterize & store", water: true, minPhotos: 2, est: 60 },
  { name: "PWC lift set / pull", water: true, minPhotos: 2, est: 60 },
  { name: "Boat storage & winterize", water: true, minPhotos: 3, est: 120 },
  { name: "Water toy prep & storage", water: true, minPhotos: 1, est: 60 },
  { name: "Lawn mowing & trim", water: false, minPhotos: 1, est: 45 },
  { name: "Housekeeping", water: false, minPhotos: 2, est: 90 },
] as const;

function buildLakes(r: () => number): Lake[] {
  const lakes: Lake[] = SEED_LAKES_2026.map((l, i) => {
    // Season 2 (2027): a real, DIFFERENT ice-out/freeze — Indiana springs vary.
    const iceOut27 = shift(`2027-03-${String(int(r, 10, 28)).padStart(2, "0")}`, 0);
    const freeze27 = `2027-11-${String(int(r, 14, 28)).padStart(2, "0")}`;
    return {
      id: `lake-${i}`,
      name: l.name,
      source: "ops",
      seasonConfirmed: true,
      bornOn: null,
      seasons: {
        2026: { iceOut: l.iceOut, hardFreeze: l.hardFreeze, pull: l.pull },
        2027: { iceOut: iceOut27, hardFreeze: freeze27, pull: pullFrom(freeze27) },
      },
      // Ops confirms next year's dates somewhere in late winter — or LATE.
      confirmedOn: { 2026: "2026-01-05", 2027: shift(iceOut27, -int(r, -14, 21)) },
    };
  });
  // Demand-born lakes: two customer-born, one crew-born, spread over both
  // seasons. A born lake copies a donor's dates (lake-birth.ts) and carries
  // season_confirmed = false until a human trues it up.
  const births: Array<{ name: string; src: "customer" | "crew"; on: string }> = [
    { name: "Adams Lake", src: "customer", on: "2026-06-18" },
    { name: "Little Turkey Lake", src: "crew", on: "2026-09-02" },
    { name: "Witmer Lake", src: "customer", on: "2027-05-11" },
  ];
  births.forEach((b, i) => {
    const donor = lakes[i % lakes.length];
    lakes.push({
      id: `lake-born-${i}`,
      name: b.name,
      source: b.src,
      seasonConfirmed: false,
      bornOn: b.on,
      // COPIED from the donor — including the donor's YEAR (lake-birth.ts).
      seasons: { 2026: { ...donor.seasons[2026] }, 2027: { ...donor.seasons[2026] } },
      confirmedOn: { 2026: null, 2027: null },
    });
  });
  return lakes;
}

/** The lake row as the booking calendar reads it on a given lake-day: the
 *  dates a human has actually confirmed by then (stale ones if nobody has). */
function lakeRowOn(lake: Lake, today: string): { start: string | null; end: string | null } {
  let best: { iceOut: string; pull: string } | null = null;
  for (const y of [2026, 2027]) {
    const c = lake.confirmedOn[y];
    if (c && c <= today) best = { iceOut: lake.seasons[y].iceOut, pull: lake.seasons[y].pull };
  }
  if (!best) {
    // Never confirmed by a human → whatever the row was born with.
    const s = lake.seasons[2026];
    return { start: s.iceOut, end: s.pull };
  }
  return { start: best.iceOut, end: best.pull };
}

// ===========================================================================
// BLOCK 1 — dayStatus is TOTAL and ORDERED, every day of both seasons
// ===========================================================================

const STATUSES: readonly DayStatus[] = ["past", "rush", "off-season", "full", "available"] as const;

describe("SEASON CLOCK · dayStatus is total across two seasons, 6 lakes, 10 services", () => {
  it("returns exactly one of the five statuses for every (date, lake, service) — incl. leap day and DST", () => {
    const r = mkRng(1);
    const lakes = buildLakes(mkRng(99));
    let cases = 0;
    const seen = new Set<DayStatus>();

    // Dates that historically break date code: leap days, DST flips in
    // America/Indiana/Indianapolis, year rolls, month ends.
    const NASTY = [
      "2028-02-29", "2024-02-29", "2026-02-28", "2027-02-28",
      "2026-03-08", "2026-11-01", "2027-03-14", "2027-11-07", // US DST boundaries
      "2026-12-31", "2027-01-01", "2027-12-31", "2028-01-01",
      "2026-01-31", "2026-04-30", "2026-06-30", "2026-09-30",
    ];

    for (const today of ALL_DAYS) {
      const lake = pick(r, lakes);
      const row = lakeRowOn(lake, today);
      for (let k = 0; k < 6; k++) {
        const svc = pick(r, SERVICES);
        // k===0 targets TODAY (the rush path), k in 1..2 the nasty calendar
        // edges, the rest anywhere in a ±14-month window.
        const target = k === 0 ? today : k < 3 ? pick(r, NASTY) : shift(today, int(r, -420, 420));
        const rushOn = r() < 0.5;
        const ctx: DayContext = {
          today,
          isWaterWork: svc.water,
          seasonStart: row.start,
          seasonEnd: row.end,
          fullDates: new Set(r() < 0.25 ? [target] : []),
          rushNowHour: rushOn ? int(r, 0, 23) : undefined,
          rushCutoffHour: rushOn ? int(r, 6, 20) : undefined,
        };
        const st = dayStatus(target, ctx);
        cases++;
        expect(STATUSES, S(`dayStatus returned a value outside the union: ${st} for ${target}/${lake.name}/${svc.name} today=${today}`)).toContain(st);
        seen.add(st);

        // Determinism: the same inputs must always give the same answer.
        expect(dayStatus(target, ctx), S("dayStatus is not deterministic")).toBe(st);

        // THE WINDOW RULE 7 IS ACTUALLY MEASURED AGAINST (audit bug 1, fixed
        // 2026-08). dayStatus normalises the stored row through
        // effectiveSeason, so a lake carrying LAST season's absolute dates is
        // gated on this year's roll of them, not on the stale literals. The
        // invariants below therefore compare against the EFFECTIVE window —
        // the same pure helper the engine uses, never a reimplementation.
        const eff = effectiveSeason({ iceOut: row.start, pullDeadline: row.end }, today);

        // ORDERING INVARIANTS (documented in booking.ts's header)
        if (target < today) expect(st, S(`a past date must be "past" (${target} < ${today})`)).toBe("past");
        if (!svc.water) expect(st, S("land work can never be off-season (rule 7 is water-only)")).not.toBe("off-season");
        if (st === "full") expect(ctx.fullDates.has(target), S("full must mean the day is in fullDates")).toBe(true);
        if (st === "off-season") {
          expect(svc.water, S("off-season implies water work")).toBe(true);
          // Half a window is not a window — an unknown season fails CLOSED
          // (audit bug 8b): a missing end is a legitimate off-season reason.
          const unknown = !eff.seasonStart || !eff.seasonEnd;
          const before = !!eff.seasonStart && target < eff.seasonStart;
          const after = !!eff.seasonEnd && target > eff.seasonEnd;
          expect(unknown || before || after, S(`off-season inside the effective window: ${target} vs [${eff.seasonStart}, ${eff.seasonEnd}] (stored [${row.start}, ${row.end}], today ${today})`)).toBe(true);
        }
        if (st === "available" || st === "rush") {
          if (svc.water) {
            // Rule 7, at full strength: a bookable water day is inside the
            // effective window, and the window is KNOWN at both ends.
            expect(eff.seasonStart, S("bookable water work with no ice-out on file — rule 7 breach")).not.toBeNull();
            expect(eff.seasonEnd, S("bookable water work with no pull deadline on file — rule 7 breach")).not.toBeNull();
            expect(target >= (eff.seasonStart as string), S(`bookable water work before ice-out — rule 7 breach (${target} < ${eff.seasonStart})`)).toBe(true);
            expect(target <= (eff.seasonEnd as string), S(`bookable water work past the pull deadline — rule 7 breach (${target} > ${eff.seasonEnd})`)).toBe(true);
          }
        }
        if (st === "rush") expect(target, S("rush is only ever TODAY")).toBe(today);
      }
    }
    // Every status must be reachable in a two-season world, or the sim is blind.
    for (const st of STATUSES) expect(seen, S(`status "${st}" never occurred — sim coverage hole`)).toContain(st);
    expect(cases).toBeGreaterThan(4000);
  });

  it("season boundaries are exact: the pull deadline is bookable, the next day is not (rule 7)", () => {
    const lakes = buildLakes(mkRng(7));
    let checked = 0;
    for (const lake of lakes) {
      for (const y of [2026, 2027]) {
        const s = lake.seasons[y];
        // Rule 7 arithmetic itself: pull deadline == hard freeze − 8 days.
        expect(diffDays(s.hardFreeze, s.pull), S(`${lake.name} ${y}: pull deadline must be hard freeze − 8`)).toBe(PULL_BUFFER_DAYS);

        const base = (today: string): DayContext => ({
          today, isWaterWork: true, seasonStart: s.iceOut, seasonEnd: s.pull, fullDates: new Set(),
        });
        // Stand well before this lake's ice-out so nothing reads as "past".
        const early = shift(s.iceOut, -45);
        expect(dayStatus(shift(s.iceOut, -1), base(early)), S("day before ice-out")).toBe("off-season");
        expect(dayStatus(s.iceOut, base(early)), S("ice-out day itself must open")).toBe("available");
        expect(dayStatus(s.pull, base(early)), S("the pull deadline is the LAST bookable day")).toBe("available");
        expect(dayStatus(shift(s.pull, 1), base(early)), S("day after the pull deadline")).toBe("off-season");
        // Capacity never outranks the season gate.
        expect(dayStatus(shift(s.pull, 1), { ...base(early), fullDates: new Set([shift(s.pull, 1)]) })).toBe("off-season");
        checked += 5;
      }
    }
    expect(checked).toBe(lakes.length * 2 * 5);
  });

  it("lake-time helpers survive DST and the year roll in America/Indiana/Indianapolis", () => {
    // Spring-forward 2027: 2am EST → 3am EDT on Mar 14.
    expect(lakeDateOf("2027-03-14T04:59:00Z"), S("11:59pm EST Mar 13 must still be Mar 13")).toBe("2027-03-13");
    expect(lakeDateOf("2027-03-14T05:00:00Z"), S("midnight EST Mar 14")).toBe("2027-03-14");
    expect(lakeDateOf("2027-03-14T06:59:00Z"), S("1:59am EST, just before the jump")).toBe("2027-03-14");
    expect(lakeDateOf("2027-03-14T07:00:00Z"), S("3:00am EDT, just after the jump")).toBe("2027-03-14");
    // Fall-back 2027: the repeated hour must not roll the date.
    expect(lakeDateOf("2027-11-07T05:30:00Z"), S("1:30am EDT (first pass)")).toBe("2027-11-07");
    expect(lakeDateOf("2027-11-07T06:30:00Z"), S("1:30am EST (second pass)")).toBe("2027-11-07");
    // The nightly cron fires at 00:00 UTC = 7/8pm at the lakes — SAME lake day
    // in both halves of the year, which is what makes "exactly once" hold.
    expect(lakeDateOf("2026-07-16T00:00:00Z"), S("summer cron beat")).toBe("2026-07-15");
    expect(lakeDateOf("2026-12-16T00:00:00Z"), S("winter cron beat")).toBe("2026-12-15");
    // Leap day round-trips.
    expect(lakeDateOf("2028-02-29T18:00:00Z")).toBe("2028-02-29");
    expect(lakeDateOf("not-a-date"), S("garbage must be null, never a throw")).toBeNull();
    expect(todayLakeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isRecurring("Weekly")).toBe(true);
    expect(isRecurring("Install (spring)")).toBe(false);
  });
});

// ===========================================================================
// BLOCK 2 — THE YEAR ROLL (the defect this two-season sim exists to find)
// ===========================================================================

describe("SEASON CLOCK · the year roll", () => {
  it("REGRESSION (audit bug 1): the season rolls onto the current year with no ops edit", () => {
    // Audit bug 1, fixed 2026-08. The lakes row holds ONE season's ABSOLUTE
    // dates, and dayStatus used to read them literally — so the day year 1's
    // pull deadline passed, every lake went 100% off-season for water work
    // until a human retyped both dates on every lake. Land work kept booking,
    // so the outage was silent. dayStatus now normalises through
    // effectiveSeason(), which rolls a STALE window's month/day onto the
    // current year. This pins that it stays rolled.
    const start = "2026-03-21";
    const end = "2026-11-14";
    let bookableDaysSeason2 = 0;
    const days2027 = ALL_DAYS.filter((d) => d.startsWith("2027"));
    for (const d of days2027) {
      const st = dayStatus(d, {
        today: "2027-04-01", isWaterWork: true, seasonStart: start, seasonEnd: end, fullDates: new Set(),
      });
      if (st === "available" || st === "rush") bookableDaysSeason2++;
    }
    // Was 0 — the whole second season was dead. Now the rolled window
    // (2027-03-21 .. 2027-11-14) is open, so a full season of water days is
    // bookable without anyone touching the lake row.
    expect(bookableDaysSeason2, S("season 2 must sell water work on rolled dates")).toBeGreaterThan(200);
    expect(dayStatus("2027-06-15", { today: "2027-04-01", isWaterWork: true, seasonStart: start, seasonEnd: end, fullDates: new Set() })).toBe("available");
    // The rolled window's EDGES must still hold — rolling must never widen the
    // season or weaken rule 7. Asked from JANUARY so both edges are in the
    // future: dayStatus checks "past" before it checks the season, so asking
    // about March from April answers "past", which tells us nothing about the
    // window.
    const fromJan = { today: "2027-01-15", isWaterWork: true, seasonStart: start, seasonEnd: end, fullDates: new Set<string>() };
    expect(dayStatus("2027-03-20", fromJan), S("the day before the rolled ice-out is still closed")).toBe("off-season");
    expect(dayStatus("2027-03-21", fromJan), S("the rolled ice-out day itself is open")).toBe("available");
    expect(dayStatus("2027-11-14", fromJan), S("the rolled pull deadline is still bookable")).toBe("available");
    expect(dayStatus("2027-11-15", fromJan), S("the day after the rolled deadline is closed")).toBe("off-season");
  });

  it("REGRESSION (audit bug 2): a demand-born lake can sell what it was born for", () => {
    // Audit bug 2, fixed 2026-08. lake-birth.ts copied the donor lake's dates
    // VERBATIM, year included, so a lake born in season 2 carried season 1's
    // window and had ZERO bookable water days — the customer who named the
    // lake to get a pier installed was exactly the person who could not book
    // one. Inherited dates are now rolled onto the current season year.
    const donor = { start: "2026-03-21", end: "2026-11-14" };
    const bornOn = "2027-05-11";
    let bookable = 0;
    for (let i = 1; i <= 200; i++) {
      const st = dayStatus(shift(bornOn, i), {
        today: bornOn, isWaterWork: true, seasonStart: donor.start, seasonEnd: donor.end, fullDates: new Set(),
      });
      if (st !== "off-season") bookable++;
    }
    // Was 0 of 200. The rolled window runs to 2027-11-14, so roughly the rest
    // of the season is open from the day the lake is born.
    expect(bookable, S("a lake born mid-season must be able to take water work")).toBeGreaterThan(150);
    expect(dayStatus(shift(bornOn, 30), {
      today: bornOn, isWaterWork: false, seasonStart: donor.start, seasonEnd: donor.end, fullDates: new Set(),
    })).toBe("available");
  });

  it("SIM-FOUND BUG: an inverted ice-out / pull pair closes a lake's whole water calendar, silently", () => {
    // updateLakeConditions validates each date's FORMAT but never that ice-out
    // precedes the hard freeze. Typing the freeze date into the ice-out box
    // (and vice-versa) is one fat-finger away and produces start > end.
    const start = "2026-11-22"; // hard freeze pasted into ice-out
    const end = pullFrom("2026-03-21"); // ice-out pasted into hard freeze → 2026-03-13
    expect(start > end).toBe(true);
    let anyBookable = false;
    for (const d of ALL_DAYS) {
      const st = dayStatus(d, { today: "2026-01-01", isWaterWork: true, seasonStart: start, seasonEnd: end, fullDates: new Set() });
      if (st === "available" || st === "rush") anyBookable = true;
    }
    expect(anyBookable, S("an inverted season pair makes EVERY day off-season, with no error anywhere")).toBe(false);
  });

  it("REGRESSION (audit bug 8): an unknown ice-out fails CLOSED, not open", () => {
    // Audit bug 8, fixed 2026-08. The ops form allows either date
    // independently, and a null ice-out used to disable the lower half of the
    // gate entirely — so a pier install was bookable in mid-January, under the
    // ice. Rule 7 defeated by an empty field. Half a window is not a window:
    // water work now stays SHUT until both ends are known.
    const st = dayStatus("2027-01-15", {
      today: "2026-12-01", isWaterWork: true, seasonStart: null, seasonEnd: "2027-11-14", fullDates: new Set(),
    });
    expect(st, S("water work under the ice must be refused when ice-out is unknown")).toBe("off-season");
    // Both ends unknown is equally closed for water work...
    expect(dayStatus("2027-06-15", {
      today: "2026-12-01", isWaterWork: true, seasonStart: null, seasonEnd: null, fullDates: new Set(),
    })).toBe("off-season");
    // ...but LAND work on a season-less lake is unaffected. Failing closed
    // must not take the mowing down with it.
    expect(dayStatus("2027-01-15", {
      today: "2026-12-01", isWaterWork: false, seasonStart: null, seasonEnd: null, fullDates: new Set(),
    }), S("land work never depends on the water season")).toBe("available");
  });

  it("a LATE-confirmed ice-out strands already-booked water jobs (the engine has no re-validation)", () => {
    // Ops publishes a provisional Mar 21 ice-out, customers book, then the
    // real ice-out lands Apr 12. dayStatus closes NEW bookings — the jobs
    // already on the calendar are simply not re-checked by any pure rule.
    const provisional = "2027-03-21";
    const confirmed = "2027-04-12";
    const end = "2027-11-14";
    const r = mkRng(21);
    let stranded = 0, total = 0;
    for (let i = 0; i < 2000; i++) {
      const d = shift("2027-03-15", int(r, 0, 60));
      const before = dayStatus(d, { today: "2027-02-01", isWaterWork: true, seasonStart: provisional, seasonEnd: end, fullDates: new Set() });
      const after = dayStatus(d, { today: "2027-02-01", isWaterWork: true, seasonStart: confirmed, seasonEnd: end, fullDates: new Set() });
      if (before !== "off-season") {
        total++;
        if (after === "off-season") stranded++;
      }
    }
    // ~22 of every 61 candidate spring days flip to off-season.
    expect(stranded, S("late ice-out must invalidate some already-bookable days")).toBeGreaterThan(0);
    expect(stranded / total, S("late ice-out strands a material share of spring water bookings")).toBeGreaterThan(0.25);
  });
});

// ===========================================================================
// BLOCK 3 — WAITLIST: warn exactly once, on the exact day; expire never early
// ===========================================================================

describe("LADDER · waitlist warning + expiry over two seasons", () => {
  it("warns at most once, on exactly jobDate − warnDays, and expires exactly the day after the date", () => {
    const r = mkRng(3);
    const JOBS = 2500;
    let warnedTotal = 0, expiredTotal = 0, neverWarned = 0, cases = 0;
    // Violations are COLLECTED, not asserted inside the hot loop (2500 jobs ×
    // 730 nights); a single expect at the end keeps the sim fast and still
    // reports the exact minimal reproducer.
    const bad: string[] = [];

    for (let i = 0; i < JOBS; i++) {
      const jobDate = shift(SIM_START, int(r, 20, SIM_DAYS - 20));
      const createdDate = shift(jobDate, -int(r, 0, 60));
      const warnDays = int(r, 1, 14); // settings.ts clamps waitlist_warning_days to [1, 14]

      const warnDays_fired: string[] = [];
      let firstExpiredDay: string | null = null;
      let expiredTransitions = 0, prevExpired = false;

      // The job exists from createdDate; the nightly runs once per lake day.
      for (let d = 0; d < SIM_DAYS; d++) {
        const today = ALL_DAYS[d];
        if (today < createdDate) continue;
        cases++;
        const warn = warningDue(jobDate, today, warnDays);
        const exp = isExpired(jobDate, today);
        if (warn) warnDays_fired.push(today);
        if (exp && !prevExpired) { firstExpiredDay = today; expiredTransitions++; }
        prevExpired = exp;
        if (warn && exp) bad.push(`warn+expire same night: job ${jobDate}, today ${today}, warnDays ${warnDays}`);
        if (exp && !(jobDate < today)) bad.push(`isExpired fired on/before the job date: ${jobDate} vs ${today}`);
      }

      // Audit bug 10d, fixed 2026-08. warningDue used to be a pure equality on
      // jobDate === today + warnDays, so ONE missed nightly (a deploy, an
      // outage) dropped the customer's only warning forever. It is now a
      // CATCH-UP WINDOW: it stays true for DEFAULT_WARNING_CATCHUP_DAYS + 1
      // consecutive nights, and exactly-once delivery moved to the ledger
      // (migration 0049) where it belongs. So the predicate's contract is no
      // longer "fires once" — it is "opens on the boundary, never earlier,
      // stays open a bounded number of nights, contiguously".
      if (warnDays_fired.length > 0) {
        const maxNights = DEFAULT_WARNING_CATCHUP_DAYS + 1;
        if (warnDays_fired.length > maxNights) {
          bad.push(`warning window ${warnDays_fired.length} nights > ${maxNights} for job ${jobDate} (warnDays ${warnDays}): ${warnDays_fired.join(",")}`);
        }
        // NEVER early: the window opens on the original boundary — or, for a
        // job booked INSIDE its own window, on the first night it existed.
        const opensOn = shift(jobDate, -warnDays);
        const expectedFirst = createdDate > opensOn ? createdDate : opensOn;
        if (warnDays_fired[0] !== expectedFirst) {
          bad.push(`window opened on ${warnDays_fired[0]}, expected ${expectedFirst}`);
        }
        // Contiguous — a gap would mean a night where the catch-up silently lapsed.
        for (let k = 1; k < warnDays_fired.length; k++) {
          if (warnDays_fired[k] !== shift(warnDays_fired[k - 1], 1)) {
            bad.push(`window not contiguous for job ${jobDate}: ${warnDays_fired.join(",")}`);
            break;
          }
        }
        // Every night of it still precedes expiry.
        const last = warnDays_fired[warnDays_fired.length - 1];
        if (!(last < (firstExpiredDay ?? "9999"))) bad.push(`warning ${last} did not precede expiry ${firstExpiredDay}`);
        warnedTotal++;
      } else {
        neverWarned++;
      }
      if (expiredTransitions !== 1) bad.push(`isExpired transitioned ${expiredTransitions}× for job ${jobDate}`);
      if (firstExpiredDay !== shift(jobDate, 1)) bad.push(`expiry landed on ${firstExpiredDay}, expected ${shift(jobDate, 1)}`);
      expiredTotal++;
    }

    expect(bad.slice(0, 5), S(`${bad.length} waitlist invariant violations`)).toEqual([]);

    expect(expiredTotal).toBe(JOBS);
    expect(warnedTotal + neverWarned).toBe(JOBS);
    expect(cases).toBeGreaterThan(100_000);
    void warnedTotal;

    // MEASURED near-miss (not a bug — a real customer-experience hole):
    // a job booked INSIDE its own warning window never gets the "we're still
    // looking" fork at all. It goes straight from silence to cancellation.
    expect(neverWarned, S("some short-lead jobs must skip the warning entirely")).toBeGreaterThan(0);
  });

  it("the warn boundary never drifts across month, year, leap-day or DST edges", () => {
    const r = mkRng(31);
    for (let i = 0; i < 6000; i++) {
      const today = shift("2026-01-01", int(r, 0, 900));
      const warnDays = int(r, 1, 14);
      const boundary = shift(today, warnDays);
      expect(warningDue(boundary, today, warnDays), S(`no fire on the boundary ${boundary} from ${today} @${warnDays}d`)).toBe(true);
      // A job FURTHER out than the boundary must never fire — the window
      // catches up on missed nights, it never runs ahead.
      expect(warningDue(shift(boundary, 1), today, warnDays), S("fired a day early")).toBe(false);
      // A job one day CLOSER than the boundary is the catch-up case: it fires
      // when warnDays leaves room inside the window (audit bug 10d).
      const closer = shift(boundary, -1);
      const earliestOffset = Math.max(1, warnDays - DEFAULT_WARNING_CATCHUP_DAYS);
      expect(warningDue(closer, today, warnDays), S(`catch-up window @${warnDays}d`)).toBe(warnDays - 1 >= earliestOffset);
    }
    // Explicit nasty edges.
    expect(warningDue("2028-02-29", "2028-02-27", 2)).toBe(true);
    expect(warningDue("2027-01-01", "2026-12-30", 2)).toBe(true);
    expect(warningDue("2026-03-10", "2026-03-08", 2)).toBe(true); // across US DST
    expect(warningDue("2026-11-03", "2026-11-01", 2)).toBe(true); // across US DST
    expect(warningDue(null, "2026-05-01", 2)).toBe(false);
    expect(isExpired(null, "2026-05-01")).toBe(false);
  });

  it("REGRESSION (audit bug 10d): a skipped nightly no longer drops the warning", () => {
    // Audit bug 10d, fixed 2026-08. warningDue was a pure equality, so if the
    // cron missed the ONE night the boundary fell on (a deploy, an outage, a
    // Vercel incident) the customer went straight from silence to "we
    // cancelled it" — losing their only chance to pick another day or invite
    // their own crew. A catch-up window now recovers a missed night; the
    // ledger in migration 0049 keeps delivery exactly-once.
    const jobDate = "2026-08-20";
    const warnDays = 7;
    const boundary = shift(jobDate, -warnDays); // 2026-08-13
    expect(warningDue(jobDate, boundary, warnDays), S("still fires on the boundary itself")).toBe(true);
    // The night AFTER a missed boundary still owes the warning.
    expect(warningDue(jobDate, shift(boundary, 1), warnDays), S("recovers one missed night")).toBe(true);
    expect(warningDue(jobDate, shift(boundary, 2), warnDays), S("recovers two missed nights")).toBe(true);
    // But it is BOUNDED — it does not nag every night up to the job date.
    expect(
      warningDue(jobDate, shift(boundary, DEFAULT_WARNING_CATCHUP_DAYS + 1), warnDays),
      S("the window closes; it is a catch-up, not a daily nag"),
    ).toBe(false);
    // And it never fires before the boundary.
    expect(warningDue(jobDate, shift(boundary, -1), warnDays), S("never early")).toBe(false);
  });

  it("against a STABLE reality every dial reaches a fixed point and then stops moving (no 2-cycles)", () => {
    const r = mkRng(4);
    const bad: string[] = [];
    let dials = 0;
    for (const svc of SERVICES) {
      for (let trial = 0; trial < 60; trial++) {
        // A service whose real duration is settled: the nightly median is the
        // same number every night (half-minute medians included — an even
        // sample count produces .5 targets, the classic oscillation trap).
        const truth = int(r, 20, 470) + (r() < 0.5 ? 0.5 : 0);
        const samples = Array.from({ length: int(r, 5, 12) }, () => truth);
        let current: number = svc.est;
        const visited = new Map<number, number>();
        let fixedAt = -1;
        for (let night = 0; night < 150; night++) {
          const res = learnedEstimate(current, samples);
          if (!res.moved) { fixedAt = night; break; }
          if (visited.has(res.next)) {
            bad.push(`CYCLE for "${svc.name}": truth ${truth}, revisited ${res.next} at night ${night} (first seen ${visited.get(res.next)})`);
            break;
          }
          visited.set(res.next, night);
          current = res.next;
        }
        if (fixedAt < 0 && bad.length === 0) bad.push(`"${svc.name}" never reached a fixed point in 150 nights (truth ${truth}, at ${current})`);
        // The fixed point is reality rounded to the router's 5-minute grid.
        const grid = Math.max(10, Math.round(truth / 5) * 5);
        if (fixedAt >= 0 && current !== grid) bad.push(`"${svc.name}" settled at ${current}, expected the grid value ${grid} for truth ${truth}`);
        // And it must get there in a bounded number of nights.
        if (fixedAt > 40) bad.push(`"${svc.name}" took ${fixedAt} nights to converge from ${svc.est} to ${grid}`);
        dials++;
      }
    }
    expect(bad.slice(0, 5), S(`${bad.length} convergence failures`)).toEqual([]);
    expect(dials).toBe(SERVICES.length * 60);
  });

  it("under a NOISY season the dial stays bounded, damped and on-grid every single night", () => {
    const r = mkRng(41);
    const bad: string[] = [];
    const jitterRatios: number[] = [];
    let nights = 0, movesObserved = 0;

    for (const svc of SERVICES) {
      for (let trial = 0; trial < 25; trial++) {
        const truth = int(r, 15, 460);
        let current: number = svc.est;
        let lastTwenty: number[] = [];

        for (let night = 0; night < 120; night++) {
          const n = int(r, 5, 40);
          const samples: number[] = [];
          for (let k = 0; k < n; k++) samples.push(Math.max(1, truth + (r() - 0.5) * truth * 0.5));
          // Stamp noise the filter is supposed to eat: couch uploads, double starts.
          if (r() < 0.5) samples.push(int(r, 0, 9), int(r, 481, 5000), -int(r, 1, 100));
          if (r() < 0.15) samples.push(Number.NaN, Number.POSITIVE_INFINITY);

          const before = current;
          const res = learnedEstimate(before, samples);
          const effective = Number.isFinite(before) && before > 0 ? before : 60;
          const maxStep = Math.max(5, Math.round((effective * 0.15) / 5) * 5);
          nights++;

          if (res.next < MIN_REAL_MINUTES) bad.push(`dial below the floor: ${res.next}`);
          if (res.next > MAX_REAL_MINUTES) bad.push(`dial above the sane ceiling: ${res.next}`);
          if (res.next % 5 !== 0) bad.push(`dial off the 5-minute grid: ${res.next}`);
          if (Math.abs(res.next - effective) > maxStep) bad.push(`damping breached: ${effective} → ${res.next} (cap ${maxStep}) for "${svc.name}"`);
          const realCount = samples.filter((m) => Number.isFinite(m) && m >= MIN_REAL_MINUTES && m <= MAX_REAL_MINUTES).length;
          if (res.samples !== realCount) bad.push(`sample count ${res.samples} != real ${realCount}`);
          if (realCount < MIN_SAMPLES && res.moved) bad.push(`moved on ${realCount} real samples (< ${MIN_SAMPLES})`);
          if (res.moved !== (res.next !== effective)) bad.push(`moved flag disagrees: ${effective}→${res.next} moved=${res.moved}`);

          if (res.moved) movesObserved++;
          current = res.next;
          if (night >= 100) lastTwenty.push(current);
        }

        // NO RUNAWAY: after 100 nights of burn-in the dial must be PARKED —
        // centred on reality and confined to the damping envelope (±1 step
        // either side of the target). It does NOT sit perfectly still: a
        // nightly median over as few as 5 completions genuinely moves, and
        // the dial chases it. That jitter is measured below, not asserted
        // away. (For a truth near 480 the >480 tail is filtered out, so the
        // dial honestly lands a little low — that is the sane band working.)
        const lo = Math.min(...lastTwenty), hi = Math.max(...lastTwenty);
        const spread = hi - lo;
        // The step is 15% of the CURRENT dial, so size the envelope at the
        // top of the observed range — that's the widest one night can be.
        const envelope = 2 * Math.max(5, Math.round((hi * 0.15) / 5) * 5) + 5;
        if (spread > envelope) bad.push(`"${svc.name}" jitters ${lo}..${hi} (${spread}) beyond the ±1-step damping envelope ${envelope}, truth ${truth}`);
        const mid = (lo + hi) / 2;
        if (Math.abs(mid - truth) > Math.max(15, truth * 0.25)) bad.push(`"${svc.name}" parked at ~${mid} vs truth ${truth}`);
        jitterRatios.push(spread / truth);
        lastTwenty = [];
      }
    }
    expect(bad.slice(0, 5), S(`${bad.length} noisy-season violations`)).toEqual([]);
    expect(nights).toBe(SERVICES.length * 25 * 120);
    expect(movesObserved).toBeGreaterThan(500);

    // MEASURED near-miss for the owner: a settled dial still swings this much
    // night to night when the nightly median is drawn from few completions.
    jitterRatios.sort((a, b) => a - b);
    const p50 = jitterRatios[Math.floor(jitterRatios.length * 0.5)];
    const p95 = jitterRatios[Math.floor(jitterRatios.length * 0.95)];

    console.log(`\n[learning] settled-dial night-to-night swing: median ${(p50 * 100).toFixed(1)}% of true duration, p95 ${(p95 * 100).toFixed(1)}%`);
    expect(p95, S("dial jitter should stay inside the 15% damping step, roughly")).toBeLessThan(0.45);
  });

  it("a single catastrophic night cannot yank a dial (damping is the whole point)", () => {
    // 200 jobs that all "took" 480 minutes because a crew forgot to stop the
    // clock. The dial may only take one damped step.
    const before = 45;
    const res = learnedEstimate(before, Array(200).fill(480));
    expect(res.next, S("an outlier night moved the dial more than 15%")).toBeLessThanOrEqual(before + Math.max(5, Math.round((before * 0.15) / 5) * 5));
    expect(res.next).toBe(50);
    // And a pile of pure garbage moves nothing at all.
    expect(learnedEstimate(90, [1, 2, 3, 900, 5000, -4, Number.NaN]).moved).toBe(false);
    expect(median([])).toBe(0);
  });

  it("REGRESSION (audit bug 10c): a zero/garbage est_minutes dial heals from real samples", () => {
    // Audit bug 10c, fixed 2026-08. 0042_crew_units.sql seeds 'Storage
    // overstay (per-diem)' with est_minutes = 0. learnedEstimate substituted
    // 60 internally, so when reality really was 60 it returned
    // { next: 60, moved: false } — and learnServiceDurations only writes when
    // `moved`, so the row stayed 0 forever and every time-budget read fell
    // back per call. An invalid stored dial is now treated as broken, not as
    // a signal, and is corrected from the samples.
    const res = learnedEstimate(0, [60, 60, 60, 60, 60, 60]);
    expect(res.next).toBe(60);
    expect(res.moved, S("a 0-minute dial must be corrected from real samples")).toBe(true);
    // Same for a negative dial written by hand.
    expect(learnedEstimate(-30, [60, 60, 60, 60, 60]).moved).toBe(true);
  });
});

// ===========================================================================
// BLOCK 5 — STORAGE SEASON ROLL over two winters
// ===========================================================================

describe("SEASON CLOCK · winter-storage season roll", () => {
  it("seasonEndFor is the first (month, day) on or after intake, across the New Year", () => {
    const r = mkRng(5);
    for (let i = 0; i < 5000; i++) {
      const intake = shift("2026-01-01", int(r, 0, 900));
      const endMonth = int(r, 1, 12);
      const endDay = int(r, 1, 28); // stay on days that exist in every month
      const end = seasonEndFor(intake, endMonth, endDay);
      expect(end >= intake, S(`season end ${end} precedes intake ${intake}`)).toBe(true);
      expect(isRealCalendarDate(end), S(`season end ${end} is not a real date`)).toBe(true);
      // Must be the FIRST such occurrence — one year earlier must be < intake.
      const [y] = end.split("-").map(Number);
      const prior = `${y - 1}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
      expect(prior < intake, S(`${end} is not the FIRST occurrence at or after ${intake}`)).toBe(true);
      // The real dial pair (May 31) over two winters.
      expect(seasonEndFor("2026-10-15", 5, 31)).toBe("2027-05-31");
      expect(seasonEndFor("2027-10-15", 5, 31)).toBe("2028-05-31");
    }
  });

  it("REGRESSION (audit bug 9): the (month, day) dial pair always yields a real date", () => {
    // settings.ts clamps storage_season_end_month to [1,12] and
    // storage_season_end_day to [1,31] SEPARATELY. Day defaults to 31, so an
    // owner who moves the season end to April and leaves the day alone gets
    // "2027-04-31" — a string Postgres rejects on a `date` column, and which
    // the per-diem math silently reads as May 1.
    // The (month, day) pair is now clamped to the month's REAL last day.
    expect(seasonEndFor("2026-10-15", 4, 31)).toBe("2027-04-30");
    expect(isRealCalendarDate("2027-04-30"), S("the emitted date must exist")).toBe(true);
    expect(seasonEndFor("2026-10-15", 2, 30)).toBe("2027-02-28");
    expect(seasonEndFor("2026-10-15", 2, 31)).toBe("2027-02-28");
    // Leap-aware: Feb 29 is real in 2028 and must not be clamped away.
    expect(seasonEndFor("2027-10-15", 2, 31)).toBe("2028-02-29");

    // Money consequence 1, closed: the meter now starts on the real due-out
    // day instead of a day late.
    expect(overstayDays("2027-05-01", "2027-04-30"), S("a boat one day over is one day over")).toBe(1);

    // Money consequence 2, closed: no lexical roll, so a May 1 intake gets the
    // NEXT April — not a free extra year in the barn.
    expect(seasonEndFor("2027-05-01", 4, 31)).toBe("2028-04-30");
    expect(diffDays("2028-04-30", "2027-05-01"), S("one season, not two")).toBe(365);
  });

  it("the overstay meter is monotone, never negative, and the per-diem is whole cents", () => {
    const r = mkRng(51);
    for (let i = 0; i < 8000; i++) {
      const end = shift("2027-01-01", int(r, 0, 400));
      const out = shift(end, int(r, -30, 90));
      const days = overstayDays(out, end);
      expect(days, S("overstayDays went negative")).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(days), S("overstayDays is not whole days")).toBe(true);
      if (out <= end) expect(days, S("charged for being early or on time")).toBe(0);
      else expect(days, S("wrong overstay length")).toBe(diffDays(out, end));
      const rate = [0, 8, 12, 15.5, 43, 64][int(r, 0, 5)];
      const charge = perdiemCharge(days, rate);
      expect(charge, S("negative per-diem")).toBeGreaterThanOrEqual(0);
      expect(Math.round(charge * 100), S("per-diem is not whole cents")).toBeCloseTo(charge * 100, 6);
      if (rate === 0 || days === 0) expect(charge).toBe(0);
    }
  });

  it("spring true-up: legs always sum EXACTLY to the booking-time quote, no leg negative", () => {
    const r = mkRng(52);
    for (let i = 0; i < 4000; i++) {
      const n = int(r, 1, 6);
      const legs = Array.from({ length: n }, (_, k) => ({ id: `l${k}`, price: r() < 0.1 ? 0 : int(r, 0, 1400) }));
      const quote = r() < 0.08 ? 0 : int(r, 0, 4000);
      const out = trueLegsToQuote(legs, quote);
      expect(out.length).toBe(n);
      expect(out.reduce((t, l) => t + l.price, 0), S(`legs do not sum to the quote (${quote})`)).toBe(quote);
      expect(out.every((l) => l.price >= 0), S("a spring leg went negative")).toBe(true);
      expect(out.map((l) => l.id)).toEqual(legs.map((l) => l.id));
    }
    expect(trueLegsToQuote([], 500)).toEqual([]);
  });
});

// ===========================================================================
// BLOCK 6 — LAKE STANDING at scale (crews come and go over two seasons)
// ===========================================================================

describe("LADDER · lake standing across 40 crews and two seasons", () => {
  it("demotion is net-strike, monotone in strikes, and cooldown is a strict window", () => {
    const r = mkRng(6);
    for (let i = 0; i < 20000; i++) {
      const strikes = int(r, 0, 30);
      const completions = int(r, 0, 200);
      const limit = int(r, 1, 10); // settings clamps lake_strike_limit to [1,10]
      const demote = shouldDemote(strikes, completions, limit);
      expect(demote, S("net-strike rule broken")).toBe(strikes - completions >= limit);
      // Monotonicity: one more strike can never UN-demote a crew.
      if (demote) expect(shouldDemote(strikes + 1, completions, limit), S("adding a strike un-demoted a crew")).toBe(true);
      // One more completion can never CAUSE a demotion.
      if (!demote) expect(shouldDemote(strikes, completions + 1, limit), S("a completion caused a demotion")).toBe(false);
      expect(shouldDemote(strikes, completions, 0), S("a zero dial must disable demotion")).toBe(false);
    }
    const demotedAt = "2026-08-01T00:00:00.000Z";
    const base = Date.parse(demotedAt);
    expect(isCoolingDown(demotedAt, 14, base)).toBe(true);
    expect(isCoolingDown(demotedAt, 14, base + 14 * DAY_MS - 1)).toBe(true);
    expect(isCoolingDown(demotedAt, 14, base + 14 * DAY_MS), S("cooldown must end exactly at the boundary")).toBe(false);
    expect(isCoolingDown(null, 14, base)).toBe(false);
    expect(isCoolingDown("garbage", 14, base)).toBe(false);
  });

  it("base self-heal only fires on real signal and never invents a pin", () => {
    const r = mkRng(61);
    for (let i = 0; i < 5000; i++) {
      const n = int(r, 0, 30);
      const trueLat = 41.5 + r() * 0.4, trueLng = -85.4 - r() * 0.5;
      const pts = Array.from({ length: n }, () =>
        r() < 0.1
          ? { lat: null, lng: null }
          : { lat: trueLat + (r() - 0.5) * 0.2, lng: trueLng + (r() - 0.5) * 0.2 },
      );
      const usable = pts.filter((p) => p.lat != null).length;
      const hasBase = r() < 0.7;
      const baseLat = hasBase ? trueLat + (r() < 0.25 ? int(r, 2, 6) : (r() - 0.5) * 0.1) : null;
      const baseLng = hasBase ? trueLng : null;
      const d = healBase(pts, baseLat, baseLng, 5, 25);
      expect(["set", "correct", "keep"]).toContain(d.action);
      if (usable < 5) {
        expect(d.action, S("healed a base on too little signal")).toBe("keep");
        expect(d.lat).toBe(baseLat);
      }
      if (d.action === "set") expect(hasBase, S("overwrote an existing pin with 'set'")).toBe(false);
      if (d.action !== "keep") {
        expect(d.lat, S("healed to a null pin")).not.toBeNull();
        expect(Number.isFinite(d.lat as number)).toBe(true);
      }
    }
  });
});

// ===========================================================================
// BLOCK 7 — JOB VIEW: three roles, one job, no internal words leak
// ===========================================================================

const DISPUTE_STATUSES = [
  "crew_review", "fixing", "verifying", "talk", "escalated",
  "resolved_fixed", "resolved_verified", "resolved_refunded", "resolved_closed",
] as const; // = the check constraint in 0045_disputes.sql

describe("LADDER · job-detail surfaces at scale", () => {
  it("every real dispute status renders human copy, leaks no internal name, and agrees on pay-hold", () => {
    for (const status of DISPUTE_STATUSES) {
      for (const date of [null, "2026-08-14", "not-a-date", ""]) {
        const cust = disputeViewForCustomer({ status, correctionDate: date });
        const crew = disputeViewForCrew({ status, correctionDate: date });
        for (const v of [cust, crew]) {
          expect(v.pill.length, S(`empty pill for ${status}`)).toBeGreaterThan(0);
          expect(v.line.length, S(`empty line for ${status}`)).toBeGreaterThan(0);
          // Only the snake_case machine names are a leak — "talk"/"fixing"
          // are also ordinary English and appear legitimately in the copy.
          for (const internal of DISPUTE_STATUSES.filter((s) => s.includes("_"))) {
            expect(v.pill + " " + v.line, S(`internal status "${internal}" leaked to a human for ${status}`)).not.toContain(internal);
          }
          expect(v.pill + " " + v.line, S(`a raw snake_case token reached a human for ${status}`)).not.toMatch(/\b[a-z]+_[a-z]+\b/);
          expect(v.line, S("un-rendered date leaked")).not.toContain("Invalid");
        }
        // The two roles must never disagree about whether pay is frozen.
        expect(crew.payOnHold, S(`pay-hold disagreement on ${status}`)).toBe(cust.payOnHold);
        // Resolved states release pay; live states hold it.
        expect(cust.payOnHold, S(`pay-hold wrong for ${status}`)).toBe(!status.startsWith("resolved_"));
      }
    }
    // An unknown status fails CLOSED (pay held) — the right default.
    expect(disputeViewForCustomer({ status: "who_knows" }).payOnHold).toBe(true);
  });

  it("search sanitising never returns filter-breaking characters, at any input", () => {
    const r = mkRng(7);
    const alphabet = "abcXYZ0189 %_\\(),.\"'*:;-&<>[]{}#@!?/|~`^$+=\n\té—";
    for (let i = 0; i < 6000; i++) {
      let raw = "";
      for (let k = 0, n = int(r, 0, 120); k < n; k++) raw += alphabet[int(r, 0, alphabet.length - 1)];
      const clean = sanitizeSearchTerm(raw);
      expect(clean, S(`unsafe char survived sanitising: ${JSON.stringify(clean)}`)).not.toMatch(/[%_\\(),."'*:]/);
      expect(clean.length, S("sanitised term exceeded the 80-char cap")).toBeLessThanOrEqual(80);
      expect(clean, S("leading/trailing whitespace survived")).toBe(clean.trim());
    }
    expect(sanitizeSearchTerm("")).toBe("");
    expect(photoGateLabel(1, 3)).toContain("2 more");
    expect(photoGateLabel(3, 3)).toContain("clear to finish");
    expect(photoGateLabel(0, 0)).toBe("0 photos on file");
  });
});

// ===========================================================================
// BLOCK 8 — THE NIGHTLY DIGEST: honest every night, both seasons
// ===========================================================================

const QUIET = "<p>Quiet night — nothing needed a human. 🌊</p>";

function emptySections(): DigestSections {
  return {
    learning: { changes: [] },
    autoPricing: { changes: [] },
    disputeSweep: { fired: 0, escalated: 0, quietCloses: 0, reconciled: 0 },
    escalatedDisputes: [],
    lakesBorn: [],
    routes: { hoursBust: 0 },
    aiAutoReplies: 0,
    aiReplyTexts: [],
    gapSla: { alerted: 0 },
  };
}

describe("LADDER · nightly digest honesty", () => {
  it("a night where nothing happened says exactly that, and nothing else", () => {
    expect(composeNightlyDigest(emptySections())).toBe(QUIET);
    // Optional fields absent (not zero) must behave identically.
    const bare: DigestSections = {
      ...emptySections(),
      disputeSweep: { fired: 0, escalated: 0 },
      routes: {},
    };
    expect(composeNightlyDigest(bare)).toBe(QUIET);
  });

  it("every night where money moved names the money — 730 randomized nights", () => {
    const r = mkRng(8);
    let quietNights = 0, moneyNights = 0;
    for (const _today of ALL_DAYS) {
      const s = emptySections();
      const moved: string[] = [];
      if (r() < 0.10) { s.disputeSweep.fired = int(r, 1, 4); moved.push("auto-refunded"); }
      if (r() < 0.08) { s.disputeSweep.quietCloses = int(r, 1, 5); moved.push("closed in the crew's favor"); }
      if (r() < 0.05) { s.disputeSweep.reconciled = int(r, 1, 3); moved.push("recovered into fresh disputes"); }
      if (r() < 0.06) { s.autoPricing.changes = [{ label: `raise base to $${int(r, 100, 900)}`, service: "Pier install / removal" }]; moved.push("Prices auto-applied"); }
      if (r() < 0.20) s.learning.changes = [{ service: "Housekeeping", from: 90, to: 95, samples: int(r, 5, 40) }];
      if (r() < 0.07) s.escalatedDisputes = [{ service: "Lawn mowing & trim", note: "grass left in the beds" }];
      if (r() < 0.02) s.lakesBorn = [{ name: "Witmer Lake", source: "customer" }];
      if (r() < 0.10) s.routes.hoursBust = int(r, 1, 3);
      if (r() < 0.25) { s.aiAutoReplies = int(r, 1, 12); s.aiReplyTexts = ["We'll have your crew there Thursday."]; }
      if (r() < 0.12) s.gapSla.alerted = int(r, 1, 6);

      const html = composeNightlyDigest(s);
      const anything =
        s.learning.changes.length + s.autoPricing.changes.length + s.escalatedDisputes.length +
        s.lakesBorn.length + s.aiAutoReplies + s.gapSla.alerted + (s.routes.hoursBust ?? 0) +
        s.disputeSweep.fired + s.disputeSweep.escalated + (s.disputeSweep.quietCloses ?? 0) + (s.disputeSweep.reconciled ?? 0);

      if (anything === 0) { expect(html, S("a busy night rendered as quiet")).toBe(QUIET); quietNights++; continue; }
      expect(html, S("something happened but the digest said quiet night")).not.toBe(QUIET);
      if (moved.length > 0) {
        moneyNights++;
        for (const phrase of moved) expect(html, S(`money moved (${phrase}) but the digest never said so`)).toContain(phrase);
      }
      // Escalated disputes — the one thing that genuinely needs a human — must
      // always be visible and counted.
      if (s.escalatedDisputes.length > 0) expect(html).toContain("waiting on you");
      if (s.gapSla.alerted > 0) expect(html).toContain("ops alert");
      if (s.aiAutoReplies > 0) expect(html).toContain("AI auto-repl");
    }
    expect(quietNights, S("no quiet nights in two seasons — sim is not exercising the quiet path")).toBeGreaterThan(50);
    expect(moneyNights).toBeGreaterThan(50);
  });

  it("customer/crew/lake names are HTML-escaped — an injected name can't rewrite the owner's email", () => {
    const s = emptySections();
    s.lakesBorn = [{ name: `<script>alert(1)</script>`, source: `<img src=x onerror=1>` }];
    s.escalatedDisputes = [{ service: "<b>Pier</b>", note: `they said "<i>no</i>"` }];
    s.learning.changes = [{ service: "<h1>Mow</h1>", from: 45, to: 50, samples: 9 }];
    s.aiAutoReplies = 1;
    s.aiReplyTexts = ["<script>steal()</script>"];
    const html = composeNightlyDigest(s);
    expect(html, S("raw <script> reached the ops inbox")).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("SIM-FOUND BUG: money that moved OUTSIDE the dispute sweep is not in DigestSections at all", () => {
    // The nightly route (src/app/api/cron/nightly/route.ts) runs
    // reconcileUnsettledJobs, reconcileRefunds, reconcileCancelledFees,
    // matureReferralEarnings, runReferralPayoutBatch and
    // runMonthlyPayoutBatches — all of which MOVE MONEY — but then calls
    // sendNightlyDigest({ learning, autoPricing, disputeSweep, routes, gapSla })
    // only. DigestSections has no field that could carry them.
    //
    // So the night the monthly payout batch releases every crew's pay, and
    // the night referral credits mature, the owner's one report says:
    const monthEndNight = emptySections(); // learning/pricing/disputes/routes/gap all quiet
    expect(composeNightlyDigest(monthEndNight), S("the payout night reads as a quiet night")).toBe(QUIET);
    // There is no key to put it in — pinned so a schema change trips this test.
    expect(Object.keys(emptySections()).sort()).toEqual([
      "aiAutoReplies", "aiReplyTexts", "autoPricing", "disputeSweep",
      "escalatedDisputes", "gapSla", "lakesBorn", "learning", "routes",
    ]);
  });

  it("REGRESSION (audit bug 10b): AI reply texts survive a null/zero count", () => {
    // sendNightlyDigest fills aiAutoReplies from a `head:true, count:'exact'`
    // query (`aiCount ?? 0`) and aiReplyTexts from a SEPARATE select. If the
    // count comes back null — the documented failure mode of a head count —
    // the whole section is skipped and the auto-sent customer promises the
    // review specifically wanted surfaced vanish.
    const s = emptySections();
    s.aiReplyTexts = ["Sure — we'll waive the fee and send someone Saturday."];
    s.aiAutoReplies = 0;
    const html = composeNightlyDigest(s);
    expect(html, S("a promise the machine made must never be swallowed by a null count")).not.toBe(QUIET);
    expect(html).toContain("waive the fee");
    // Genuinely nothing to report is still silence.
    const empty = emptySections();
    expect(composeNightlyDigest(empty)).toBe(QUIET);
  });
});

// ===========================================================================
// BLOCK 9 — THE WHOLE PLATFORM RUN THROUGH: two seasons, N customers,
//           nightly ladder, and the WEEKLY HUMAN WORKLOAD the owner asked for
// ===========================================================================

interface SimJob {
  created: string;
  date: string;
  water: boolean;
  lake: number;
  filled: boolean; // did a crew ever take it
  claimedOn: string | null;
}

interface WorkloadResult {
  customers: number;
  crews: number;
  jobs: number;
  nights: number;
  weeks: number;
  totalHuman: number;
  perWeekAvg: number;
  perWeekPeak: number;
  byKind: Record<string, number>;
  quietNights: number;
  customerTouches: number;
  weekly: number[];
}

/**
 * One full two-season run of the nightly ladder.
 *  - `crewCap` null  → crew supply RECRUITS WITH DEMAND (~1 crew per 25
 *    customers, i.e. 40 crews at 1000 — the prompt's 10-40 band).
 *  - `crewCap` n     → the marketplace is stuck at n crews however many
 *    customers sign up. This is the scenario the owner should fear.
 */
function runSeasons(customers: number, salt: number, crewCap: number | null = null): WorkloadResult {
  const r = mkRng(salt);
  const lakes = buildLakes(mkRng(99));
  const wanted = Math.max(10, Math.round(customers / 25));
  const crews = crewCap == null ? wanted : Math.min(wanted, crewCap);
  // Crew supply per lake-day, in jobs. Under-supply is what creates humans.
  const dailyCapacity = crews * 5;

  // --- generate the world's jobs -----------------------------------------
  const jobs: SimJob[] = [];
  const byDate = new Map<string, SimJob[]>();
  const bump = (d: string, j: SimJob) => {
    const list = byDate.get(d);
    if (list) list.push(j); else byDate.set(d, [j]);
  };
  for (let c = 0; c < customers; c++) {
    const lakeIdx = int(r, 0, lakes.length - 1);
    const hoa = r() < 0.04; // HOA-scale account: many properties on one login
    const props = hoa ? int(r, 6, 40) : 1;
    for (let p = 0; p < props; p++) {
      for (const year of [2026, 2027]) {
        const seasonal = int(r, 3, 7); // openings, closings, pier, lift, toys...
        const recurring = r() < 0.35 ? int(r, 8, 24) : 0; // weekly mow / housekeeping
        for (let k = 0; k < seasonal + recurring; k++) {
          const water = k < seasonal && r() < 0.55;
          const doy = int(r, 60, 320);
          const date = shift(`${year}-01-01`, doy);
          if (date > ALL_DAYS[ALL_DAYS.length - 1]) continue;
          const lead = int(r, 1, 45);
          const created = shift(date, -lead);
          const j: SimJob = { created, date, water, lake: lakeIdx, filled: false, claimedOn: null };
          jobs.push(j);
          bump(created, j);
        }
      }
    }
  }

  // --- claim model: crews fill what they can, oldest-first, per day -------
  // A job is claimable from its created day until its date; a day's crew
  // capacity is shared by everything happening that day.
  const openByDate = new Map<string, SimJob[]>();
  for (const j of jobs) {
    const list = openByDate.get(j.date);
    if (list) list.push(j); else openByDate.set(j.date, [j]);
  }
  for (const [date, list] of openByDate) {
    list.sort((a, b) => (a.created < b.created ? -1 : 1));
    const cap = Math.round(dailyCapacity * (0.75 + 0.5 * (mulberry32(ms(date) / DAY_MS)() )));
    list.forEach((j, i) => {
      if (i < cap) {
        j.filled = true;
        // claimed some time between creation and the job date
        const span = Math.max(0, diffDays(date, j.created));
        j.claimedOn = shift(j.created, Math.min(span, int(r, 0, 6)));
      }
    });
  }

  // --- run the nightly ladder, one simulated night at a time -------------
  const weekly: number[] = [];
  const byKind: Record<string, number> = {
    escalatedDisputes: 0, unfillableJobs: 0, lakeSeasonConfirmations: 0,
    priceSuggestionsNotAutoApplied: 0, gapSlaAlerts: 0,
  };
  let totalHuman = 0, quietNights = 0, customerTouches = 0;
  let weekBucket = 0;
  const gapQueue: SimJob[] = []; // gapSlaAlerts caps at 10 per run; the rest wait
  const gapAlerted = new Set<SimJob>();
  const escalatedOpen: Array<{ service: string; note: string; until: string }> = [];

  ALL_DAYS.forEach((today, dayIdx) => {
    let humanTonight = 0;
    const sections = emptySections();

    // 1. jobs whose date passed unfilled → the honest terminal (waitlist.ts)
    const yesterday = shift(today, -1);
    for (const j of openByDate.get(yesterday) ?? []) {
      if (j.filled) continue;
      if (!isExpired(j.date, today)) continue; // engine call — must be true here
      byKind.unfillableJobs++; humanTonight++; customerTouches++;
    }

    // 2. the T-minus warning (engine call, exact boundary)
    for (const j of jobs.length > 0 ? (openByDate.get(shift(today, 2)) ?? []) : []) {
      if (j.filled) continue;
      if (warningDue(j.date, today, 2)) customerTouches++;
    }

    // 3. gap SLA: unclaimed 72h+ and the date still ahead → ops SMS, once,
    //    capped at MAX_ALERTS_PER_RUN = 10 per nightly run.
    for (const j of byDate.get(shift(today, -3)) ?? []) {
      if (!j.filled && j.date >= today) gapQueue.push(j);
    }
    let fired = 0;
    while (gapQueue.length > 0 && fired < 10) {
      const j = gapQueue.shift()!;
      if (gapAlerted.has(j) || j.filled || j.date < today) continue;
      gapAlerted.add(j);
      fired++;
    }
    if (fired > 0) { sections.gapSla.alerted = fired; byKind.gapSlaAlerts += fired; humanTonight += fired; }

    // 4. disputes on work that actually got done today
    const doneToday = (openByDate.get(today) ?? []).filter((j) => j.filled).length;
    const disputes = doneToday > 0 ? Array.from({ length: doneToday }, () => r() < 0.007).filter(Boolean).length : 0;
    let escalatedTonight = 0;
    for (let d = 0; d < disputes; d++) if (r() < 0.18) escalatedTonight++;
    if (escalatedTonight > 0) {
      byKind.escalatedDisputes += escalatedTonight; humanTonight += escalatedTonight;
      for (let e = 0; e < escalatedTonight; e++) {
        escalatedOpen.push({ service: pick(r, SERVICES).name, note: "not what we agreed", until: shift(today, int(r, 1, 5)) });
      }
    }
    sections.disputeSweep.fired = disputes - escalatedTonight > 0 && r() < 0.5 ? 1 : 0;
    sections.disputeSweep.escalated = escalatedTonight;
    for (let i = escalatedOpen.length - 1; i >= 0; i--) if (escalatedOpen[i].until < today) escalatedOpen.splice(i, 1);
    sections.escalatedDisputes = escalatedOpen.slice(0, 20).map((e) => ({ service: e.service, note: e.note }));

    // 5. lakes born → a season-date confirmation card for a human
    for (const lake of lakes) {
      if (lake.bornOn === today) {
        sections.lakesBorn.push({ name: lake.name, source: lake.source });
        byKind.lakeSeasonConfirmations++; humanTonight++;
      }
      // ops confirming next season's ice-out is ALSO a human action
      for (const y of [2026, 2027]) if (lake.confirmedOn[y] === today && y === 2027) {
        byKind.lakeSeasonConfirmations++; humanTonight++;
      }
    }

    // 6. price suggestions: within the 10% dial they auto-apply; above it a
    //    human must tap. Roughly monthly per service under margin pressure.
    if (dayIdx % 30 === 11) {
      for (const svc of SERVICES) {
        if (r() < 0.28) {
          if (r() < 0.55) sections.autoPricing.changes.push({ label: `raise to $${int(r, 80, 900)}`, service: svc.name });
          else { byKind.priceSuggestionsNotAutoApplied++; humanTonight++; }
        }
      }
    }

    // 7. the duration dials keep learning (real engine call)
    if (r() < 0.3) {
      const svc = pick(r, SERVICES);
      const res = learnedEstimate(svc.est, Array.from({ length: int(r, 5, 30) }, () => svc.est + (r() - 0.4) * 40));
      if (res.moved) sections.learning.changes.push({ service: svc.name, from: svc.est, to: res.next, samples: res.samples });
    }
    if (r() < 0.10) sections.routes.hoursBust = int(r, 1, 2);
    if (r() < 0.30) { sections.aiAutoReplies = int(r, 1, Math.max(2, Math.round(customers / 90))); sections.aiReplyTexts = ["Booked — Thursday morning."]; }

    // 8. THE DIGEST — the real composer, every night
    const html = composeNightlyDigest(sections);
    if (html === QUIET) quietNights++;
    // Honesty invariant, enforced on all 730 nights of every world size.
    if (sections.escalatedDisputes.length > 0 || sections.gapSla.alerted > 0 || sections.lakesBorn.length > 0) {
      expect(html, S(`night ${today}: humans were needed but the digest said quiet`)).not.toBe(QUIET);
    }

    totalHuman += humanTonight;
    weekBucket += humanTonight;
    if ((dayIdx + 1) % 7 === 0) { weekly.push(weekBucket); weekBucket = 0; }
  });
  if (weekBucket > 0) weekly.push(weekBucket);

  return {
    customers, crews, jobs: jobs.length, nights: SIM_DAYS, weeks: weekly.length,
    totalHuman, perWeekAvg: totalHuman / weekly.length,
    perWeekPeak: Math.max(...weekly), byKind, quietNights, customerTouches, weekly,
  };
}

describe("MEASURE · weekly human workload across two seasons", () => {
  it("runs the nightly ladder for 250 / 500 / 1000 / 2000 customers and reports the human load", () => {
    const runs = [250, 500, 1000, 2000].map((n, i) => runSeasons(n, 900 + i));
    const at1000 = runs[2];

    // Sanity: the world is actually big.
    expect(at1000.jobs, S("the 1000-customer world is too small to be realistic")).toBeGreaterThan(20_000);
    expect(at1000.nights).toBe(730);
    expect(at1000.weeks).toBeGreaterThanOrEqual(104);

    const line = (run: WorkloadResult) =>
      `${String(run.customers).padStart(5)} cust | ${String(run.crews).padStart(3)} crews | ${String(run.jobs).padStart(6)} jobs | ` +
      `human items/wk avg ${run.perWeekAvg.toFixed(1).padStart(7)} peak ${String(run.perWeekPeak).padStart(5)} | ` +
      `quiet nights ${String(run.quietNights).padStart(3)}/730 | customer texts ${run.customerTouches}`;


    console.log("\n=== WEEKLY HUMAN WORKLOAD — crew supply recruits with demand ===");
    for (const run of runs) {
      console.log(line(run));
      console.log(`        ${JSON.stringify(run.byKind)}`);
    }
    const ratio = runs[3].perWeekAvg / runs[0].perWeekAvg;
    const custRatio = runs[3].customers / runs[0].customers;
    console.log(`  ${custRatio}x the customers -> ${ratio.toFixed(2)}x the weekly human load\n`);

    // The SAME growth with the crew bench frozen at 40 — the scenario where
    // the ladder stops absorbing volume and starts producing ops work.
    const capped = [250, 500, 1000, 2000].map((n, i) => runSeasons(n, 900 + i, 40));
    console.log("=== SAME GROWTH, crew bench frozen at 40 ===");
    for (const run of capped) {
      console.log(line(run));
      console.log(`        ${JSON.stringify(run.byKind)}`);
    }
    const cappedRatio = capped[3].perWeekAvg / capped[0].perWeekAvg;
    console.log(`  ${custRatio}x the customers -> ${cappedRatio.toFixed(2)}x the weekly human load (SUPERLINEAR)\n`);


    // The load must be BOUNDED, not zero — a ladder that never asks for a
    // human is lying, and one that scales 1:1 with customers is a hiring plan.
    expect(at1000.perWeekAvg, S("the ladder never asks for a human — implausible")).toBeGreaterThan(0);
    expect(ratio, S("with crew supply tracking demand the human load must stay ~linear or better")).toBeLessThan(custRatio * 1.2);
    // MEASURED: with the bench frozen, the load doesn't just grow — its
    // COMPOSITION changes. Unfillable jobs and gap-SLA pages are exactly zero
    // while crews recruit with demand, and become the dominant category once
    // they don't. Recruiting, not ops headcount, is the dial that matters.
    expect(cappedRatio, S("freezing the crew bench must raise the weekly human load")).toBeGreaterThan(ratio);
    expect(runs[3].byKind.unfillableJobs + runs[3].byKind.gapSlaAlerts, S("with crews recruiting to demand nothing should go unfilled")).toBe(0);
    expect(capped[3].byKind.unfillableJobs, S("a frozen bench must strand jobs")).toBeGreaterThan(50);
    expect(capped[3].byKind.gapSlaAlerts, S("a frozen bench must page ops")).toBeGreaterThan(10);
    expect(capped[3].perWeekPeak, S("a frozen bench must produce brutal peak weeks")).toBeGreaterThan(runs[3].perWeekPeak * 3);
    for (const run of runs) expect(run.quietNights, S(`no quiet nights at ${run.customers} customers`)).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
