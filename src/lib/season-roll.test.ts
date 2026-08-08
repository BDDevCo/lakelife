/**
 * THE SEASON CLOCK — the year roll, the demand-born lake, and the ops gate.
 *
 * Covers the three related defects the two-season simulation found
 * (docs/two-season-audit-2026-07.md, findings 1, 2 and 8):
 *
 *   1. stored season dates are ONE season's absolute dates, so every spring
 *      every lake went 100% off-season for water work until a human retyped
 *      them — and nothing prompted it,
 *   2. a demand-born lake inherited its donor's YEAR, so the customer who
 *      names a lake to get a pier installed could not book a pier install,
 *   8. ops could save an inverted season (whole calendar dark, no error) or a
 *      blank ice-out (pier installs bookable under January ice — rule 7).
 */

import { describe, it, expect, vi } from "vitest";
import {
  dayStatus,
  effectiveSeason,
  validateSeasonDates,
  pullDeadlineFrom,
  addYearsISO,
  isRealDate,
  daysInMonth,
  todayLakeDate,
  type DayContext,
} from "./booking";

// lake-birth.ts is server-only and talks to Supabase; both are stubbed so the
// pure inheritance decision (which dates a born lake carries) is testable.
vi.mock("server-only", () => ({}));

const insertedRows: Array<Record<string, unknown>> = [];
let donorRow: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    let selectCall = 0;
    return {
      from() {
        const b: Record<string, unknown> = {};
        const passthrough = ["select", "or", "not", "eq", "order", "limit", "ilike", "update"];
        for (const m of passthrough) b[m] = () => b;
        b.insert = (payload: Record<string, unknown>) => {
          insertedRows.push(payload);
          return b;
        };
        // 1st maybeSingle = the dedup lookup (no match), 2nd = the donor lake.
        b.maybeSingle = async () => ({ data: selectCall++ === 0 ? null : donorRow, error: null });
        b.single = async () => ({ data: { id: "lake-born", name: "Witmer Lake" }, error: null });
        return b;
      },
    };
  },
}));

const water = (over: Partial<DayContext> = {}): DayContext => ({
  today: "2027-04-01",
  isWaterWork: true,
  seasonStart: "2026-03-21", // Big Long Lake, 2026 season — never rolled
  seasonEnd: "2026-11-14",
  fullDates: new Set<string>(),
  ...over,
});

// ---------------------------------------------------------------------------
// BUG 1 — the provisional year roll
// ---------------------------------------------------------------------------

describe("effectiveSeason — stale dates roll onto the current season year (audit finding 1)", () => {
  it("rolls a past season's month/day forward and says so", () => {
    const eff = effectiveSeason({ iceOut: "2026-03-21", pullDeadline: "2026-11-14" }, "2027-04-01");
    expect(eff.seasonStart).toBe("2027-03-21");
    expect(eff.seasonEnd).toBe("2027-11-14");
    expect(eff.wasRolled).toBe(true);
    expect(eff.yearsRolled).toBe(1);
  });

  it("leaves the current season's dates alone (a confirmed window is never a guess)", () => {
    const eff = effectiveSeason({ iceOut: "2027-03-19", pullDeadline: "2027-11-16" }, "2027-04-01");
    expect(eff).toEqual({
      seasonStart: "2027-03-19",
      seasonEnd: "2027-11-16",
      wasRolled: false,
      yearsRolled: 0,
    });
  });

  it("never rolls backwards — dates entered ahead of time stand", () => {
    const eff = effectiveSeason({ iceOut: "2028-03-19", pullDeadline: "2028-11-16" }, "2027-04-01");
    expect(eff.wasRolled).toBe(false);
    expect(eff.seasonStart).toBe("2028-03-19");
  });

  it("is idempotent — rolling a rolled window changes nothing", () => {
    const once = effectiveSeason({ iceOut: "2026-03-21", pullDeadline: "2026-11-14" }, "2028-04-01");
    expect(once.seasonStart).toBe("2028-03-21");
    const twice = effectiveSeason({ iceOut: once.seasonStart, pullDeadline: once.seasonEnd }, "2028-04-01");
    expect(twice.seasonStart).toBe(once.seasonStart);
    expect(twice.wasRolled).toBe(false);
  });

  it("keeps a multi-year gap in one hop and holds the window's span", () => {
    const eff = effectiveSeason({ iceOut: "2024-03-21", pullDeadline: "2024-11-14" }, "2027-06-01");
    expect(eff.seasonStart).toBe("2027-03-21");
    expect(eff.seasonEnd).toBe("2027-11-14");
    expect(eff.yearsRolled).toBe(3);
  });

  it("a Feb 29 ice-out lands on Feb 28 in a common year (a real date, always)", () => {
    const eff = effectiveSeason({ iceOut: "2028-02-29", pullDeadline: "2028-11-14" }, "2029-01-10");
    expect(eff.seasonStart).toBe("2029-02-28");
    expect(isRealDate(eff.seasonStart!)).toBe(true);
  });

  it("garbage in the row is passed through, not rolled (never throws)", () => {
    const eff = effectiveSeason({ iceOut: "not-a-date", pullDeadline: null }, "2027-04-01");
    expect(eff.wasRolled).toBe(false);
    expect(eff.seasonStart).toBe("not-a-date");
  });
});

