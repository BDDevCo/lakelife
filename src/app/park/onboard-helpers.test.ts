import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planOnboarding, onboardSummary, signingExplainer, type OnboardRow } from "./onboard-helpers";

const TODAY = "2026-12-16";

const row = (o: Partial<OnboardRow> = {}): OnboardRow => ({
  lotId: "l1", lotNumber: "3", displayName: "Amberg, Roy",
  rent: "395", movedInOn: "", signedNewLease: false, ...o,
});

describe("filing the households who were already there", () => {
  it("files a row with a name, and leaves an unknown move-in date UNKNOWN", () => {
    // This used to default the date to today. "I don't know when they moved in"
    // then became "they moved in today", and the resident's own screen greeted
    // a household of eleven years with "living here since" this morning.
    const p = planOnboarding([row()], TODAY);
    expect(p.toFile).toHaveLength(1);
    expect(p.toFile[0].movedInOn).toBe("");
    expect(p.toFile[0].rent).toBe(395);
  });

  it("keeps a move-in date the owner DOES know", () => {
    const p = planOnboarding([row({ movedInOn: "2015-04-02" })], TODAY);
    expect(p.toFile[0].movedInOn).toBe("2015-04-02");
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
    expect(onboardSummary(p, null)).toContain("File 2 households — $805.00 a month");
  });

  it("NAMES the lots with no rent, because those quietly never get billed", () => {
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", rent: "395" }),
      row({ lotId: "b", lotNumber: "9", rent: "" }),
    ], TODAY);
    const s = onboardSummary(p, null);
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
    expect(onboardSummary(mixed, 3))
      .toContain("1 on the new lease, 1 on the arrangement they already had");
  });

  it("treats nobody-has-signed as the ORDINARY state, not a chore outstanding", () => {
    // Onboarding an occupied park means exactly this: everyone is on whatever
    // they already had. It read "None have signed the new lease YET".
    const none = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(onboardSummary(none, null)).toContain("all on the arrangement they already had");
    expect(onboardSummary(none, null)).not.toMatch(/yet/i);
  });

  it("says plainly when everybody has", () => {
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    expect(onboardSummary(all, null)).toMatch(/all on the new lease/);
  });

  // ---- the cap the park may not have ---------------------------------------

  it("never invents an agreement cap the park has not set", () => {
    // THE BUG: three sentences said "your three-month rule" as flat fact.
    // `max_agreement_months` is a per-park dial and NO park in the database has
    // ever set one — including The Haven. The screen was quoting a policy back
    // at owners who had never written it.
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    const none = planOnboarding([row({ signedNewLease: false })], TODAY);
    for (const line of [onboardSummary(all, null), onboardSummary(none, null),
                        signingExplainer(null)]) {
      expect(line).not.toMatch(/three-month/);
      expect(line).not.toMatch(/\d+-month rule/);
    }
  });

  it("names the park's OWN cap when it has one", () => {
    const all = planOnboarding([row({ signedNewLease: true })], TODAY);
    expect(onboardSummary(all, 6)).toContain("capped by your 6-month rule");
    expect(signingExplainer(6)).toContain("6-month rule");
    expect(signingExplainer(1)).toContain("one-month rule");
  });

  // ---- park-agnostic -------------------------------------------------------

  it("mentions no seller anywhere, because most parks were never bought", () => {
    // Most parks joining already own themselves and have had the same
    // households for years. A screen that invents a seller reads as software
    // written for somebody else's deal.
    const p = planOnboarding([
      row({ lotId: "a", lotNumber: "1", signedNewLease: true }),
      row({ lotId: "b", lotNumber: "2", signedNewLease: false }),
    ], TODAY);
    for (const line of [onboardSummary(p, null), onboardSummary(p, 3),
                        signingExplainer(null), signingExplainer(3)]) {
      expect(line).not.toMatch(/seller|closing|purchase|takeover/i);
    }
  });

  it("carries the signing state through to what gets written", () => {
    const p = planOnboarding([row({ signedNewLease: false })], TODAY);
    expect(p.toFile[0].signedNewLease).toBe(false);
  });

  it("counts what was left for later without calling it a failure", () => {
    const p = planOnboarding([row(), row({ lotId: "b", lotNumber: "9", displayName: "" })], TODAY);
    expect(onboardSummary(p, null)).toContain("1 still to do");
  });

  it("says nothing is filled in rather than reporting a zero total", () => {
    expect(onboardSummary(planOnboarding([], TODAY), null)).toBe("Nothing filled in yet.");
  });

  it("points at the problems when every row has one", () => {
    const p = planOnboarding([row({ rent: "nope" })], TODAY);
    expect(onboardSummary(p, null)).toMatch(/fix the lines below/);
  });
});

