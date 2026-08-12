import { describe, it, expect } from "vitest";
import { planOnboarding, onboardSummary, type OnboardRow } from "./onboard-helpers";

const TODAY = "2026-12-16";

const row = (o: Partial<OnboardRow> = {}): OnboardRow => ({
  lotId: "l1", lotNumber: "3", displayName: "Amberg, Roy",
  rent: "395", movedInOn: "", signedNewLease: true, ...o,
});

describe("filing the households who were already there", () => {
  it("files a row with a name, and defaults the date to today", () => {
    // "Already here" is the common case and a true answer — today is when the
    // RECORD starts, not when the person did.
    const p = planOnboarding([row()], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.toFile[0].movedInOn).toBe(TODAY);
    expect(p.toFile[0].rent).toBe(395);
  });

  it("SKIPS a blank name in silence and names the lot for later", () => {
    // He will not know all nineteen on the first afternoon. A form that refuses
    // to save until every row is complete is a form that saves nothing.
    const p = planOnboarding([row(), row({ lotId: "l2", lotNumber: "9", displayName: "" })], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.skipped).toBe(1);
    expect(p.blankLotNumbers).toEqual(["9"]);
    expect(p.problems).toEqual([]);
  });

  it("records a blank rent as UNKNOWN, never as zero", () => {
    // The ledger refuses to bill a null and would happily bill a zero, so the
    // difference decides whether the household is silently un-billed forever
    // or visibly missing a rent.
    const p = planOnboarding([row({ rent: "" })], TODAY);
    expect(p.toFile[0].rent).toBeNull();
  });

  it("takes a rent with a dollar sign and commas", () => {
    expect(planOnboarding([row({ rent: "$1,450" })], TODAY).toFile[0].rent).toBe(1450);
  });

  it("refuses junk in a rent rather than guessing at it", () => {
    const p = planOnboarding([row({ rent: "ask michael" })], TODAY);
    expect(p.toFile).toHaveLength(0);
    expect(p.problems[0].why).toMatch(/isn't a dollar amount/);
  });

  it("refuses a move-in date in the future — these are people already here", () => {
    const p = planOnboarding([row({ movedInOn: "2027-03-01" })], TODAY);
    expect(p.problems[0].why).toMatch(/already here/);
  });

  it("keeps a genuine historic move-in date", () => {
    expect(planOnboarding([row({ movedInOn: "2019-04-01" })], TODAY).toFile[0].movedInOn)
      .toBe("2019-04-01");
  });

  it("one bad row never costs the good ones", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1" }),
      row({ lotId: "b", lotNumber: "2", rent: "nope" }),
      row({ lotId: "c", lotNumber: "3" }),
    ], TODAY);
    expect(p.toFile.map((r) => r.lotNumber)).toEqual(["1", "3"]);
    expect(p.problems).toHaveLength(1);
  });
});

describe("what he is told before he writes it", () => {
  it("names the monthly total, because that is what he checks against the roll", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", rent: "395" }),
      row({ lotId: "b", lotNumber: "2", rent: "410" }),
    ], TODAY);
    expect(onboardSummary(p)).toContain("File 2 households — $805.00 a month");
  });

  it("NAMES the lots with no rent, because those quietly never get billed", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", rent: "395" }),
      row({ lotId: "b", lotNumber: "9", rent: "" }),
    ], TODAY);
    const s = onboardSummary(p);
    expect(s).toContain("1 with no rent set (lot 9)");
    expect(s).toMatch(/won't be billed until you set one/);
  });

  it("reports the SPLIT between signed and not, because both will exist", () => {
    // On the first morning some have signed and some haven't, and both still
    // live here and still owe rent.
    const mixed = planOnboarding([
      row({ lotId: "a", lotNumber: "1", signedNewLease: true }),
      row({ lotId: "b", lotNumber: "2", signedNewLease: false }),
    ], TODAY);
    expect(onboardSummary(mixed)).toContain("1 on the new lease, 1 still on the old arrangement");
  });

  it("says plainly when nobody has signed yet", () => {
    const none = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(onboardSummary(none)).toMatch(/doesn't apply until they do/);
  });

  it("says plainly when everybody has", () => {
    expect(onboardSummary(planOnboarding([row()], TODAY)))
      .toMatch(/all on the new lease, capped by your three-month rule/);
  });

  it("carries the signing state through to what gets written", () => {
    const p = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(p.toFile[0].signedNewLease).toBe(false);
  });

  it("counts what was left for later without calling it a failure", () => {
    const p = planOnboarding([row(), row({ lotId: "b", lotNumber: "9", displayName: "" })], TODAY);
    expect(onboardSummary(p)).toContain("1 still to do");
  });

  it("says nothing is filled in rather than reporting a zero total", () => {
    expect(onboardSummary(planOnboarding([], TODAY))).toBe("Nothing filled in yet.");
  });

  it("points at the problems when every row has one", () => {
    const p = planOnboarding([row({ rent: "nope" })], TODAY);
    expect(onboardSummary(p)).toMatch(/fix the lines below/);
  });
});
