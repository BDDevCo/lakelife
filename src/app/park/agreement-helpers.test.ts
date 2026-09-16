import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addMonths, daysBetween, monthsBetween, agreementEnd, planRenewal, chainNotice,
  renewalRefusalText, inheritedRefusalText, LONG_CHAIN_MONTHS, SIGNED_LEASE_LABEL,
  AGREEMENT_LENGTHS, offeredAgreementLengths, agreementMonthsFor, chooseAgreementLength,
  lengthInWords, lengthsInWords, lengthAdjective, lengthNotOfferedText,
  renewalLeadDays, RENEWAL_LEAD_CAP_DAYS, agreementSpanWords, agreementSeasonEnd,
  successorStatus, latestSeqByChain, hasLaterLink, perTermWords, backfillWords, lostMonths,
  type AgreementTerms, type PriorAgreement, type RenewalRefusal, type PlannedRenewal,
} from "./agreement-helpers";
import { parkOpenFor, type ParkSeason } from "@/lib/parks";
import { SIGNED_LEASE_LABEL as LABEL_ON_THE_ROLL } from "./sign-helpers";

/** The Haven: one-month house style under a three-month cap, one deposit per
 *  unbroken chain. The household picks one or three months at every renewal. */
const HAVEN: AgreementTerms = { maxAgreementMonths: 3, defaultAgreementMonths: 1, depositAmount: 400 };
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
  it("ends an agreement the CHOSEN number of months on — one, three or six, never the cap", () => {
    expect(agreementEnd("2026-12-15", 3, HAVEN)).toBe("2027-03-15");
    expect(agreementEnd("2026-12-15", 1, HAVEN)).toBe("2027-01-15");
    expect(agreementEnd("2026-12-15", 6, {})).toBe("2027-06-15");
  });

  it("returns null where the park writes no fixed term", () => {
    expect(agreementEnd("2026-12-15", null, NO_CAP)).toBeNull();
  });

  it("does not read the cap at all — the length is the argument", () => {
    // A cap of three with a chosen length of one ends one month on.
    expect(agreementEnd("2027-01-01", 1, { maxAgreementMonths: 3 } as AgreementTerms)).toBe("2027-02-01");
  });
});

// ---------------------------------------------------------------------------
// THE LENGTHS ON OFFER. The owner's decision: "options for them to have a 1
// month, 3 month or 6 month renew." The standard lengths under the park's
// cap, always including its house style; nothing here knows any park's cap.
// ---------------------------------------------------------------------------
describe("the lengths a park offers", () => {
  it("are one, three, six and twelve months, filtered by the park's cap", () => {
    expect(AGREEMENT_LENGTHS).toEqual([1, 3, 6, 12]);
    // The Haven today: a cap of three offers one or three.
    expect(offeredAgreementLengths(1, 3)).toEqual([1, 3]);
    // The Haven once the cap is raised to six: one, three or six.
    expect(offeredAgreementLengths(1, 6)).toEqual([1, 3, 6]);
    // No cap: all of them.
    expect(offeredAgreementLengths(1, null)).toEqual([1, 3, 6, 12]);
    expect(offeredAgreementLengths(null, 12)).toEqual([1, 3, 6, 12]);
  });

  it("always includes the park's own house style, even off the standard list", () => {
    expect(offeredAgreementLengths(2, 6)).toEqual([1, 2, 3, 6]);
    // A house style over the cap is clamped to it, as the database would.
    expect(offeredAgreementLengths(12, 3)).toEqual([1, 3]);
  });

  it("offers nothing at a park with neither dial — it writes no fixed-length agreement", () => {
    expect(offeredAgreementLengths(null, null)).toEqual([]);
  });

  it("starts the choice on the house style under the cap", () => {
    expect(agreementMonthsFor(1, 3)).toBe(1);
    expect(agreementMonthsFor(null, 3)).toBe(3);
    expect(agreementMonthsFor(12, 3)).toBe(3);
    expect(agreementMonthsFor(1, null)).toBe(1);
    expect(agreementMonthsFor(null, null)).toBeNull();
  });
});

