import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lakeDaysSince, lakeDateOf } from "./booking";
import { rentForPeriod, lastDayOfMonth } from "@/app/park/rerate-helpers";
import { buildStatement } from "@/app/park/statement-helpers";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * INDIANA IS UTC−5/−4, SO FROM 7PM LOCAL THE UTC DAY IS ALREADY TOMORROW.
 *
 * Four places took a Postgres timestamptz — served as UTC — and either sliced
 * it to a date or subtracted it from a lake-local date anchored at T00:00:00Z,
 * then compared the result to windows built from todayLakeDate(). Two of those
 * decided which month a crew's money landed in.
 */
describe("lakeDaysSince counts lake calendar days", () => {
  it("an evening instant belongs to the lake day, not the UTC one", () => {
    // 31 Dec 2026, 7:15pm EST is 2027-01-01T00:15Z.
    expect(lakeDateOf("2027-01-01T00:15:00Z")).toBe("2026-12-31");
  });

  it("gives the calendar age, where the UTC anchor gave one less", () => {
    // Claim made 1 Jan 10:00am EST; read on lake-date 15 Jan. Calendar age 14.
    // The old expression computed round(13.375) = 13 and the 14-day chase
    // fired a day late.
    expect(lakeDaysSince("2027-01-01T15:00:00Z", "2027-01-15")).toBe(14);
  });

  it("calls last night's 8pm report one day old, not zero", () => {
    // 31 Dec 8:00pm EST = 2027-01-01T01:00Z, read on 1 Jan.
    expect(lakeDaysSince("2027-01-01T01:00:00Z", "2027-01-01")).toBe(1);
  });

  it("is DST-proof across both transitions", () => {
    // Spring forward 8 Mar 2026, fall back 1 Nov 2026 — a 23h and a 25h day.
    expect(lakeDaysSince("2026-03-06T17:00:00Z", "2026-03-10")).toBe(4);
    expect(lakeDaysSince("2026-10-30T17:00:00Z", "2026-11-03")).toBe(4);
  });

  it("never goes negative, and survives a garbage timestamp", () => {
    expect(lakeDaysSince("2027-06-01T12:00:00Z", "2027-01-01")).toBe(0);
    expect(lakeDaysSince("not-a-date", "2027-01-01")).toBe(0);
  });
});

describe("the four sites use it", () => {
  it("a crew's clawback is dated lake-local, on both branches", () => {
    const e = code(read("../app/vendor/earnings-data.ts"));
    expect(e).toMatch(/const stamped = lakeDateOf\(String\(p\.created_at \?\? ""\)\)/);
    expect(e).not.toMatch(/String\(p\.created_at \?\? ""\)\.slice\(0, 10\)/);
  });

  it("claim ageing counts lake days", () => {
    const m = code(read("./park-machine.ts"));
    expect(m).toMatch(/lakeDaysSince\(c\.created_at as string, today\)/);
    expect(m).not.toMatch(/\$\{today\}T00:00:00Z/);
  });

  it("BOTH request-age copies are fixed — ops and the resident's own screen", () => {
    for (const f of ["../app/park/request-actions.ts", "../app/parks/my-data.ts"]) {
      const c = code(read(f));
      expect(c, f).toMatch(/ageDays: lakeDaysSince\(r\.created_at as string, todayLakeDate\(\)\)/);
      expect(c, f).not.toMatch(/Date\.parse\(r\.created_at as string\)\) \/ 86_400_000/);
    }
  });

  it("the accountant's CSV dates a reversal on the same clock as the rest of the row", () => {
    const r = code(read("../app/park/receipts-helpers.ts"));
    // WIDENED WITH THE COLUMN IT GUARDS. There are two ways money stops
    // counting now — an office reversal and a bank return (0155) — and both
    // print into this one date cell, so both must be sliced on the lake's
    // clock. `notCollectedAt` is the expression that returns whichever
    // happened; pinning it here keeps the original rule ("not sliced from
    // UTC") true for the route that did not exist when the rule was written.
    expect(r).toMatch(/lakeDateOf\(String\(notCollectedAt\(r\)\)\)/);
    // And the reason the rule exists: a raw UTC slice put a reversal recorded
    // at 7:30pm on 31 Dec into the following year.
    expect(r).not.toMatch(/String\(r\.reversedAt\)\.slice/);
  });

  it("both routes out of the total go through one expression", () => {
    // The instance-vs-class rule. Six places asked "was this reversed?"; a
    // seventh route appeared and the danger is fixing the totals and missing
    // the CSV, or the reverse. One helper, so there is one place to be wrong.
    const r = code(read("../app/park/receipts-helpers.ts"));
    expect(r).toMatch(/export function notCollectedAt/);
    expect(r).toMatch(/r\.reversedAt \?\? r\.bankReturnedAt/);
  });
});

