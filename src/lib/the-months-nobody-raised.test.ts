import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invoiceRefusal, lastClosedMonth, unbilledMonths } from "./park-platform-fee";

/**
 * THE MONTHS NOBODY RAISED.
 *
 * LakeLife's only revenue from a park is the platform fee, and raising it is a
 * manual act on a tab somebody has to remember to open. Verified on 17 Oct
 * 2026: no reference to the platform invoice anywhere in the nightly, the ops
 * task list or the park reconciler. **Nothing reminded anyone.** A monthly act
 * with no reminder is one that silently never happens.
 *
 * And the sharper half, also verified that day: The Haven had
 * `lakelife_park_terms` EMPTY. The $8 dial was set and 21 lots were active,
 * but with no `fee_start_month` the raise door refuses every month — so
 * LakeLife could not bill its first park a penny, and no screen said so.
 */

const SEP = { startMonth: "2027-01", cutoverDate: "2027-01-01", raised: [] as string[] };

describe("which months are owed", () => {
  it("counts every month from the start through the last closed one", () => {
    expect(unbilledMonths({ ...SEP, throughMonth: "2027-04" }))
      .toEqual(["2027-01", "2027-02", "2027-03", "2027-04"]);
  });

  it("skips the ones already raised", () => {
    expect(unbilledMonths({
      ...SEP, raised: ["2027-02", "2027-04"], throughMonth: "2027-04",
    })).toEqual(["2027-01", "2027-03"]);
  });

  it("crosses a year end", () => {
    expect(unbilledMonths({
      startMonth: "2027-11", cutoverDate: "2027-01-01", raised: [], throughMonth: "2028-02",
    })).toEqual(["2027-11", "2027-12", "2028-01", "2028-02"]);
  });

  it("NO START MONTH IS NOT 'NOTHING IS OWED'", () => {
    // It is a park that cannot be invoiced AT ALL, which is a different
    // problem with a different fix — and the caller has to tell them apart,
    // so this returns nothing and `notBillable` carries the other half.
    expect(unbilledMonths({ ...SEP, startMonth: null, throughMonth: "2027-06" })).toEqual([]);
    expect(unbilledMonths({ ...SEP, startMonth: "", throughMonth: "2027-06" })).toEqual([]);
    expect(unbilledMonths({ ...SEP, startMonth: "nonsense", throughMonth: "2027-06" })).toEqual([]);
    // A MALFORMED MONTH THAT SORTS LOW. "nonsense" is caught by the
    // from > through comparison whatever the guard does, so it cannot tell a
    // shape check from a truthiness check. "2027-00" sorts below the through
    // month, so a loose guard walks it into the loop and emits "2027-00" as a
    // month somebody is asked to raise.
    expect(unbilledMonths({ ...SEP, startMonth: "2027-00", throughMonth: "2027-06" })).toEqual([]);
    expect(unbilledMonths({ ...SEP, startMonth: "2027-1", throughMonth: "2027-06" })).toEqual([]);
    // NOT "0000-01" — that is a well-shaped month, and the cutover gate
    // correctly clamps it to the first billable period rather than refusing
    // it. Asserting [] there would have been testing the wrong thing.
  });

  it("nothing before the park was taken over, whatever the start month says", () => {
    // The same gate invoiceRefusal applies. A month this said was owed but
    // the raise door would refuse is a task nobody can complete.
    expect(unbilledMonths({
      startMonth: "2026-06", cutoverDate: "2027-01-01", raised: [], throughMonth: "2027-02",
    })).toEqual(["2027-01", "2027-02"]);
  });

  it("and nothing before the fee starts, whatever the cutover says", () => {
    expect(unbilledMonths({
      startMonth: "2027-03", cutoverDate: "2027-01-01", raised: [], throughMonth: "2027-04",
    })).toEqual(["2027-03", "2027-04"]);
  });

  it("EVERY MONTH IT NAMES IS ONE THE RAISE DOOR WOULD ACCEPT", () => {
    // The property that matters: this list is a to-do, and a to-do containing
    // an impossible item is worse than an empty one.
    const months = unbilledMonths({
      startMonth: "2027-01", cutoverDate: "2027-01-15", raised: [], throughMonth: "2027-06",
    });
    expect(months.length).toBeGreaterThan(0);
    for (const periodMonth of months) {
      expect(
        invoiceRefusal({
          periodMonth, startMonth: "2027-01", cutoverDate: "2027-01-15",
          // AFTER the last month the list names, so the closed-month gate is
          // not what makes this pass. The property under test is that every
          // month named is acceptable on its OWN merits.
          today: "2027-07-15",
        }),
        `${periodMonth} is on the list but the raise door refuses it`,
      ).toBeNull();
    }
  });

  it("nothing owed before the start month arrives", () => {
    expect(unbilledMonths({ ...SEP, throughMonth: "2026-12" })).toEqual([]);
  });

  it("a nonsense through-month yields nothing rather than spinning", () => {
    expect(unbilledMonths({ ...SEP, throughMonth: "" })).toEqual([]);
    expect(unbilledMonths({ ...SEP, throughMonth: "2027-13" })).toEqual([]);
  });

  it("and a start month far in the past is capped rather than looping forever", () => {
    const many = unbilledMonths({
      startMonth: "1990-01", cutoverDate: null, raised: [], throughMonth: "2027-06",
    });
    expect(many.length).toBeLessThanOrEqual(240);
    expect(many.length).toBeGreaterThan(0);
  });
});

