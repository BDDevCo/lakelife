import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addMonths, daysBetween, monthsBetween, agreementEnd, planRenewal, chainNotice,
  renewalRefusalText, inheritedRefusalText, LONG_CHAIN_MONTHS, SIGNED_LEASE_LABEL,
  type AgreementTerms, type PriorAgreement, type RenewalRefusal,
} from "./agreement-helpers";
import { SIGNED_LEASE_LABEL as LABEL_ON_THE_ROLL } from "./sign-helpers";

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

  it("chains repeatedly, and the total tracks the whole run's REAL dates", () => {
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
        // The caller that has the chain passes its real running length.
        chainMonthsSoFar: r.totalMonthsAfter,
      };
    }
    // Eight consecutive three-month agreements = two years on the lot.
    expect(prior.seq).toBe(8);
    expect(ends.at(-1)).toBe("2028-12-15");
    expect(planRenewal(prior, HAVEN, prior.end).totalMonthsAfter).toBe(27);
  });

  it("counts the months the chain REALLY ran, not seq × cap", () => {
    // The Haven's first signed lease is ONE month (default 1, cap 3). Its
    // renewal is written at the cap. The chain has run 1 month, and after the
    // renewal will have run 4 — not 3 + 3 = 6, which is what multiplying the
    // sequence number by the cap says.
    const jan: PriorAgreement = {
      id: "j", chainId: "c", seq: 1, start: "2027-01-01", end: "2027-02-01",
      quotedAmount: 400, term: "monthly",
    };
    expect(planRenewal(jan, { maxAgreementMonths: 3, depositAmount: null }, "2027-01-20")
      .totalMonthsAfter).toBe(4);

    // Seq 4 after three real one-month links and this one: the caller says 4.
    const fourth: PriorAgreement = { ...jan, seq: 4, start: "2027-04-01", end: "2027-05-01", chainMonthsSoFar: 4 };
    expect(planRenewal(fourth, { maxAgreementMonths: 3, depositAmount: null }, "2027-04-20")
      .totalMonthsAfter).toBe(7);
    // Without the caller's number the prior's own span stands in — never seq × cap.
    expect(planRenewal({ ...fourth, chainMonthsSoFar: undefined }, { maxAgreementMonths: 3, depositAmount: null }, "2027-04-20")
      .totalMonthsAfter).toBe(4);
  });

  it("a season-clamped successor counts its real length, not the cap", () => {
    // Sep 1 at a 3-month cap, slips out Oct 15: the agreement is 1½ months.
    const r = planRenewal(
      { ...first, start: "2027-06-01", end: "2027-09-01" },
      { maxAgreementMonths: 3, depositAmount: null, seasonEnd: "2027-10-15" },
      "2027-08-20",
    );
    expect(r.end).toBe("2027-10-15");
    expect(r.totalMonthsAfter).toBe(3 + 1);
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
    const all: Record<RenewalRefusal, true> = {
      no_cap: true, already_ended: true, not_yet_renewable: true, season_closed: true, inherited: true,
    };
    for (const r of Object.keys(all) as RenewalRefusal[]) {
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

describe("monthsBetween", () => {
  it("counts whole months by real calendar arithmetic", () => {
    expect(monthsBetween("2027-01-01", "2027-02-01")).toBe(1);
    expect(monthsBetween("2026-12-15", "2027-03-15")).toBe(3);
    expect(monthsBetween("2027-01-31", "2027-02-28")).toBe(1);   // clamped month
    expect(monthsBetween("2027-01-01", "2028-01-01")).toBe(12);
  });

  it("rounds a remainder to the nearest month, and never goes negative", () => {
    expect(monthsBetween("2027-09-01", "2027-10-15")).toBe(1);   // 1 month 14 days
    expect(monthsBetween("2027-09-01", "2027-10-16")).toBe(2);   // 1 month 15 days
    expect(monthsBetween("2027-09-01", "2027-09-10")).toBe(0);
    expect(monthsBetween("2027-09-01", "2027-08-01")).toBe(0);
  });
});

describe("the inherited-household refusal", () => {
  it("names the lot and the roll's control, and never a button this screen lacks", () => {
    expect(inheritedRefusalText("14")).toBe(
      "Lot 14 is still on the arrangement they had with the previous owner. When they " +
      "sign your new lease, record it from their row on the rent roll — 'They signed the new lease'.",
    );
  });

  it("without a lot number it still names a household, never 'Lot undefined'", () => {
    for (const none of [null, undefined, ""]) {
      expect(inheritedRefusalText(none)).toMatch(/^This household is still on the arrangement/);
      expect(inheritedRefusalText(none)).toContain("'They signed the new lease'");
    }
  });

  it("names the control from its one home, never a retyped copy of the words", () => {
    // The words are a BUTTON's label on the rent roll. Retyped here, the
    // sentence would outlive a renamed control and send him to a button the
    // screen lacks. So the constant is the sentence's source, and the file
    // holds the literal exactly once — in the constant's own definition.
    expect(SIGNED_LEASE_LABEL).toBe("They signed the new lease");
    expect(inheritedRefusalText(null)).toContain(`'${SIGNED_LEASE_LABEL}'`);
    const src = readFileSync(fileURLToPath(new URL("./agreement-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src, "the scanner is reading the helpers").toContain("export function inheritedRefusalText");
    expect(src.match(/They signed the new lease/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/export const SIGNED_LEASE_LABEL = "They signed the new lease"/);
    expect(src).toMatch(/— '\$\{SIGNED_LEASE_LABEL\}'\./);
  });

  it("and the roll's screens, which import the label from sign-helpers, render the same words", () => {
    // sign-helpers imports addMonths from this file, so this file cannot
    // import the label back without a cycle; until sign-helpers re-exports
    // this constant, the two are pinned equal here so they cannot drift.
    expect(LABEL_ON_THE_ROLL).toBe(SIGNED_LEASE_LABEL);
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