/**
 * A MONTH IS BILLED AT ITS OWN RATE.
 */
describe("rentForPeriod", () => {
  const jan = lastDayOfMonth("2027-01");
  const changes = [{ effective_on: "2027-02-01", from_amount: 400, to_amount: 425 }];

  it("bills January at January's rate, not February's increase", () => {
    expect(rentForPeriod(changes, jan, 425)).toBe(400);
  });

  it("bills February at the new rate", () => {
    expect(rentForPeriod(changes, lastDayOfMonth("2027-02"), 425)).toBe(425);
  });

  it("uses today's rent when nothing has ever changed", () => {
    expect(rentForPeriod([], jan, 400)).toBe(400);
  });

  it("picks the newest change already in force, not the first", () => {
    const two = [
      { effective_on: "2026-12-15", from_amount: 272, to_amount: 400 },
      { effective_on: "2027-02-01", from_amount: 400, to_amount: 425 },
    ];
    expect(rentForPeriod(two, jan, 425)).toBe(400);
    expect(rentForPeriod(two, lastDayOfMonth("2026-11"), 425)).toBe(272);
  });

  it("prefers a change already in force over today's live rent", () => {
    // The case that distinguishes the two branches. With a change in force and
    // NO later one, the fallback would reach for quoted_amount — which is a
    // live value and can have drifted. My first version of this suite could not
    // tell the branches apart, because in every example they happened to agree.
    const done = [{ effective_on: "2026-12-15", from_amount: 272, to_amount: 400 }];
    expect(rentForPeriod(done, jan, 999)).toBe(400);
  });

  it("returns null when there is no rent at all, rather than guessing zero", () => {
    expect(rentForPeriod([], jan, null)).toBeNull();
  });

  it("knows February's length, in a leap year and out", () => {
    expect(lastDayOfMonth("2027-02")).toBe("2027-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2027-12")).toBe("2027-12-31");
  });
});

describe("runCharges bills at the period's rate", () => {
  const l = code(read("../app/park/ledger-actions.ts"));
  it("chooses the rate as of the billed month", () => {
    expect(l).toMatch(/rent: rentForPeriod\(/);
    expect(l).toMatch(/lastDayOfMonth\(month\)/);
  });
  it("and only applies due increases when billing the current month", () => {
    expect(l).toMatch(/const billingCurrentMonth = month === todayLakeDate\(\)\.slice\(0, 7\)/);
  });
  it("stops rather than guessing if the rent history cannot be read", () => {
    expect(l).toMatch(/the rent history for these lots/);
  });
});

/**
 * A BILL IS NEVER DUE BEFORE THE TENANCY EXISTED.
 */
describe("buildStatement's due date", () => {
  const base = { fees: [], dueDay: 1, costShares: [] };

  it("a mid-month arrival is not due before they moved in", () => {
    const st = buildStatement({
      ...base, month: "2027-02",
      stay: { start: "2027-02-18", end: "2028-02-18" },
      rent: 400,
    });
    expect(st.dueOn).toBe("2027-02-18");
    expect(st.prorated).toBe(true);
    expect(st.daysBilled).toBe(11);
  });

  it("a sitting tenant's due day is untouched", () => {
    const st = buildStatement({
      ...base, month: "2027-02",
      stay: { start: "2026-01-01", end: "2028-01-01" },
      rent: 400,
    });
    expect(st.dueOn).toBe("2027-02-01");
    expect(st.prorated).toBe(false);
  });

  it("still clamps a due day past the end of a short month", () => {
    const st = buildStatement({
      ...base, month: "2027-02", dueDay: 31,
      stay: { start: "2026-01-01", end: "2028-01-01" },
      rent: 400,
    });
    expect(st.dueOn).toBe("2027-02-28");
  });
});

/**
 * THE FREEZE WARNING IS THE ONE EMAIL OF THE YEAR.
 */
describe("the seasonal pull reminder matches the rolled window", () => {
  const a = read("./automation.ts");
  const at = a.indexOf("export async function sendSeasonalPullReminders");
  const body = code(a.slice(at, a.indexOf("\nexport ", at + 10)));

  it("no longer equality-matches the raw stored column", () => {
    expect(body).not.toMatch(/\.eq\("pull_deadline", target\)/);
  });

  it("compares the effective season end to the target", () => {
    expect(body).toMatch(/eff\.seasonEnd === target/);
  });

  it("files the once-per-season claim under the effective year", () => {
    // Filing a 2027 send under 2026 collides with the 2026 row and suppresses it.
    expect(body).toMatch(/Number\(String\(effectiveDeadline\)\.slice\(0, 4\)\)/);
  });

  it("and prints the rolled date, since prettyDate drops the year", () => {
    expect(body).toMatch(/prettyDate\(effectiveDeadline\)/);
  });
});