describe("dayStatus — the calendar rolls with the season (audit finding 1)", () => {
  it("mid-summer of season 2 is bookable on season 1's stored dates", () => {
    expect(dayStatus("2027-06-15", water())).toBe("available");
  });

  it("the whole of season 2 is not dark: >150 bookable water days on stale dates", () => {
    let bookable = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.UTC(2027, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      if (dayStatus(d, water({ today: "2027-01-01" })) === "available") bookable++;
    }
    expect(bookable).toBeGreaterThan(150);
  });

  it("the rolled window still has real edges — rule 7 is not weakened", () => {
    expect(dayStatus("2027-03-20", water({ today: "2027-01-05" }))).toBe("off-season");
    expect(dayStatus("2027-03-21", water({ today: "2027-01-05" }))).toBe("available");
    expect(dayStatus("2027-11-14", water({ today: "2027-01-05" }))).toBe("available");
    expect(dayStatus("2027-11-15", water({ today: "2027-01-05" }))).toBe("off-season");
  });

  it("capacity and rush still lose to the rolled season gate", () => {
    expect(dayStatus("2027-06-15", water({ fullDates: new Set(["2027-06-15"]) }))).toBe("full");
    expect(
      dayStatus("2027-12-20", water({ today: "2027-12-20", rushNowHour: 9, rushCutoffHour: 14 })),
    ).toBe("off-season");
  });
});

// ---------------------------------------------------------------------------
// BUG 8 — impossible seasons, and the blank ice-out
// ---------------------------------------------------------------------------

describe("dayStatus — an unknown season fails CLOSED (audit finding 8b, rule 7)", () => {
  it("water work with no ice-out on file is off-season, not available", () => {
    expect(dayStatus("2027-01-15", water({ today: "2026-12-01", seasonStart: null, seasonEnd: "2027-11-14" }))).toBe("off-season");
  });

  it("water work with no pull deadline on file is off-season too (the ice cuts both ways)", () => {
    expect(dayStatus("2027-12-28", water({ today: "2027-12-01", seasonStart: "2027-03-21", seasonEnd: null }))).toBe("off-season");
  });

  it("a lake with no season at all sells land work normally", () => {
    expect(
      dayStatus("2027-01-15", { today: "2026-12-01", isWaterWork: false, seasonStart: null, seasonEnd: null, fullDates: new Set() }),
    ).toBe("available");
  });
});

