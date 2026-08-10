import { describe, it, expect } from "vitest";
import {
  addMonths, daysBetween, agreementEnd, planRenewal, chainNotice,
  renewalRefusalText, LONG_CHAIN_MONTHS,
  type AgreementTerms, type PriorAgreement, type RenewalRefusal,
} from "./agreement-helpers";

/** The Haven: three-month agreements, one deposit per unbroken chain. */
const HAVEN: AgreementTerms = { maxAgreementMonths: 3, depositAmount: 400 };
const NO_CAP: AgreementTerms = { maxAgreementMonths: null, depositAmount: null };

const first: PriorAgreement = {
  id: "a1", chainId: "chain-1", seq: 1,
  start: "2026-12-15", end: "2027-03-15",
  quotedAmount: 400, term: "monthly",
};

describe("addMonths", () => {
  it("does real month arithmetic, not 90 days", () => {
    expect(addMonths("2026-12-15", 3)).toBe("2027-03-15");
    expect(addMonths("2027-01-01", 3)).toBe("2027-04-01");
  });

  it("clamps to the end of a short month instead of rolling over", () => {
    // Naive arithmetic gives Mar 3 and hands somebody three free days — then
    // drifts the whole chain later, month after month.
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29"); // leap year
  });

  it("crosses a year boundary", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
});

describe("agreementEnd", () => {
  it("ends a Haven agreement three months on", () => {
    expect(agreementEnd("2026-12-15", HAVEN)).toBe("2027-03-15");
  });

  it("returns null where the park writes no fixed term", () => {
    expect(agreementEnd("2026-12-15", NO_CAP)).toBeNull();
  });
});

describe("renewing", () => {
  it("CONSECUTIVE: same chain, next in sequence, and NO second deposit", () => {
    const r = planRenewal(first, HAVEN, "2027-03-01");
    expect(r.ok).toBe(true);
    expect(r.start).toBe("2027-03-15");          // the day the last one ends
    expect(r.end).toBe("2027-06-15");
    expect(r.continuesChain).toBe(true);
    expect(r.nextSeq).toBe(2);
    // THE OWNER'S RULE.
    expect(r.depositDue).toBe(false);
    expect(r.depositAmount).toBeNull();
    expect(r.totalMonthsAfter).toBe(6);
  });

  it("A GAP: new chain, back to seq 1, and a deposit IS due", () => {
    // They left in March and came back in June. That is a new tenancy.
    const r = planRenewal(first, HAVEN, "2027-06-01", "2027-06-01");
    expect(r.ok).toBe(true);
    expect(r.continuesChain).toBe(false);
    expect(r.nextSeq).toBe(1);
    expect(r.depositDue).toBe(true);
    expect(r.depositAmount).toBe(400);
    expect(r.totalMonthsAfter).toBe(3);
  });

  it("charges no deposit on a gap when the park takes none", () => {
    const r = planRenewal(first, { maxAgreementMonths: 3, depositAmount: null }, "2027-06-01", "2027-06-01");
    expect(r.depositDue).toBe(false);
  });

  it("chains repeatedly, and the total tracks the whole run", () => {
    let prior = first;
    const ends: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = planRenewal(prior, HAVEN, prior.end);
      expect(r.continuesChain).toBe(true);
      expect(r.depositDue).toBe(false);          // never again
      ends.push(r.end!);
      prior = {
        ...prior, id: `a${i + 2}`, seq: r.nextSeq!,
        start: r.start!, end: r.end!,
      };
    }
    // Eight consecutive three-month agreements = two years on the lot.
    expect(prior.seq).toBe(8);
    expect(ends.at(-1)).toBe("2028-12-15");
    expect(planRenewal(prior, HAVEN, prior.end).totalMonthsAfter).toBe(27);
  });

  it("refuses to renew a park with no fixed term", () => {
    expect(planRenewal(first, NO_CAP, "2027-03-01").refusal).toBe("no_cap");
  });

  it("refuses a start date before the current agreement ends", () => {
    // That would overlap the tenant with themselves and the exclusion
    // constraint would reject it anyway — say so in words first.
    expect(planRenewal(first, HAVEN, "2027-02-01", "2027-02-01").refusal)
      .toBe("not_yet_renewable");
  });

  it("gives every refusal a sentence", () => {
    for (const r of ["no_cap", "already_ended", "not_yet_renewable"] as RenewalRefusal[]) {
      expect(renewalRefusalText(r).length).toBeGreaterThan(20);
    }
  });
});

describe("the long-chain notice", () => {
  it("says nothing about a short chain", () => {
    expect(chainNotice(3)).toBeNull();
    expect(chainNotice(LONG_CHAIN_MONTHS - 1)).toBeNull();
  });

  it("speaks up once a run reaches a year", () => {
    const n = chainNotice(24);
    expect(n).toContain("2 years");
    expect(n).toContain("attorney");
  });

  it("reads correctly for an odd span", () => {
    expect(chainNotice(15)).toContain("1 year and 3 months");
  });
});

describe("daysBetween", () => {
  it("measures a Haven agreement", () => {
    expect(daysBetween("2026-12-15", "2027-03-15")).toBe(90);
    // Every three-month span is under the 31*3+1 guard the database uses.
    for (const s of ["2027-01-31", "2027-02-28", "2027-11-30", "2028-01-31"]) {
      expect(daysBetween(s, addMonths(s, 3))).toBeLessThanOrEqual(94);
    }
  });
});