describe("judging a chosen length — the one rule every writing door uses", () => {
  it("accepts a length the park offers, and returns exactly that", () => {
    expect(chooseAgreementLength(1, 1, 3)).toEqual({ ok: true, months: 1 });
    expect(chooseAgreementLength(3, 1, 3)).toEqual({ ok: true, months: 3 });
    expect(chooseAgreementLength(6, 1, 6)).toEqual({ ok: true, months: 6 });
  });

  it("refuses a length the park does not offer, naming the ones it does", () => {
    const r = chooseAgreementLength(6, 1, 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    const r6 = chooseAgreementLength(12, 1, 6);
    expect(!r6.ok && r6.error).toBe("This park writes agreements of 1, 3 or 6 months — pick one of those.");
    // Never the cap by default: a choice of none is refused, not defaulted.
    expect(chooseAgreementLength(2, 1, 3).ok).toBe(false);
  });

  it("refuses a missing choice rather than defaulting it — the screens seed the house style", () => {
    const r = chooseAgreementLength(null, 1, 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("Pick how long the agreement runs — 1 or 3 months.");
    expect(chooseAgreementLength(undefined, 1, 6).ok).toBe(false);
  });

  it("at a park with neither dial the only right answer is no length — the horizon", () => {
    expect(chooseAgreementLength(null, null, null)).toEqual({ ok: true, months: null });
    const r = chooseAgreementLength(3, null, null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/doesn't write fixed-length agreements/);
    expect(lengthNotOfferedText([])).toMatch(/doesn't write fixed-length agreements/);
  });

  it("says a length in words a person reads", () => {
    expect(lengthInWords(1)).toBe("1 month");
    expect(lengthInWords(3)).toBe("3 months");
    expect(lengthsInWords([1, 3, 6])).toBe("1, 3 or 6 months");
    expect(lengthsInWords([1, 3])).toBe("1 or 3 months");
    expect(lengthsInWords([1])).toBe("1 month");
    expect(lengthsInWords([])).toBe("");
    expect(lengthAdjective(1)).toBe("one-month");
    expect(lengthAdjective(6)).toBe("6-month");
  });
});

describe("renewing", () => {
  it("CONSECUTIVE: same chain, next in sequence, and NO second deposit", () => {
    const r = planRenewal(first, HAVEN, "2027-03-01", 3);
    expect(r.ok).toBe(true);
    expect(r.start).toBe("2027-03-15");          // the day the last one ends
    expect(r.end).toBe("2027-06-15");
    expect(r.termMonths).toBe(3);
    expect(r.continuesChain).toBe(true);
    expect(r.nextSeq).toBe(2);
    // THE OWNER'S RULE.
    expect(r.depositDue).toBe(false);
    expect(r.depositAmount).toBeNull();
    expect(r.totalMonthsAfter).toBe(6);
  });

  it("writes the length the household CHOSE — one month on a park capped at three", () => {
    // This planner used to use the cap as the length, so every renewal at
    // The Haven was three months whatever the household wanted.
    const one = planRenewal(first, HAVEN, "2027-03-01", 1);
    expect(one.ok).toBe(true);
    expect(one.start).toBe("2027-03-15");
    expect(one.end).toBe("2027-04-15");
    expect(one.termMonths).toBe(1);
    expect(one.totalMonthsAfter).toBe(4);
  });

  it("offers six months only once the cap allows it, and never twelve at a cap of six", () => {
    const capSix: AgreementTerms = { ...HAVEN, maxAgreementMonths: 6 };
    expect(planRenewal(first, HAVEN, "2027-03-01", 6).refusal).toBe("not_offered");
    const six = planRenewal(first, capSix, "2027-03-01", 6);
    expect(six.ok).toBe(true);
    expect(six.end).toBe("2027-09-15");
    expect(planRenewal(first, capSix, "2027-03-01", 12).refusal).toBe("not_offered");
    // The refusal names what IS offered.
    expect(renewalRefusalText("not_offered", null, [1, 3, 6]))
      .toBe("This park writes agreements of 1, 3 or 6 months — pick one of those.");
  });

  it("A GAP: new chain, back to seq 1, and a deposit IS due", () => {
    // They left in March and came back in June. That is a new tenancy.
    const r = planRenewal(first, HAVEN, "2027-06-01", 3, "2027-06-01");
    expect(r.ok).toBe(true);
    expect(r.continuesChain).toBe(false);
    expect(r.nextSeq).toBe(1);
    expect(r.depositDue).toBe(true);
    expect(r.depositAmount).toBe(400);
    expect(r.totalMonthsAfter).toBe(3);
  });

  it("charges no deposit on a gap when the park takes none", () => {
    const r = planRenewal(first, { maxAgreementMonths: 3, depositAmount: null }, "2027-06-01", 3, "2027-06-01");
    expect(r.depositDue).toBe(false);
  });

  it("chains repeatedly, and the total tracks the whole run's REAL dates", () => {
    let prior = first;
    const ends: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = planRenewal(prior, HAVEN, prior.end, 3);
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
    expect(planRenewal(prior, HAVEN, prior.end, 3).totalMonthsAfter).toBe(27);
  });

  it("counts the months the chain REALLY ran, not seq × cap", () => {
    // The Haven's first signed lease is ONE month (default 1, cap 3). Its
    // renewal is chosen at three. The chain has run 1 month, and after the
    // renewal will have run 4 — not 3 + 3 = 6, which is what multiplying the
    // sequence number by the cap says.
    const jan: PriorAgreement = {
      id: "j", chainId: "c", seq: 1, start: "2027-01-01", end: "2027-02-01",
      quotedAmount: 400, term: "monthly",
    };
    expect(planRenewal(jan, { maxAgreementMonths: 3, depositAmount: null }, "2027-01-20", 3)
      .totalMonthsAfter).toBe(4);

    // Seq 4 after three real one-month links and this one: the caller says 4.
    const fourth: PriorAgreement = { ...jan, seq: 4, start: "2027-04-01", end: "2027-05-01", chainMonthsSoFar: 4 };
    expect(planRenewal(fourth, { maxAgreementMonths: 3, depositAmount: null }, "2027-04-20", 3)
      .totalMonthsAfter).toBe(7);
    // Without the caller's number the prior's own span stands in — never seq × cap.
    expect(planRenewal({ ...fourth, chainMonthsSoFar: undefined }, { maxAgreementMonths: 3, depositAmount: null }, "2027-04-20", 3)
      .totalMonthsAfter).toBe(4);
  });

  it("a season-clamped successor counts its real length, not the one chosen", () => {
    // Sep 1 choosing 3 months, slips out Oct 15: the agreement is 1½ months.
    const r = planRenewal(
      { ...first, start: "2027-06-01", end: "2027-09-01" },
      { maxAgreementMonths: 3, depositAmount: null, seasonEnd: "2027-10-15" },
      "2027-08-20",
      3,
    );
    expect(r.end).toBe("2027-10-15");
    expect(r.totalMonthsAfter).toBe(3 + 1);
    // THE PLAN SAYS SO. The toast and the Today card quoted the CHOSEN length
    // beside the clamped dates — "renewed for 3 months, September 1, 2027 to
    // October 15, 2027" — which is a 1½-month agreement described as three.
    expect(r.cutShortBySeason).toBe(true);
    expect(agreementSpanWords(r)).toBe(
      "3 months, cut short by the season close — September 1, 2027 to October 15, 2027",
    );
  });

  it("an unclamped plan is not 'cut short', and its words quote the length plainly", () => {
    const r = planRenewal(first, HAVEN, "2027-03-01", 3);
    expect(r.cutShortBySeason).toBe(false);
    expect(agreementSpanWords(r)).toBe("3 months, March 15, 2027 to June 15, 2027");
    // A season that ends AFTER the chosen length is no clamp at all.
    const roomy = planRenewal(first, { ...HAVEN, seasonEnd: "2027-11-01" }, "2027-03-01", 1);
    expect(roomy.cutShortBySeason).toBe(false);
    expect(agreementSpanWords(roomy)).toBe("1 month, March 15, 2027 to April 15, 2027");
  });

  it("the span words come from the plan, never from the request", () => {
    // A refused plan has no span to speak of — the caller reads the refusal.
    const refused: PlannedRenewal = { ok: false, refusal: "no_cap" };
    expect(agreementSpanWords(refused)).toBe("");
  });

  it("refuses to renew a park with no fixed term, whatever length is asked for", () => {
    expect(planRenewal(first, NO_CAP, "2027-03-01", 1).refusal).toBe("no_cap");
    expect(planRenewal(first, NO_CAP, "2027-03-01", 3).refusal).toBe("no_cap");
  });

  it("refuses a start date before the current agreement ends", () => {
    // That would overlap the tenant with themselves and the exclusion
    // constraint would reject it anyway — say so in words first.
    expect(planRenewal(first, HAVEN, "2027-02-01", 3, "2027-02-01").refusal)
      .toBe("not_yet_renewable");
  });

  // -------------------------------------------------------------------------
  // THE RULE IS ON THE PLAN. A lapsed agreement is planned consecutively from
  // its own end (the household never left; the successor covers the days
  // since). What cannot be written is a successor that is OVER before it
  // exists. The old guard read `!continuesChain && todayISO > prior.end &&
  // startFrom === undefined` — self-contradictory, so `already_ended` could
  // never return: on 17 June it planned Feb 1 – Mar 1 as ok, the button wrote
  // it, and the card re-listed the lot every morning one month further on.
  // -------------------------------------------------------------------------
  describe("already_ended is judged on the plan's own end", () => {
    const jan: PriorAgreement = { ...first, start: "2027-01-01", end: "2027-02-01" };
    const haven: AgreementTerms = { maxAgreementMonths: 6, defaultAgreementMonths: 1, depositAmount: null };

    it("a short lapse backfills consecutively — 16 February plans Feb 1 to Mar 1", () => {
      const r = planRenewal(jan, haven, "2027-02-16", 1);
      expect(r).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-03-01", continuesChain: true });
    });

    it("refuses a plan that would be over already, with and without a start date", () => {
      // 17 June: one month from 1 February ended 1 March.
      expect(planRenewal(jan, haven, "2027-06-17", 1).refusal).toBe("already_ended");
      expect(planRenewal(jan, haven, "2027-06-17", 3).refusal).toBe("already_ended");
      // A start date passed in changes nothing about the rule: from 1 March,
      // one month is over by 1 April.
      expect(planRenewal(jan, haven, "2027-06-17", 1, "2027-03-01").refusal).toBe("already_ended");
      // And the boundary: a plan ending TODAY is over — checkout was this morning.
      expect(planRenewal(jan, haven, "2027-03-01", 1).refusal).toBe("already_ended");
      expect(planRenewal(jan, haven, "2027-02-28", 1).ok).toBe(true);
    });

    it("but a length that reaches past today is still written — six months from 1 February reaches August", () => {
      const r = planRenewal(jan, haven, "2027-06-17", 6);
      expect(r).toMatchObject({ ok: true, start: "2027-02-01", end: "2027-08-01", continuesChain: true, nextSeq: 2 });
      // A fresh start from a later date is judged the same way.
      const fresh = planRenewal(jan, haven, "2027-06-17", 1, "2027-07-01");
      expect(fresh).toMatchObject({ ok: true, start: "2027-07-01", end: "2027-08-01", continuesChain: false, nextSeq: 1 });
    });

    it("the sentence instructs no door the card lacks, and claims no duration", () => {
      const t = renewalRefusalText("already_ended", "1", [1, 3, 6]);
      expect(t).not.toMatch(/Start a new one/);
      expect(t).toMatch(/nothing to write from here/);
      // One day past the only length a park writes is not "so long ago"; the
      // true claim is about the longest length, run from the end.
      expect(t).not.toMatch(/so long ago/);
      expect(t).toBe(
        "That agreement has run out, and even the longest agreement this park writes, run from its end, would be over already — there's nothing to write from here.",
      );
    });

    describe("lostMonths — the months a backfilled row has already missed", () => {
      // The run visits a month once. A month behind today is one no run
      // will come back for; the current month is too once its run has
      // happened, and the run's own to bill until then.
      it("every month behind today, and the current month only once its run has happened", () => {
        expect(lostMonths("2027-02-01", "2027-03-16", "2027-01-01", false)).toEqual(["2027-02"]);
        expect(lostMonths("2027-02-01", "2027-03-16", "2027-01-01", true)).toEqual(["2027-02", "2027-03"]);
        // Both ways: collapsing the flag either way loses one of these.
        expect(lostMonths("2026-11-01", "2027-03-16", null, false)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
        expect(lostMonths("2026-11-01", "2027-03-16", null, true)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
      });

      it("a row starting in the current month has missed nothing before the run, and the current month after it", () => {
        expect(lostMonths("2027-03-02", "2027-03-16", "2027-01-01", false)).toEqual([]);
        expect(lostMonths("2027-03-02", "2027-03-16", "2027-01-01", true)).toEqual(["2027-03"]);
      });

      it("a row starting today: nothing before the run — and the current month once the run has happened", () => {
        // The honest answer: a run that happened this morning raised every
        // bill it will raise for the month before this row existed.
        expect(lostMonths("2027-03-16", "2027-03-16", "2027-01-01", false)).toEqual([]);
        expect(lostMonths("2027-03-16", "2027-03-16", "2027-01-01", true)).toEqual(["2027-03"]);
      });

      it("a row starting after this month is never behind", () => {
        expect(lostMonths("2027-04-01", "2027-03-16", "2027-01-01", true)).toEqual([]);
        expect(lostMonths("2027-04-01", "2027-03-16", "2027-01-01", false)).toEqual([]);
      });

      it("a month before go-live is never lost — it was never ours", () => {
        expect(lostMonths("2027-02-01", "2027-03-16", "2027-03-01", false)).toEqual([]);
        expect(lostMonths("2027-02-01", "2027-03-16", "2027-03-01", true)).toEqual(["2027-03"]);
        // A cutover mid-month floors at the NEXT month (billing-start's rule).
        expect(lostMonths("2027-01-01", "2027-04-16", "2027-01-15", false)).toEqual(["2027-02", "2027-03"]);
        // No cutover: no floor.
        expect(lostMonths("2027-01-01", "2027-03-16", null, false)).toEqual(["2027-01", "2027-02"]);
      });

      it("ascending, so money on account settles the oldest bill first", () => {
        const months = lostMonths("2026-10-01", "2027-03-16", null, true);
        expect(months).toEqual([...months].sort());
        expect(months[0]).toBe("2026-10");
      });
    });

    describe("backfillWords — the money fact of a successor written from the past", () => {
      /** A monthly row with a rent — the shape both promises are true of. */
      const PRICED = { quotedAmount: 400, term: "monthly", lotNumber: "9" };
      it("names the months the tap will bill, for THIS ROW, in words", () => {
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02", "2027-03"], PRICED)).toBe(
          "Writing it bills this agreement for February 2027 and March 2027 — nothing has billed it for those months yet.",
        );
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], PRICED)).toBe(
          "Writing it bills this agreement for February 2027 — nothing has billed it for that month yet.",
        );
      });

      it("is worded for the row, never for the month — the prior's prorated bill for the same month is not denied", () => {
        // A consecutive renewal written on the 25th for an agreement that
        // ended on the 20th: the 1st to the 19th ARE billed, on the prior
        // row. "nothing has billed that month" would be false.
        const words = backfillWords("2027-03-20", "2027-03-25", ["2027-03"], PRICED)!;
        expect(words).toMatch(/this agreement/);
        expect(words).toMatch(/nothing has billed it for/);
        expect(words).not.toMatch(/nothing has billed that month/);
        expect(words).not.toMatch(/nothing has billed those months/);
      });

      it("with nothing missed, the current month is the run's — said with the day it reaches back to", () => {
        expect(backfillWords("2027-03-02", "2027-03-16", [], PRICED)).toBe(
          "It reaches back to March 2, 2027; March 2027 bills when you bill the month.",
        );
      });

      it("nothing for a successor that starts today or later with nothing missed — no fact to state", () => {
        expect(backfillWords("2027-02-01", "2027-02-01", [], PRICED)).toBeNull();
        expect(backfillWords("2027-02-01", "2027-01-20", [], PRICED)).toBeNull();
        // But a month the tap WILL bill is said whatever the start: a row
        // from the 20th written on the 5th, after the run, bills the 20th on.
        expect(backfillWords("2027-03-20", "2027-03-05", ["2027-03"], PRICED)).toMatch(/^Writing it bills this agreement for March 2027/);
      });

      // "IF THERE IS ANY" — the re-raise refuses two rows the way the run
      // does, and the card used to promise the months over both.
      it("a row with NO RENT promises nothing — it names the door on the same card, in every branch", () => {
        const none = { quotedAmount: null, term: "monthly", lotNumber: "9" };
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02", "2027-03"], none)).toBe(
          "No rent is set, so writing it can't bill February 2027 and March 2027 — use Renew at a new rent and type what they pay.",
        );
        // The other promise — "bills when you bill the month" — is as false
        // with no rent: the run lists the row under "no rent set".
        expect(backfillWords("2027-03-02", "2027-03-16", [], none)).toBe(
          "It reaches back to March 2, 2027, but no rent is set, so March 2027 won't bill from it — use Renew at a new rent and type what they pay.",
        );
        expect(backfillWords("2027-04-01", "2027-03-16", [], none)).toBe(
          "No rent is set, so nothing bills from it — use Renew at a new rent and type what they pay.",
        );
        for (const w of [
          backfillWords("2027-02-01", "2027-03-16", ["2027-02"], none),
          backfillWords("2027-03-02", "2027-03-16", [], none),
        ]) {
          expect(w).not.toMatch(/Writing it bills/);
          expect(w).not.toMatch(/bills when you bill the month/);
        }
        // Collapsed the other way: the same dates with a rent keep the promise.
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], { ...none, quotedAmount: 400 })).toMatch(/^Writing it bills this agreement for February 2027/);
      });

      it("a row filed as paid some other way than monthly promises nothing — the run's own sentence, which knows a nightly home is priced per stay", () => {
        // The successor copies the prior's term (successor-row), so a
        // yearly prior makes a yearly successor and the run bills months
        // only. The instruction is ledger-helpers' ONE spelling: Edit on the
        // roll for a yearly or seasonal row; NO door for a nightly one.
        const yearly = { quotedAmount: 3300, term: "annual", lotNumber: "9" };
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], yearly)).toBe(
          "Writing it won't bill February 2027: Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.",
        );
        expect(backfillWords("2027-03-02", "2027-03-16", [], yearly)).toBe(
          "It reaches back to March 2, 2027, and nothing bills from it as filed: Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.",
        );
        expect(backfillWords("2027-04-01", "2027-03-16", [], yearly)).toBeNull();
        const nightly = backfillWords("2027-02-01", "2027-03-16", ["2027-02"], { ...yearly, term: "nightly" })!;
        expect(nightly).toContain("priced per stay, not by the month");
        expect(nightly).not.toMatch(/Edit on the roll/);
        expect(nightly).not.toMatch(/monthly rent/);
        // The term is judged before the rent, as the run judges it.
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], { ...yearly, quotedAmount: null })).toMatch(/^Writing it won't bill February 2027: Lot 9 is filed as paid yearly/);
        // Collapsed the other way: monthly keeps the promise; an absent term reads as monthly.
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], { ...yearly, term: "monthly" })).toMatch(/^Writing it bills this agreement/);
        expect(backfillWords("2027-02-01", "2027-03-16", ["2027-02"], { ...yearly, term: null })).toMatch(/^Writing it bills this agreement/);
      });

      it("never an ISO month or day", () => {
        expect(backfillWords("2027-02-01", "2027-06-17", ["2027-02", "2027-03", "2027-04", "2027-05"], PRICED)).not.toMatch(/\d{4}-\d{2}/);
        expect(backfillWords("2027-03-02", "2027-03-16", [], PRICED)).not.toMatch(/\d{4}-\d{2}/);
      });
    });

    it("the dead clause is gone from the source", () => {
      const src = readFileSync(fileURLToPath(new URL("./agreement-helpers.ts", import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src).not.toMatch(/startFrom === undefined/);
      expect(src).toMatch(/if \(end <= todayISO\) \{\s*return \{ ok: false, refusal: "already_ended" \};/);
    });
  });

  it("gives every refusal a sentence", () => {
    const all: Record<RenewalRefusal, true> = {
      no_cap: true, not_offered: true, already_ended: true, not_yet_renewable: true, season_closed: true, inherited: true, moved_out: true,
    };
    for (const r of Object.keys(all) as RenewalRefusal[]) {
      expect(renewalRefusalText(r, null, [1, 3]).length).toBeGreaterThan(20);
    }
  });

  it("'not offered' never says the park writes no fixed-length agreements — that refusal exists only when the cap is SET", () => {
    // With a defaulted `offered = []` the not_offered sentence read "This park
    // doesn't write fixed-length agreements…" — false for the one situation
    // that yields not_offered. The list is required now; the caller has it.
    expect(renewalRefusalText("not_offered", null, [1, 3]))
      .toBe("This park writes agreements of 1 or 3 months — pick one of those.");
    const src = readFileSync(fileURLToPath(new URL("./agreement-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/offered: number\[\],\s*\): string \{/);
    expect(src).not.toMatch(/offered: number\[\] = \[\]/);
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

describe("how far ahead an agreement is asked for renewal (R2)", () => {
  // THE LEAD IS A FUNCTION OF THE AGREEMENT'S OWN SPAN: its last half, capped
  // at 45 days. A flat 45 days listed every one-month agreement from the
  // morning it was written — he tapped Renew, the toast said "renewed", and
  // the household reappeared in the same list reading the new end date, as
  // if the tap had not taken. On 1 January all 21 one-month leases would sit
  // in "Agreements to write" from the day they were signed.
  it("a one-month agreement is asked in its last ~15 days", () => {
    expect(renewalLeadDays("2027-02-01", "2027-03-01")).toBe(14); // 28 days
    expect(renewalLeadDays("2027-01-01", "2027-02-01")).toBe(16); // 31 days — the odd day goes to the lead
    expect(renewalLeadDays("2027-04-01", "2027-05-01")).toBe(15); // 30 days
  });

  it("a three-month agreement is asked 45 days ahead — the cap", () => {
    expect(RENEWAL_LEAD_CAP_DAYS).toBe(45);
    expect(renewalLeadDays("2027-02-01", "2027-05-01")).toBe(45); // 89 days
    expect(renewalLeadDays("2027-06-01", "2027-09-01")).toBe(45); // 92 days
    expect(renewalLeadDays("2027-01-01", "2027-07-01")).toBe(45); // six months
  });

  it("a shorter cap is honoured, and a span with no days has no lead", () => {
    expect(renewalLeadDays("2027-02-01", "2027-05-01", 30)).toBe(30);
    expect(renewalLeadDays("2027-02-01", "2027-02-01")).toBe(0);
    expect(renewalLeadDays("2027-02-01", "2027-02-02")).toBe(1);
    expect(renewalLeadDays("2027-02-01", "2027-02-03")).toBe(1);
    // Never negative for a range the database would refuse anyway.
    expect(renewalLeadDays("2027-02-03", "2027-02-01")).toBe(0);
  });

  it("a just-written one-month successor is NOT yet due: its lead is inside its own second half", () => {
    // Written on 1 February for 1 February – 1 March: due from 15 February.
    const lead = renewalLeadDays("2027-02-01", "2027-03-01");
    expect(daysBetween("2027-02-01", "2027-03-01") - lead).toBeGreaterThan(0);
    expect(addMonths("2027-02-01", 0)).toBe("2027-02-01");
    // Day 14 of 28 is the first morning it lists (28 - 14 = 14 days left).
    expect(daysBetween("2027-02-15", "2027-03-01")).toBe(lead);
  });
});

describe("agreementSeasonEnd — the one checkout morning a season sets, for BOTH doors", () => {
  // The owner's Renew button computed this inline (the close DAY, in the
  // start's year) and the resident's texted link never computed it at all —
  // so on a slip lot the two doors wrote different rows for one choice.
  // Both now read this. The close day is the LAST NIGHT, as the booking gate
  // (parkOpenFor) and seasonEndAfter already have it: a lot that closes
  // 15 October sells the night of the 15th, and its agreements end the
  // morning of the 16th.
  const SLIPS: ParkSeason = { openMonth: 4, openDay: 15, closeMonth: 10, closeDay: 15 };
  const WINTER: ParkSeason = { openMonth: 11, openDay: 1, closeMonth: 3, closeDay: 31 };
  const YEAR_ROUND: ParkSeason = { openMonth: null, openDay: null, closeMonth: null, closeDay: null };

  it("is the morning after the close day — the night of the close is sold", () => {
    expect(agreementSeasonEnd("2027-09-01", SLIPS)).toBe("2027-10-16");
    // The booking gate agrees: a stay through that morning is inside the season.
    expect(parkOpenFor(SLIPS, { start: "2027-09-01", end: "2027-10-16" })).toBe(true);
    expect(parkOpenFor(SLIPS, { start: "2027-09-01", end: "2027-10-17" })).toBe(false);
  });

  it("is THIS season's end even once it has passed, so a start after the close is refused, not planned", () => {
    // Not seasonEndAfter's answer (next year's close): planRenewal reads
    // start >= seasonEnd as season_closed, and a renewal from 1 November
    // must hit 16 October, not 16 October of next year.
    expect(agreementSeasonEnd("2027-11-01", SLIPS)).toBe("2027-10-16");
    const r = planRenewal(
      { ...first, start: "2027-08-01", end: "2027-11-01" },
      { maxAgreementMonths: 3, depositAmount: null, seasonEnd: agreementSeasonEnd("2027-11-01", SLIPS) },
      "2027-10-01", 1,
    );
    expect(r.refusal).toBe("season_closed");
  });

  it("a window that wraps the New Year closes in the year after the open the start sits in", () => {
    expect(agreementSeasonEnd("2027-12-01", WINTER)).toBe("2028-04-01");
    expect(agreementSeasonEnd("2028-02-01", WINTER)).toBe("2028-04-01");
    // June is outside a November–March window: its end is the April already gone.
    expect(agreementSeasonEnd("2027-06-01", WINTER)).toBe("2027-04-01");
  });

  it("is null for a year-round lot — nothing to clamp to", () => {
    expect(agreementSeasonEnd("2027-09-01", YEAR_ROUND)).toBeNull();
    expect(agreementEnd("2027-09-01", 3, { seasonEnd: agreementSeasonEnd("2027-09-01", YEAR_ROUND) })).toBe("2027-12-01");
  });

  it("clamps a three-month September slip agreement to six weeks, and the plan says so", () => {
    const r = planRenewal(
      { ...first, start: "2027-06-01", end: "2027-09-01" },
      { maxAgreementMonths: 3, depositAmount: null, seasonEnd: agreementSeasonEnd("2027-09-01", SLIPS) },
      "2027-08-20", 3,
    );
    expect(r).toMatchObject({ ok: true, start: "2027-09-01", end: "2027-10-16", cutShortBySeason: true });
    expect(agreementSpanWords(r)).toBe("3 months, cut short by the season close — September 1, 2027 to October 16, 2027");
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

  it("every offered length fits under the cap trigger's cap*31+1 guard, at every cap", () => {
    // 0065 refuses span_days > cap*31+1. A six-month agreement is at most
    // 184 days (≤ 187 at a cap of six); the guard reads the CAP, so a
    // shorter chosen length is always inside it.
    for (const cap of [1, 3, 6, 12]) {
      for (const months of offeredAgreementLengths(1, cap)) {
        for (const s of ["2027-01-31", "2027-02-28", "2027-07-01", "2027-11-30", "2028-01-31"]) {
          expect(daysBetween(s, addMonths(s, months)), `${months}mo from ${s} at cap ${cap}`)
            .toBeLessThanOrEqual(cap * 31 + 1);
        }
      }
    }
  });
});

describe("the successor's status — one rule for both doors", () => {
  it("approved until it starts, active from its first morning", () => {
    expect(successorStatus("2027-02-01", "2027-01-20")).toBe("approved");
    expect(successorStatus("2027-02-01", "2027-02-01")).toBe("active");
    // A lapsed agreement backfilled from its own end has already started.
    expect(successorStatus("2027-02-01", "2027-02-16")).toBe("active");
  });
});

describe("a chain's later links — the predicate the owner's list and the nightly share", () => {
  const rows = [
    { agreement_chain_id: "chain-a", agreement_seq: 1 },
    { agreement_chain_id: "chain-a", agreement_seq: 2 },
    { agreement_chain_id: "chain-b", agreement_seq: 1 },
    { agreement_chain_id: null, agreement_seq: 1 },
  ];
  it("knows which chains already have their next agreement written", () => {
    const maxSeq = latestSeqByChain(rows);
    expect(maxSeq.get("chain-a")).toBe(2);
    expect(maxSeq.get("chain-b")).toBe(1);
    expect(hasLaterLink(rows[0], maxSeq)).toBe(true);
    expect(hasLaterLink(rows[1], maxSeq)).toBe(false);
    expect(hasLaterLink(rows[2], maxSeq)).toBe(false);
    // No chain id: nothing to compare against.
    expect(hasLaterLink(rows[3], maxSeq)).toBe(false);
    // A missing seq reads as 1.
    expect(hasLaterLink({ agreement_chain_id: "chain-a" }, maxSeq)).toBe(true);
  });
});

describe("the words after a rent figure", () => {
  it("come from the term, and an unknown term gets none", () => {
    expect(perTermWords("monthly")).toBe("a month");
    expect(perTermWords("weekly")).toBe("a week");
    expect(perTermWords("nightly")).toBe("a night");
    expect(perTermWords("annual")).toBe("a year");
    expect(perTermWords("seasonal")).toBe("for the season");
    expect(perTermWords(null)).toBe("");
    expect(perTermWords("quarterly")).toBe("");
  });
});