describe("validateSeasonDates — ops cannot save an impossible season (audit finding 8a)", () => {
  it("accepts a sane pair and derives the pull deadline (rule 7: freeze − 8)", () => {
    const r = validateSeasonDates({ iceOut: "2027-03-21", hardFreeze: "2027-11-22" });
    expect(r.ok).toBe(true);
    expect(r.pullDeadline).toBe("2027-11-14");
    expect(r.warning).toBeUndefined();
  });

  it("rejects a swapped pair instead of silently closing the lake", () => {
    // The freeze date typed into the ice-out box and vice-versa.
    const r = validateSeasonDates({ iceOut: "2026-11-22", hardFreeze: "2026-03-21" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/swapp|before|after/i);
  });

  it("rejects an ice-out inside the 8-day pull buffer (no bookable water day left)", () => {
    const r = validateSeasonDates({ iceOut: "2027-11-20", hardFreeze: "2027-11-22" });
    expect(r.ok).toBe(false);
  });

  it("rejects a date the calendar does not have", () => {
    expect(validateSeasonDates({ iceOut: "2027-02-31", hardFreeze: "2027-11-22" }).ok).toBe(false);
    expect(validateSeasonDates({ iceOut: "2027-03-21", hardFreeze: "2027-13-01" }).ok).toBe(false);
    expect(validateSeasonDates({ iceOut: "nope", hardFreeze: null }).ok).toBe(false);
  });

  it("saves a freeze-only row but says out loud that water work stays shut", () => {
    const r = validateSeasonDates({ iceOut: null, hardFreeze: "2027-11-22" });
    expect(r.ok).toBe(true);
    expect(r.pullDeadline).toBe("2027-11-14");
    expect(r.warning).toBeTruthy();
  });

  it("clearing both dates is allowed (and the gate then shuts water work)", () => {
    const r = validateSeasonDates({ iceOut: null, hardFreeze: null });
    expect(r.ok).toBe(true);
    expect(r.pullDeadline).toBeNull();
  });

  it("pullDeadlineFrom crosses month, year and leap boundaries without drift", () => {
    expect(pullDeadlineFrom("2027-11-22")).toBe("2027-11-14");
    expect(pullDeadlineFrom("2027-03-05")).toBe("2027-02-25");
    expect(pullDeadlineFrom("2028-03-05")).toBe("2028-02-26"); // leap year
    expect(pullDeadlineFrom("2027-01-03")).toBe("2026-12-26");
  });
});

describe("date primitives", () => {
  it("daysInMonth is leap-aware", () => {
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 4)).toBe(30);
    expect(daysInMonth(2027, 12)).toBe(31);
  });
  it("isRealDate rejects the dates Postgres would", () => {
    expect(isRealDate("2027-04-31")).toBe(false);
    expect(isRealDate("2027-02-30")).toBe(false);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate(null)).toBe(false);
  });
  it("addYearsISO clamps Feb 29 and leaves nulls alone", () => {
    expect(addYearsISO("2028-02-29", 1)).toBe("2029-02-28");
    expect(addYearsISO("2028-02-29", 4)).toBe("2032-02-29");
    expect(addYearsISO(null, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BUG 2 — the demand-born lake
// ---------------------------------------------------------------------------

describe("findOrCreateLake — a born lake can sell what it was born for (audit finding 2)", () => {
  it("normalises the donor's season onto the current season year, still unconfirmed", async () => {
    insertedRows.length = 0;
    // A donor row nobody has trued up for years — the worst realistic case.
    donorRow = { ice_out_actual: "2019-03-21", hard_freeze_est: "2019-11-22", pull_deadline: "2019-11-14" };
    const { findOrCreateLake } = await import("./lake-birth");
    const res = await findOrCreateLake("Witmer", "customer");
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);

    const row = insertedRows[0];
    const y = Number(todayLakeDate().slice(0, 4));
    expect(row.ice_out_actual).toBe(`${y}-03-21`);
    expect(row.hard_freeze_est).toBe(`${y}-11-22`);
    expect(row.pull_deadline).toBe(`${y}-11-14`);
    // Rule 7's arithmetic survives the roll.
    expect(pullDeadlineFrom(row.hard_freeze_est as string)).toBe(row.pull_deadline);
    // Provisional, not confirmed — a human still trues it up.
    expect(row.season_confirmed).toBe(false);

    // And the point of the whole fix: water work is bookable on day one.
    expect(
      dayStatus(`${y}-06-15`, {
        today: `${y}-04-01`,
        isWaterWork: true,
        seasonStart: row.ice_out_actual as string,
        seasonEnd: row.pull_deadline as string,
        fullDates: new Set(),
      }),
    ).toBe("available");
  });

  it("a donor with no dates on file births a null (fail-closed) season, not a crash", async () => {
    insertedRows.length = 0;
    donorRow = null;
    const { findOrCreateLake } = await import("./lake-birth");
    const res = await findOrCreateLake("Witmer", "crew");
    expect(res.ok).toBe(true);
    expect(insertedRows[0].ice_out_actual).toBeNull();
    expect(insertedRows[0].season_confirmed).toBe(false);
  });
});