describe("the last month that may be raised", () => {
  it("is the one before this", () => {
    // A month still running has not finished being what it will be billed for.
    expect(lastClosedMonth("2027-06-14")).toBe("2027-05");
  });

  it("crosses a year end", () => {
    expect(lastClosedMonth("2027-01-03")).toBe("2026-12");
  });

  it("and a nonsense date yields nothing rather than a wrong month", () => {
    // `Number("")` is 0 and 0 is finite, so the first version of this guard
    // let a blank through and produced the month "-1-12" as a real answer.
    for (const bad of ["", "   ", "not-a-date", "2027", "2027-13-01", "27-06-14"]) {
      expect(lastClosedMonth(bad), JSON.stringify(bad)).toBe("");
    }
  });
});

describe("the loader tells the two problems apart", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const data = strip(readFileSync(
    fileURLToPath(new URL("../app/ops/park-fee-data.ts", import.meta.url)), "utf8"));

  it("a park with no start month is NOT BILLABLE, not merely up to date", () => {
    expect(data).toMatch(/notBillable: !startMonth/);
  });

  it("A VOIDED MONTH IS NOT A RAISED ONE", () => {
    // Counting it would hide the exact case somebody voided it to fix.
    expect(data).toMatch(/=== "void"\) continue;/);
  });

  it("a failed read is null, never an empty answer about our own revenue", () => {
    const at = data.indexOf("export async function getPlatformBillingGaps");
    const body = data.slice(at);
    const branch = body.slice(body.indexOf("if (parksRes.error"), body.indexOf("const termsBy"));
    expect(branch.length, "the error branch is gone — this scan is measuring nothing")
      .toBeGreaterThan(20);
    expect(branch).toMatch(/return null;/);
    expect(branch).not.toMatch(/return \[\]/);
  });

  it("one park's lots failing does not empty the answer for the others", () => {
    expect(data).toMatch(/monthlyCents = 0;/);
    expect(data).toMatch(/catch \{/);
  });

  it("and the console reads null as none rather than inventing some", () => {
    const page = strip(readFileSync(
      fileURLToPath(new URL("../app/ops/page.tsx", import.meta.url)), "utf8"));
    expect(page).toMatch(/\(billingGaps \?\? \[\]\)/);
    expect(page).toMatch(/parksNotBillable:/);
    expect(page).toMatch(/monthsUnbilled:/);
  });
});