// ---------------------------------------------------------------------------

describe("the tick that claims a lease exists", () => {
  // THE WORST FINDING OF THE GO-LIVE REHEARSAL, and it is not in a pure
  // function — it is one word in a component's initial state, which is why it
  // survived every test up to now.
  //
  // Every checkbox defaulted to TICKED. The instruction above them reads "tick
  // anyone who has signed your new lease", which only makes sense from a clear
  // baseline. An owner who followed that instruction, ticked nobody because on
  // day one nobody has signed, and pressed File wrote a signed agreement for
  // every household in the park — and the summary line called it "all on the
  // new lease" as though describing his own work.
  const source = () => {
    const raw = readFileSync(
      new URL("../../components/ParkOnboard.tsx", import.meta.url), "utf8");
    // Comments are stripped, because the comment explaining this fix names the
    // old value and a naive grep would match it and pass forever.
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  };

  it("finds the initial state it is scanning, so a rename cannot make this vacuous", () => {
    expect(source()).toMatch(/signedNewLease\s*:/);
  });

  it("starts every household CLEAR of the new lease", () => {
    expect(source()).toMatch(/signedNewLease\s*:\s*false/);
    expect(source()).not.toMatch(/signedNewLease\s*:\s*true/);
  });
});

// ---------------------------------------------------------------------------

describe("the number he checks before he taps File", () => {
  /**
   * THE SCREEN TOTALLED RENT AND THE RUN CHARGES MORE.
   *
   * A grounds fee lands on every tenancy signed with this owner, and the word
   * "fee" appeared nowhere on this screen. So filing twenty households at $400
   * read "$8,000 a month" while the January run would raise $10,850.60 — the
   * number he checks against his own roll was not the number that bills.
   */
  const signed = (o: Partial<OnboardRow> = {}) =>
    row({ signedNewLease: true, rent: "400", ...o });

  it("shows rent and fees as their own arithmetic, not one opaque total", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }), signed({ lotId: "b", lotNumber: "2" })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$800.00 rent + $285.06 fees = $1,085.06 a month");
  });

  it("reads exactly as before for a park with no fees", () => {
    const p = planOnboarding([signed({ lotNumber: "1" })], TODAY);
    expect(onboardSummary(p, 3, 0)).toContain("$400.00 a month");
    expect(onboardSummary(p, 3, 0)).not.toContain("fees");
    // And the parameter is defaulted, so old callers are untouched.
    expect(onboardSummary(p, 3)).toBe(onboardSummary(p, 3, 0));
  });

  it("charges the fee only to the SIGNED rows", () => {
    // A holdover is an inherited tenancy and a fee never lands on one.
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       row({ lotId: "b", lotNumber: "2", rent: "400", signedNewLease: false })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$800.00 rent + $142.53 fees = $942.53 a month");
  });

  it("does not count a fee for a row with no rent, which will not be billed", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       signed({ lotId: "b", lotNumber: "6", rent: "" })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("$400.00 rent + $142.53 fees = $542.53 a month");
  });

  it("NAMES the households left on the old arrangement", () => {
    // One missed tick is a household with no new lease and — because a fee
    // never lands on an inherited tenancy — no fee either. At twenty rows a
    // bare count will not tell him which one, and nothing later says so.
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       signed({ lotId: "b", lotNumber: "2" }),
       row({ lotId: "c", lotNumber: "14", rent: "400", signedNewLease: false })],
      TODAY,
    );
    const s = onboardSummary(p, 3, 142.53);
    expect(s).toContain("2 on the new lease, 1 on the arrangement they already had (lot 14)");
    expect(s).toContain("no fee will bill for it");
  });

  it("says nothing about fees in that sentence when the park has none", () => {
    const p = planOnboarding(
      [signed({ lotId: "a", lotNumber: "1" }),
       row({ lotId: "c", lotNumber: "14", rent: "400", signedNewLease: false })],
      TODAY,
    );
    expect(onboardSummary(p, 3, 0)).toContain("(lot 14)");
    expect(onboardSummary(p, 3, 0)).not.toContain("no fee will bill");
  });
});
