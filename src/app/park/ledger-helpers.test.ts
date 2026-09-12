import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  ledgerState, balanceOf, toRows, summarise, ledgerHeadline,
  planRun, runSummary, daysBetween, classifyForRun, notMonthlySentence,
  prettyMonth, shiftMonth, dueDayFor, nothingToBillReason, lotList,
  handKeyedRefusal, HAND_KEYED, PROCESSOR_ONLY, paymentAmountRefusal, perStayTerm,
  type Charge, type RunCandidate,
} from "./ledger-helpers";
import { buildStatement } from "./statement-helpers";
import { EDITABLE_TERMS } from "./park-helpers";

const TODAY = "2027-03-10";

const charge = (over: Partial<Charge> = {}): Charge => ({
  id: "c1", lotNumber: "1", renterName: "Wexler, Donna",
  periodMonth: "2027-03", dueOn: "2027-03-01",
  amount: 455, paidTotal: 0, status: "open", ...over,
});

describe("THE FALSE-ALARM PROBLEM", () => {
  it("does NOT call a charge late inside the office's catch-up window", () => {
    // Due the 1st, today is the 10th, office runs 14 days behind. Eleven
    // households who paid on Tuesday must not appear as delinquent — an owner
    // who learns the overdue list is usually wrong stops reading it.
    expect(ledgerState(charge(), TODAY, 14)).toBe("due");
  });

  it("calls it late once the window has passed", () => {
    expect(ledgerState(charge(), TODAY, 3)).toBe("late");
  });

  it("honours a same-day office with no lag at all", () => {
    expect(ledgerState(charge(), TODAY, 0)).toBe("late");
    // ...but not before it is even due.
    expect(ledgerState(charge({ dueOn: "2027-03-20" }), TODAY, 0)).toBe("due");
  });

  it("is never late when it is not yet due", () => {
    expect(ledgerState(charge({ dueOn: "2027-04-01" }), TODAY, 0)).toBe("due");
  });
});

describe("states", () => {
  it("paid in full", () => {
    expect(ledgerState(charge({ paidTotal: 455 }), TODAY, 0)).toBe("paid");
  });

  it("part paid is not late while inside the window", () => {
    expect(ledgerState(charge({ paidTotal: 200 }), TODAY, 14)).toBe("part_paid");
  });

  it("part paid IS late once past it — a partial payment doesn't buy time", () => {
    expect(ledgerState(charge({ paidTotal: 200 }), TODAY, 3)).toBe("late");
  });

  it("overpayment is a credit, not a paid charge", () => {
    const c = charge({ paidTotal: 500 });
    expect(balanceOf(c)).toBe(-45);
    expect(ledgerState(c, TODAY, 0)).toBe("credit");
  });

  it("a voided charge stays void however much arrives against it", () => {
    expect(ledgerState(charge({ status: "void", paidTotal: 455 }), TODAY, 0)).toBe("void");
  });
});

describe("the roll-up", () => {
  const rows = toRows([
    charge({ id: "a", paidTotal: 455 }),
    charge({ id: "b", paidTotal: 0 }),
    charge({ id: "c", paidTotal: 200 }),
    charge({ id: "d", status: "void", amount: 455 }),
  ], TODAY, 3);

  it("leaves a cancelled charge out of the billed total", () => {
    // Counting it would overstate the roll and make every collection rate wrong.
    const s = summarise(rows);
    expect(s.billed).toBe(1365);      // 3 × 455, not 4
    expect(s.collected).toBe(655);
    expect(s.outstanding).toBe(710);
  });

  it("counts only what is GENUINELY late, not everything unpaid", () => {
    const s = summarise(rows);
    expect(s.lateCount).toBe(2);
    expect(s.lateAmount).toBe(710);

    const forgiving = summarise(toRows(rows, TODAY, 30));
    expect(forgiving.lateCount).toBe(0);
    expect(forgiving.dueCount).toBe(2);
  });

  it("leads with late, and says nothing about it when nothing is", () => {
    expect(ledgerHeadline(summarise(rows), 3)).toMatch(/2 households are late/);
    // An empty state reading "0 late" trains an owner to skim past the number
    // on the day it isn't zero.
    const clean = summarise(toRows([charge({ paidTotal: 455 })], TODAY, 3));
    expect(ledgerHeadline(clean, 3)).toMatch(/everything's in/i);
    expect(ledgerHeadline(clean, 3)).not.toMatch(/late/i);
  });

  it("explains the grace when money is outstanding but nothing is late", () => {
    const s = summarise(toRows([charge({ paidTotal: 100 })], TODAY, 30));
    expect(ledgerHeadline(s, 30)).toMatch(/30 days for the office/);
  });

  it("says so plainly before anything is billed", () => {
    expect(ledgerHeadline(summarise([]), 3)).toMatch(/nothing billed yet/i);
  });
});

describe("the charge run", () => {
  const candidates = [
    { reservationId: "r1", lotNumber: "1", amount: 455 },
    { reservationId: "r2", lotNumber: "2", amount: 455 },
    { reservationId: "r3", lotNumber: "13B", amount: null },
  ];

  it("skips a household with no rent set rather than billing zero", () => {
    // Billing it as zero hides the problem behind a paid charge.
    const p = planRun(candidates, new Set(), "2027-03");
    expect(p.toBill).toHaveLength(2);
    expect(p.noRent).toEqual(["13B"]);
    expect(p.total).toBe(910);
    expect(runSummary(p, "2027-03")).toMatch(/1 skipped — no rent set/);
  });

  it("adds NOTHING on a second run", () => {
    // The unique constraint enforces this anyway, but he should see zero
    // rather than trust it.
    const p = planRun(candidates, new Set(["r1", "r2"]), "2027-03");
    expect(p.toBill).toHaveLength(0);
    expect(p.skippedAlreadyBilled).toBe(2);
    // The one thing still to DO is named ahead of the two already done.
    expect(runSummary(p, "2027-03")).toMatch(/no rent is set on lot 13B/);
    // And with nothing else to say, "already raised" is the whole answer.
    expect(runSummary(planRun(candidates.slice(0, 2), new Set(["r1", "r2"]), "2027-03"), "2027-03"))
      .toBe("Nothing to bill for March 2027 — 2 bills are already raised.");
  });

  it("bills a clean park in one go", () => {
    const p = planRun(candidates.slice(0, 2), new Set(), "2027-03");
    expect(runSummary(p, "2027-03")).toBe("Bill 2 households for March 2027 — $910.00");
  });
});

// ---------------------------------------------------------------------------
// THE MORNING EVERY AGREEMENT ENDS.
//
// Eighteen households filed on 1 January 2027 under default_agreement_months
// = 1 hold [2027-01-01, 2027-02-01). On 1 February the preview built each
// statement, got a total of 0 (the stay covers no day of February), collapsed
// that to `amount: null`, and planRun counted all eighteen as "no rent set" —
// on a park where every rent is $400. The button that would have reached the
// run's honest sentence was disabled because toBill was empty.
//
// These go through the REAL statement builder, exactly as previewChargeRun
// does, so the candidate is the assembly and not a copy of it.
// ---------------------------------------------------------------------------
describe("the morning every one-month agreement lapses", () => {
  const HAVEN = ["1", "2", "6", "7", "9", "10", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "26"];
  const FEB = "2027-02";
  const RENT = 400;
  const FEE = { label: "Grounds", amount: 142.53, cadence: "monthly" };

  /** A candidate built the way previewChargeRun builds one. */
  const candidate = (
    id: string, lot: string, stay: { start: string; end: string },
    over: { rent?: number | null; term?: string; status?: string } = {},
  ): RunCandidate => {
    const st = buildStatement({
      month: FEB, stay, rent: over.rent === undefined ? RENT : over.rent,
      fees: [FEE], dueDay: 1,
    });
    return {
      reservationId: id, lotNumber: lot, amount: st.total, range: stay,
      term: over.term ?? "monthly", status: over.status ?? "active",
    };
  };

  const JAN = { start: "2027-01-01", end: "2027-02-01" };
  const FEB_TERM = { start: "2027-02-01", end: "2027-03-01" };
  const priors = HAVEN.map((lot, i) => candidate(`jan-${i}`, lot, JAN));

  it("none renewed: names the cause, and the button has nothing to raise", () => {
    const p = planRun(priors, new Set(), FEB);
    expect(p.toBill).toHaveLength(0);
    expect(p.expired).toEqual(HAVEN);
    expect(p.noRent).toEqual([]);
    const s = runSummary(p, FEB);
    expect(s).toBe(
      "Nothing to bill for February 2027 — 18 agreements have run out (lot 1, lot 2, lot 6 and 15 more). " +
      "Nobody moved out; the paperwork ended. Renew them and run this again.",
    );
    expect(s).not.toMatch(/no rent/);
  });

  it("ten renewed: bills ten and says the other eight ran out", () => {
    const renewed = HAVEN.slice(0, 10).map((lot, i) => candidate(`feb-${i}`, lot, FEB_TERM));
    const p = planRun([...priors, ...renewed], new Set(), FEB);
    expect(p.toBill).toHaveLength(10);
    expect(p.total).toBe(5425.3);
    // The ten renewed lots' January rows are NOT "run out" — their paperwork
    // was renewed. Only the eight nobody renewed are named.
    expect(p.expired).toEqual(HAVEN.slice(10));
    expect(runSummary(p, FEB)).toBe(
      "Bill 10 households for February 2027 — $5425.30 · 8 agreements have run out",
    );
  });

  it("all renewed: no skip count at all", () => {
    const renewed = HAVEN.map((lot, i) => candidate(`feb-${i}`, lot, FEB_TERM));
    const p = planRun([...priors, ...renewed], new Set(), FEB);
    expect(p.toBill).toHaveLength(18);
    expect(p.expired).toEqual([]);
    expect(runSummary(p, FEB)).toBe("Bill 18 households for February 2027 — $9765.54");
  });

  it("a prior term whose successor is ALREADY billed is not run out either", () => {
    // Second run of the month: the successor's charge exists, the January row
    // is still active (renewals never end the prior row). Every later run
    // used to name it, forever.
    const renewed = HAVEN.map((lot, i) => candidate(`feb-${i}`, lot, FEB_TERM));
    const p = planRun([...priors, ...renewed], new Set(renewed.map((r) => r.reservationId)), FEB);
    expect(p.toBill).toHaveLength(0);
    expect(p.expired).toEqual([]);
    expect(p.skippedAlreadyBilled).toBe(18);
    expect(runSummary(p, FEB)).toMatch(/18 bills are already raised/);
  });

  it("somebody who moved out is not paperwork running out", () => {
    // An ended tenancy whose window was trimmed to the move-out day. "Nobody
    // moved out; the paperwork ended" is false about her, so she is in no
    // bucket at all.
    const left = candidate("gone", "27", { start: "2026-06-01", end: "2026-11-15" }, { status: "ended" });
    const p = planRun([...priors.slice(0, 2), left], new Set(), FEB);
    expect(p.expired).toEqual(["1", "2"]);
    expect(classifyForRun(left, FEB, new Set())).toBe("movedOut");
  });

  it("no rent set is still its own cause, with its own lot", () => {
    const blank = candidate("blank", "28", FEB_TERM, { rent: null });
    const p = planRun([...priors.slice(0, 1), blank], new Set(), FEB);
    expect(p.noRent).toEqual(["28"]);
    expect(p.expired).toEqual(["1"]);
    expect(runSummary(p, FEB)).toMatch(/run out/);
  });

  it("a tenancy not started yet is told apart from one that ended", () => {
    const later = candidate("mar", "28", { start: "2027-03-01", end: "2027-04-01" });
    const p = planRun([later], new Set(), FEB);
    expect(p.notYet).toEqual(["28"]);
    expect(p.expired).toEqual([]);
    expect(runSummary(p, FEB)).toBe("Nothing to bill for February 2027 — lot 28 starts after this month.");
  });

  it("the successor rule collapses both ways", () => {
    // Pin the branch, not its absence: with the successor the prior is
    // covered; without it the prior is named. Both halves must hold.
    const prior = candidate("p", "9", JAN);
    const succ = candidate("s", "9", FEB_TERM);
    expect(planRun([prior], new Set(), FEB).expired).toEqual(["9"]);
    expect(planRun([prior, succ], new Set(), FEB).expired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FILED AS PAID SOME OTHER WAY THAN MONTHLY.
//
// `lot_reservations.term` can be annual, seasonal, weekly or nightly, and
// `quoted_amount` is then a rate for THAT term. Neither charge path read the
// column: an application filed at $3,600 a year previewed and billed $3,600
// for January. The run bills months, so anything else is a question for him,
// named by lot, never a bill.
// ---------------------------------------------------------------------------
describe("a tenancy the monthly run cannot bill", () => {
  const FEB = "2027-02";
  const FEB_TERM = { start: "2027-02-01", end: "2027-03-01" };
  const yearly: RunCandidate = {
    reservationId: "y", lotNumber: "9", amount: 3600, range: FEB_TERM, term: "annual", status: "active",
  };
  const monthly: RunCandidate = {
    reservationId: "m", lotNumber: "1", amount: 542.53, range: FEB_TERM, term: "monthly", status: "active",
  };

  it("is not billed its yearly figure as a month", () => {
    const p = planRun([yearly, monthly], new Set(), FEB);
    expect(p.toBill.map((b) => b.lotNumber)).toEqual(["1"]);
    expect(p.notMonthly).toEqual([{ lotNumber: "9", term: "annual" }]);
    expect(p.total).toBe(542.53);
  });

  it("is named on screen, with what to do", () => {
    const p = planRun([yearly, monthly], new Set(), FEB);
    expect(runSummary(p, FEB)).toBe("Bill 1 household for February 2027 — $542.53 · 1 not paid monthly");
    expect(notMonthlySentence(p.notMonthly))
      .toBe("Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.");
  });

  it("alone, it is the whole reason nothing was billed", () => {
    const p = planRun([yearly], new Set(), FEB);
    expect(runSummary(p, FEB)).toBe(
      "Nothing to bill for February 2027 — Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.",
    );
  });

  it("a nightly home is not told to set a monthly rent", () => {
    expect(notMonthlySentence([{ lotNumber: "3", term: "nightly" }]))
      .toBe("Lot 3 is filed as paid nightly — the run bills months only; it's priced per stay, not by the month.");
  });

  it("'priced per stay' is ONE predicate, read by the sentence and by the rent screen's link", () => {
    // The sentence and ParkRent's "Open the rent roll" guard each spelled
    // `nightly || weekly` themselves; a term added to one and not the other
    // prints "it's priced per stay" followed by a link to change its monthly
    // rent. Both now read perStayTerm.
    expect(perStayTerm("nightly")).toBe(true);
    expect(perStayTerm("weekly")).toBe(true);
    for (const t of ["monthly", "annual", "seasonal", ""]) expect(perStayTerm(t), t).toBe(false);
    // Comments stripped: the doc above perStayTerm names the terms in prose.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const helpers = read("./ledger-helpers.ts");
    const at = helpers.indexOf("export function notMonthlySentence(");
    expect(at).toBeGreaterThan(0);
    const body = helpers.slice(at, helpers.indexOf("\nexport function", at + 10));
    expect(body).toMatch(/perStayTerm\(term\)/);
    expect(body).not.toMatch(/"nightly"/);
    const rent = read("../../components/ParkRent.tsx");
    expect(rent).toMatch(/plan\.notMonthly\.some\(\(l\) => !perStayTerm\(l\.term\)\)/);
    expect(rent).not.toMatch(/l\.term !== "nightly"/);
  });

  it("the advice names a control the roll actually has, and never a figure to divide", () => {
    // "Set a monthly rent" sent him to type $400 into Edit, which changed the
    // amount and left the term at `annual` — the same sentence next month. The
    // door that changes how a tenancy is paid is Edit on the roll; the
    // sentence names it, and the roll has it.
    const s = notMonthlySentence([{ lotNumber: "9", term: "annual" }]);
    expect(s).toMatch(/from Edit on the roll/);
    expect(s).toMatch(/type the monthly rent/);
    expect(s).not.toMatch(/set a monthly rent/);
    expect(s).not.toMatch(/divide|÷|\/ ?12/);
    const roll = readFileSync(fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(roll, "the roll no longer has an Edit button — the sentence points at nothing").toMatch(/"Cancel" : "Edit"/);
    // THE CONTROL THE SENTENCE RELIES ON is not the Edit button — HEAD's roll
    // had that and no way to change how a tenancy is paid. It is the Paid
    // select INSIDE the edit panel, so this anchors inside EditTenant and
    // fails if that select is reverted while the button stays.
    const panelAt = roll.indexOf("function EditTenant(");
    expect(panelAt, "EditTenant is gone — the scan is measuring nothing").toBeGreaterThan(0);
    const panel = roll.slice(panelAt);
    expect(panel).toMatch(/<span className="mut">Paid<\/span>/);
    expect(panel).toMatch(/pickTerm\(e\.target\.value\)/);
    expect(panel).toMatch(/EDITABLE_TERMS\.map\(/);
    // ...and "monthly" is one of the ways it offers, or "change how it's paid
    // to monthly" names a choice the select lacks.
    expect(EDITABLE_TERMS).toContain("monthly");
    // "type the monthly rent": changing the way of paying empties the rent
    // box rather than dividing the old figure — the sentence's other promise.
    expect(panel).toMatch(/rent: next === \(term \?\? ""\) \? [\s\S]*? : "",/);
    expect(panel).not.toMatch(/\/ ?12\b/);
  });

  it("groups lots by term and names each group once", () => {
    expect(notMonthlySentence([
      { lotNumber: "9", term: "annual" }, { lotNumber: "14", term: "annual" }, { lotNumber: "3", term: "weekly" },
    ])).toBe(
      "Lots 9 and 14 are filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent. " +
      "Lot 3 is filed as paid weekly — the run bills months only; it's priced per stay, not by the month.",
    );
  });

  it("the term check collapses both ways", () => {
    expect(classifyForRun(yearly, FEB, new Set())).toBe("notMonthly");
    expect(classifyForRun({ ...yearly, term: "monthly" }, FEB, new Set())).toBe("bill");
  });

  it("an expired yearly row is 'run out' first — the louder fact", () => {
    const lapsed = { ...yearly, range: { start: "2026-02-01", end: "2027-02-01" } };
    expect(classifyForRun(lapsed, FEB, new Set())).toBe("expired");
  });
});

describe("daysBetween", () => {
  it("counts forward and back across a month boundary", () => {
    expect(daysBetween("2027-03-01", "2027-03-10")).toBe(9);
    expect(daysBetween("2027-03-01", "2027-02-25")).toBe(-4);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);   // leap year
  });
});

describe("a payment is a two-party event", () => {
  const charge = {
    id: "c1", lotNumber: "3", renterName: "Roy Amberg",
    periodMonth: "2026-07", dueOn: "2026-07-01",
    amount: 455, paidTotal: 0, status: "open" as const,
  };

  it("calls an unrecorded bill late when nobody has said otherwise", () => {
    expect(ledgerState(charge, "2026-07-20", 3)).toBe("late");
  });

  it("calls it DISPUTED, not late, once the household says they paid", () => {
    // The park says unpaid, the renter says paid. That is a disagreement, and a
    // disagreement is a question rather than a delinquency.
    expect(ledgerState(charge, "2026-07-20", 3, true)).toBe("disputed");
  });

  it("does NOT treat a claim as payment — the balance is untouched", () => {
    const rows = toRows([charge], "2026-07-20", 3, new Set(["c1"]));
    expect(rows[0].balance).toBe(455);
    expect(rows[0].state).toBe("disputed");
  });

  it("keeps disputed money OUT of the arrears total", () => {
    // The moment a disputed bill counts as arrears, every downstream total --
    // a demand letter, a default notice, an eviction exhibit -- asserts a debt
    // that is still an open question.
    const s = summarise(toRows([charge], "2026-07-20", 3, new Set(["c1"])));
    expect(s.lateCount).toBe(0);
    expect(s.lateAmount).toBe(0);
    expect(s.disputedCount).toBe(1);
    expect(s.disputedAmount).toBe(455);
  });

  it("still counts it as outstanding — a claim is not proof either", () => {
    const s = summarise(toRows([charge], "2026-07-20", 3, new Set(["c1"])));
    expect(s.outstanding).toBe(455);
    expect(s.billed).toBe(455);
  });

  it("shows a dispute about an ALREADY-PAID bill — they're disputing the record", () => {
    // Found by driving it: the renter taps "that's not what I paid" about a
    // payment that settled the bill. Checking the balance first made that read
    // as "Paid" and the owner never saw the disagreement at all.
    const paid = { ...charge, paidTotal: 455 };
    expect(ledgerState(paid, "2026-07-20", 3, true)).toBe("disputed");
    expect(ledgerState(paid, "2026-07-20", 3, false)).toBe("paid");
  });

  it("doesn't add a settled dispute to the arrears figure", () => {
    const paid = { ...charge, paidTotal: 455 };
    const s = summarise(toRows([paid], "2026-07-20", 3, new Set(["c1"])));
    expect(s.disputedCount).toBe(1);
    expect(s.disputedAmount).toBe(0);
    expect(s.collected).toBe(455);
    expect(ledgerHeadline(s, 3)).toMatch(/a payment we've recorded isn't right/);
    expect(ledgerHeadline(s, 3)).not.toContain("$0.00");
  });

  it("a claim inside the catch-up window still shows as a disagreement", () => {
    // Even early, if they've said something we should not be silent about it.
    expect(ledgerState(charge, "2026-07-02", 3, true)).toBe("disputed");
    expect(ledgerState(charge, "2026-07-02", 3, false)).toBe("due");
  });

  it("leads the headline with the disagreement, not the arrears", () => {
    const rows = toRows(
      [charge, { ...charge, id: "c2", lotNumber: "4" }],
      "2026-07-20", 3, new Set(["c1"]),
    );
    const line = ledgerHeadline(summarise(rows), 3);
    expect(line).toMatch(/says they've paid/);
    expect(line).toMatch(/1 other household is late/);
  });
});

describe("a month as a person says it", () => {
  it("spells the month out", () => {
    expect(prettyMonth("2026-08")).toBe("August 2026");
    expect(prettyMonth("2026-12")).toBe("December 2026");
    expect(prettyMonth("2027-01")).toBe("January 2027");
  });

  // A malformed period must not become "Invalid Date" on somebody's statement.
  it("hands back anything it doesn't recognise, unchanged", () => {
    expect(prettyMonth("")).toBe("");
    expect(prettyMonth("2026-13")).toBe("2026-13");
    expect(prettyMonth("2026-00")).toBe("2026-00");
    expect(prettyMonth("August")).toBe("August");
    expect(prettyMonth("2026-08-01")).toBe("2026-08-01");
  });
});

describe("stepping between months", () => {
  it("goes back and forward", () => {
    expect(shiftMonth("2026-08", -1)).toBe("2026-07");
    expect(shiftMonth("2026-08", 1)).toBe("2026-09");
  });

  it("crosses a year boundary in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("steps further than a year", () => {
    expect(shiftMonth("2026-08", -14)).toBe("2025-06");
  });

  it("leaves anything it doesn't recognise alone", () => {
    expect(shiftMonth("nonsense", 1)).toBe("nonsense");
  });
});

describe("an application stores a RATE, never a stay total", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../parks/apply-actions.ts", import.meta.url)), "utf8",
  );

  it("writes the rate card's amount into quoted_amount", () => {
    // quoteStay multiplies the card rate by the number of whole periods — its
    // own test asserts $900/month over 2.5 months quotes 2700. buildStatement
    // bills quoted_amount as "Lot rent … for the month". Storing the stay
    // total billed a three-month applicant $2,700 EVERY month, and the charge
    // run bills 'approved' rows, so approving the application started it.
    expect(src).toMatch(/quoted_amount: card\.amount/);
  });

  it("does not store the stay total under any name", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/quoted_amount:\s*(quoted|sellable|quoteStay)/);
  });

  it("still refuses a term the park does not sell", () => {
    // quoteStay stays as the validity check — it returns null for an unsold
    // term AND for an unreal range.
    expect(src).toMatch(/const sellable = quoteStay\(/);
    expect(src).toMatch(/sellable == null \|\| !card/);
  });

  it("and the ledger really does treat that column as a monthly rent", () => {
    // If this ever stops being true, the fix above is wrong.
    const st = readFileSync(
      fileURLToPath(new URL("./statement-helpers.ts", import.meta.url)), "utf8",
    );
    expect(st).toMatch(/label: "Lot rent"/);
    expect(st).toMatch(/basis: prorated \? proratedBasis : "for the month"/);
  });
})

describe("a cost share billed once, or the bill comes back", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./ledger-actions.ts", import.meta.url)), "utf8",
  );
  const at = src.indexOf("STAMP THE SHARES");
  const body = src.slice(at, at + 3200);

  it("no longer swallows a failed stamp", () => {
    // `if (!stampErr) sharesBilled += ids.length;` counted the good case and
    // said nothing about the bad one. The charge is already raised, so the
    // resident has been billed; the shares still read unbilled, so NEXT
    // month's run bills the same water again.
    // Pin the SHAPE, not the presence of a handler. Checking only that a
    // console.error exists passes even when an unconditional `continue` above
    // it makes the whole recovery unreachable — the same "asked is not obeyed"
    // gap that let a notification gate be computed and ignored.
    expect(body).toMatch(/if \(!stampErr\) \{ sharesBilled \+= ids\.length; continue; \}/);
    expect(body).not.toMatch(/\}\s*continue;/);
    expect(body).toMatch(/console\.error\(`\[runCharges\] couldn't stamp/);
  });

  it("takes the bill back when it cannot mark the costs as spent", () => {
    expect(body).toMatch(/from\("park_charges"\)[\s\S]{0,120}status: "void"/);
  });

  it("and that void carries its timestamp and its reason", () => {
    // 0070 declares `check (voided_at is null or void_reason is not null)`, and
    // voidCharge honours it — it refuses a blank reason outright. Writing only
    // `status` left voided_at NULL, which satisfies that constraint VACUOUSLY:
    // a bill marked void with no timestamp and no reason, which is exactly the
    // row the constraint exists to forbid. An accountant reading the ledger
    // finds a cancelled bill and nothing saying why.
    const voidCall = body.slice(body.indexOf('from("park_charges")'));
    expect(voidCall.slice(0, 400)).toContain("voided_at");
    expect(voidCall.slice(0, 400)).toContain("void_reason");
  });

  it("and the run reports what SURVIVED, not what it inserted", () => {
    // Both figures came from `rows`, the pre-rollback insert list, so a month
    // where one bill was taken back still reported it — and that number is the
    // one the owner reconciles against.
    // `src` not `body`: the return statement sits past the slice `body` covers,
    // which is the same reason the stampProblems assertion below uses src.
    expect(src).toContain("rolledBack");
    expect(src).toMatch(/raised: keptRows\.length/);
    expect(src).toMatch(/keptRows\.reduce/);
  });

  it("and still says so when even the void fails", () => {
    expect(body).toMatch(/couldn't void charge/);
    expect(body).toMatch(/billed twice/);
  });

  it("the problems reach the sentence the owner reads", () => {
    expect(src).toMatch(/stampProblems\.length > 0 \? ` ⚠️ \$\{stampProblems\.join\(" "\)\}`/);
  });

  it("the same-month guard is still there — it just cannot cover next month", () => {
    // `already` keys on period_month, which is why an unstamped share survives
    // into a different month and gets billed again.
    expect(src).toMatch(/\.eq\("period_month", month\)/);
    // The set reaches planRun, whose classification checks it first.
    expect(src).toMatch(/planRun\(candidates, already, month\)/);
  });
})

// ---------------------------------------------------------------------------

describe("which day a household's rent is due", () => {
  /**
   * `lot_reservations.due_day` was written by the tenant-edit form, shown on
   * the rent roll, and read by nothing that raises a bill. An owner who set
   * lot 7 to the 10th saw "the 10th" and got bills due on the 1st — and since
   * lateness is measured from the charge's own due_on, that household was
   * chased nine days early every month.
   */
  it("uses the household's own day when it has one", () => {
    expect(dueDayFor(10, 1)).toBe(10);
  });

  it("falls back to the park's day when it has none", () => {
    expect(dueDayFor(null, 5)).toBe(5);
    expect(dueDayFor(undefined, 5)).toBe(5);
  });

  it("ignores a stored value that isn't a real day", () => {
    expect(dueDayFor("", 3)).toBe(3);
    expect(dueDayFor(0, 3)).toBe(3);
    expect(dueDayFor(32, 3)).toBe(3);
    expect(dueDayFor("nonsense", 3)).toBe(3);
  });

  it("accepts the numeric string Postgres may hand back for a smallint", () => {
    expect(dueDayFor("10", 1)).toBe(10);
  });

  it("both charge paths ask it, rather than using the park day directly", () => {
    const src = readFileSync(fileURLToPath(new URL("./ledger-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // preview and run
    expect((src.match(/dueDay: dueDayFor\(/g) ?? []).length).toBe(2);
    // and neither still passes the bare park-level value into a statement
    expect(src).not.toMatch(/\n\s+dueDay,\n/);
    // both must actually select the column, or the value is always undefined
    expect((src.match(/moved_out_on, due_day/g) ?? []).length).toBe(2);
  });

  it("both charge paths sort their skips through the ONE classification", () => {
    // The preview used to keep its own two-bucket copy of the run's four-way
    // sort, and the two disagreed on the morning that mattered. Both now
    // hand planRun the window, the term and the status — the facts — and
    // read the verdict back.
    const src = readFileSync(fileURLToPath(new URL("./ledger-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect((src.match(/planRun\(candidates, already, month\)/g) ?? []).length).toBe(2);
    // Each candidate carries the three facts the classification reads.
    expect((src.match(/term: \(s\.term as string \| null\) \?\? null/g) ?? []).length).toBe(2);
    expect((src.match(/status: \(s\.status as string \| null\) \?\? null/g) ?? []).length).toBe(2);
    // …and both select the column, or `term` is undefined and reads as monthly.
    expect((src.match(/due_day, origin, term"/g) ?? []).length).toBe(2);
    // The run's refusal and the preview's summary are the same sentence.
    expect(src).toMatch(/nothingToBillReason\(prettyMonth\(month\), \{\s*already: plan\.skippedAlreadyBilled/);
    // And no door keeps a private copy of the verdict.
    expect(src).not.toMatch(/range\.end <= monthStart/);
    expect(src).not.toMatch(/st\.total === 0 \? null/);
  });

  it("the importer no longer copies the park's day onto every tenancy", () => {
    const src = readFileSync(fileURLToPath(new URL("./import-actions.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // A copy goes stale the moment he changes the dial.
    expect(src).not.toMatch(/due_day: parkDueDay/);
    expect(src).not.toContain("parkDueDay");
  });
});

// ---------------------------------------------------------------------------

describe("the catch-up window the owner is TOLD about", () => {
  /**
   * TWO SENTENCES DESCRIBED THIS RULE AND BOTH WERE A DAY SHORT.
   *
   * The rule is `overdueBy > lagDays`, so a bill has to clear the window
   * before it reads late: with a 3-day window it is still "Due" on day 3 and
   * turns "Late" on day 4. Both sentences said "until it's 3 days past due",
   * which reads as late ON day 3.
   *
   * Where it lands: the owner sets the dial from the hint on it, then looks at
   * the roll on day 3 and finds a household the screen has just told him is
   * late sitting in the Due column. The number in the copy is the only thing
   * he has to check the software against.
   *
   * THE CODE IS RIGHT AND THE COPY WAS WRONG, which is the direction that
   * mattered: tightening the comparison to `>=` would call somebody late while
   * the window the setting exists to protect is still open.
   */

  /** Walk the days and ask the RULE when it first says late. No restatement. */
  function firstLateDay(lagDays: number): number {
    for (let d = 0; d <= 60; d += 1) {
      const today = `2027-04-${String(1 + d).padStart(2, "0")}`;
      if (ledgerState(charge({ dueOn: "2027-04-01" }), today, lagDays) === "late") return d;
    }
    return -1;
  }

  it("a bill first reads late the day AFTER the window closes", () => {
    expect(firstLateDay(3)).toBe(4);
    expect(firstLateDay(14)).toBe(15);
    // A same-day office has no window at all: due on the 1st, late on the 2nd.
    expect(firstLateDay(0)).toBe(1);
  });

  it("is still Due on the last day of the window", () => {
    // The exact day both sentences called late.
    expect(ledgerState(charge({ dueOn: "2027-04-01" }), "2027-04-04", 3)).toBe("due");
  });

  const COPY: Array<[string, string]> = [
    ["the rent roll's note under the late column", "../../components/ParkRent.tsx"],
    ["the hint on the dial he sets it with", "../../components/ParkDials.tsx"],
  ];

  for (const [what, rel] of COPY) {
    it(`${what} says MORE THAN, not a bare day count`, () => {
      const s = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      // Both sentences end the same way, so anchor on that and check the
      // hedge is in front of it rather than matching loose prose.
      const sentence = s
        .split("\n")
        .join(" ")
        // Bounded [\s\S], not [^.]: the JSX interpolates `page.lagDays`, and a
        // dot-excluding class stops dead at that property access.
        .match(/[Nn]o(?:thing|body) is (?:marked|called) late until[\s\S]{0,120}?days past due/);
      expect(sentence).not.toBeNull();
      expect(sentence![0]).toContain("more than");
    });
  }
});

// ---------------------------------------------------------------------------

describe("why a charge run raised nothing", () => {
  /**
   * "IT MAY ALREADY BE DONE" WAS ASSERTED FOR ALL FOUR REASONS.
   *
   * The run skips a tenancy when the bill already exists, when the agreement
   * window has ended, when it has not started, and when no rent is set. Only
   * one of those is "already done", and the one that matters is the second:
   * nobody moved out, the household is still on the lot, and the rent stops.
   *
   * At The Haven that is a whole-park event on one morning. Every agreement
   * filed on the same afternoon under a 3-month cap ends on the same day — file
   * twenty households on 1 January 2027 and every one runs out on 1 April. The
   * old sentence would have explained that away as probably-already-billed.
   */
  const none = { already: 0, expired: [], notYet: [], noRent: [] };

  it("names an expired agreement as the cause, and names the lots", () => {
    const s = nothingToBillReason("April 2027", { ...none, expired: ["1", "2", "7"] });
    expect(s).toContain("3 agreements have run out");
    expect(s).toContain("lot 1, lot 2 and lot 7");
    expect(s).toContain("Nobody moved out");
    expect(s).not.toContain("already");
  });

  it("does not list twenty lot numbers in one sentence", () => {
    const many = ["1", "2", "6", "7", "9", "10", "11"];
    const s = nothingToBillReason("April 2027", { ...none, expired: many });
    expect(s).toContain("lot 1, lot 2, lot 6 and 4 more");
  });

  it("names a non-monthly filing after an expired one and before a missing rent", () => {
    const s = nothingToBillReason("April 2027", {
      ...none, noRent: ["5"], notMonthly: [{ lotNumber: "9", term: "annual" }],
    });
    expect(s).toContain("Lot 9 is filed as paid yearly");
    expect(s).not.toContain("no rent is set");
    expect(nothingToBillReason("April 2027", {
      ...none, expired: ["3"], notMonthly: [{ lotNumber: "9", term: "annual" }],
    })).toContain("run out");
  });

  it("puts the expired case FIRST, because it is the one that is money stopping", () => {
    // A month can be several of these at once. The loudest has to win.
    const s = nothingToBillReason("April 2027", {
      already: 5, expired: ["3"], notYet: ["4"], noRent: ["5"],
    });
    expect(s).toContain("run out");
  });

  it("still says 'already raised' when that is genuinely why", () => {
    const s = nothingToBillReason("January 2027", { ...none, already: 20 });
    expect(s).toBe("Nothing to bill for January 2027 — 20 bills are already raised.");
  });

  it("says which lots have no rent set", () => {
    const s = nothingToBillReason("January 2027", { ...none, noRent: ["6"] });
    expect(s).toContain("no rent is set on lot 6");
  });

  it("says when a tenancy simply has not started", () => {
    const s = nothingToBillReason("January 2027", { ...none, notYet: ["6"] });
    expect(s).toContain("starts after this month");
  });

  it("falls back to the honest answer when nobody is on a lot at all", () => {
    expect(nothingToBillReason("January 2027", none)).toBe(
      "Nothing to bill for January 2027 — nobody is on a lot.",
    );
  });

  it("names two or three lots the way a person would", () => {
    // "Lot 1, lot 2 have no rent set" was the shape at exactly two or three —
    // the screen and the sentence shared it, so both read wrong together.
    expect(lotList(["1"])).toBe("lot 1");
    expect(lotList(["1", "2"])).toBe("lot 1 and lot 2");
    expect(lotList(["1", "2", "7"])).toBe("lot 1, lot 2 and lot 7");
    expect(lotList(["1", "2", "6", "7"])).toBe("lot 1, lot 2, lot 6 and 1 more");
    expect(lotList([])).toBe("");
    expect(nothingToBillReason("April 2027", { ...none, noRent: ["1", "2"] }))
      .toBe("Nothing to bill for April 2027 — no rent is set on lot 1 and lot 2, so there is nothing to charge.");
  });

  it("never claims the month is done unless something was actually done", () => {
    // Guards the guard: the old sentence must not be reachable from any state
    // other than a genuine already-billed one.
    for (const cause of [
      { ...none, expired: ["1"] },
      { ...none, noRent: ["1"] },
      { ...none, notYet: ["1"] },
      none,
    ]) {
      expect(nothingToBillReason("April 2027", cause)).not.toMatch(/already/);
    }
  });
});

// ---------------------------------------------------------------------------
// A MONTH A PERSON READS IS "JANUARY 2027".
//
// The house rule, and it keeps leaking at the edges — the slot that falls
// through to a raw value, the print-window title nobody looks at twice. Two
// found together: the rent roll's "Owed this month" tile, whose sub-line read
// "2027-01" in the ordinary state (nothing disputed, nothing blocked), and
// the reminder notices' print title, on pages he folds and puts through
// twenty doors.
//
// A repo-wide sweep for this is not viable — every Intl.DateTimeFormat option
// bag in the codebase mentions a month and drowns the signal. So these pin
// the two screens that were actually wrong, by reading the source of the
// expression that renders them.
// ---------------------------------------------------------------------------
describe("no raw YYYY-MM reaches a person", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("prettyMonth is what makes the difference", () => {
    expect(prettyMonth("2027-01")).toBe("January 2027");
    // And it passes through anything that is not a period, rather than
    // mangling it — the tile's sub-line shares a slot with other sentences.
    expect(prettyMonth("3 can't be totalled")).toBe("3 can't be totalled");
    expect(prettyMonth("")).toBe("");
  });

  it("the rent roll's owed-this-month sub-line formats its month", () => {
    const src = read("../../components/ParkRentRoll.tsx");
    const sub = src.match(/owedBlocked \?[^\n]*\n?[^\n]*owedMonth[^\n]*/)?.[0] ?? "";
    expect(sub, "the owedMonth fallback is gone — this scan is measuring nothing").not.toBe("");
    expect(sub, 'the tile falls through to a raw "2027-01"').toMatch(/prettyMonth\(/);
  });

  it("the printed notices are titled in words", () => {
    const src = read("../../components/ParkRent.tsx");
    const title = src.match(/<title>\$\{[^}]*\}[^<]*<\/title>/)?.[0] ?? "";
    expect(title, "the print title is gone — this scan is measuring nothing").not.toBe("");
    expect(title).toMatch(/prettyMonth\(/);
  });
});

// ---------------------------------------------------------------------------
// THE WAYS MONEY ARRIVES BY HAND — one list, one refusal, read by every door.
//
// ledger-actions.ts refused `card`/`ach` before its insert; money-actions.ts
// had its own six-way list with both rails still on it, so the on-account and
// deposit doors took from a crafted call what the rent door refused. The
// list moved here so both read the same four, and the refusal is a function
// so a fifth door cannot forget one of the rails.
// ---------------------------------------------------------------------------
describe("the hand-keyed four", () => {
  it("is exactly cash, check, transfer, other", () => {
    expect([...HAND_KEYED]).toEqual(["cash", "check", "transfer", "other"]);
  });

  it("refuses the two processor rails with the sentence that says what to do instead", () => {
    for (const rail of ["card", "ach"]) {
      expect(handKeyedRefusal(rail)).toBe(PROCESSOR_ONLY);
    }
    expect(PROCESSOR_ONLY).toMatch(/only the processor writes one/);
    expect(PROCESSOR_ONLY).toMatch(/record it as a bank transfer/);
    expect(PROCESSOR_ONLY).not.toMatch(/try again/i);
  });

  it("refuses anything that is not a way money arrives, and passes the four", () => {
    expect(handKeyedRefusal("zelle")).toBe("That isn't a way money arrives.");
    expect(handKeyedRefusal("")).toBe("That isn't a way money arrives.");
    for (const m of HAND_KEYED) expect(handKeyedRefusal(m)).toBeNull();
  });

  /**
   * EVERY DOOR, FOUND BY WHAT IT DOES — not a list of two files.
   *
   * The first version of this scan named ledger-actions.ts and
   * money-actions.ts, and the doc above handKeyedRefusal said "a fifth door
   * cannot forget". There was a third door the whole time: collectAmenityMoney
   * kept a five-way list with `card` on it and inserted no reference, so
   * every "Card" pressed on the amenities screen was refused by 0108 and the
   * office read the raw constraint text. A scan that measures two of three
   * is the rule in one doorway of three, written as a test.
   *
   * So: walk src, strip comments, and take every non-test file whose CODE
   * inserts into park_payments with a bare `method,` shorthand — that is a
   * method that arrived from a browser. The processor door (pay-actions.ts,
   * `method: "card"` with the processor's own reference) is correctly not one.
   */
  const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const handKeyedDoors = walk(SRC_ROOT)
    .map((f) => ({ file: relative(SRC_ROOT, f), code: strip(readFileSync(f, "utf8")) }))
    .filter(({ code }) => /\.from\("park_payments"\)/.test(code) && /^\s*method,\s*$/m.test(code));

  it("the scanner finds every door that keys a method from a browser — at least the three it was written for", () => {
    const files = handKeyedDoors.map((d) => d.file).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const known of ["app/park/ledger-actions.ts", "app/park/money-actions.ts", "app/park/amenity-actions.ts"]) {
      expect(files, `${known} is no longer found — the scan is measuring less than it did`).toContain(known);
    }
  });

  /** Every index at which `needle` occurs in `code`, in order. */
  const allIndexes = (code: string, needle: string): number[] => {
    const out: number[] = [];
    for (let at = code.indexOf(needle); at >= 0; at = code.indexOf(needle, at + 1)) out.push(at);
    return out;
  };
  const INSERT = '.from("park_payments").insert(';

  it("every such door reads the one refusal from here — before EACH insert, not the first — and none keeps a list of its own", () => {
    // "First call before first insert" passed money-actions.ts with
    // recordDeposit's call deleted: recordOnAccount's call precedes both
    // inserts. So each insert gets its own window, from the insert before it.
    let insertsAcross = 0;
    for (const { file, code } of handKeyedDoors) {
      const inserts = allIndexes(code, INSERT);
      expect(inserts.length, `${file}: no park_payments insert found — the anchor moved`).toBeGreaterThan(0);
      insertsAcross += inserts.length;
      const calls = allIndexes(code, "handKeyedRefusal(method)");
      let from = -1;
      for (const insertAt of inserts) {
        const inWindow = calls.some((c) => c > from && c < insertAt);
        expect(inWindow, `${file}: the insert at ${insertAt} has no handKeyedRefusal(method) between it and the insert before it`).toBe(true);
        from = insertAt;
      }
      // A claim's `method` may still name a rail — that is what the resident
      // SAID, and confirming it is what gets refused. What no door may keep is
      // a list of ways money arrives by hand.
      expect(code, `${file} grew its own list`).not.toMatch(/\[\s*"cash",\s*"check"/);
      expect(code, `${file} defines a hand-keyed list of its own`).not.toMatch(/^(export )?(const|type) (HAND_KEYED|METHODS|HandKeyedMethod)\b/m);
    }
    // rent (1), on-account + deposit (2), amenity (1): fewer means the walk
    // is measuring less than it did.
    expect(insertsAcross).toBeGreaterThanOrEqual(4);
  });

  it("every such door reads the one AMOUNT refusal too, and keeps no sentence of its own", () => {
    // The rent door fixed "isn't a number" said of -5 and 0.004 in one round
    // and the other doors kept it; 0.004 reached money-actions' insert as
    // 0.00 and the office read park_payments_amount_check by name.
    for (const { file, code } of handKeyedDoors) {
      expect(code, `${file} does not call paymentAmountRefusal`).toMatch(/paymentAmountRefusal\(/);
      expect(code, `${file} keeps its own amount sentence`).not.toMatch(/isn't a number/);
      expect(code.indexOf("paymentAmountRefusal("), `${file} checks the amount after it inserts`).toBeLessThan(code.indexOf(INSERT));
    }
  });
});

describe("why a payment amount is refused", () => {
  it("each bad amount is told what is wrong with IT, and a good one passes", () => {
    expect(paymentAmountRefusal(Number.NaN)).toBe("That payment amount isn't a number.");
    expect(paymentAmountRefusal(Number.POSITIVE_INFINITY)).toBe("That payment amount isn't a number.");
    expect(paymentAmountRefusal(-5)).toBe("That payment amount needs to be more than zero.");
    expect(paymentAmountRefusal(0)).toBe("That payment amount needs to be more than zero.");
    // 0.004 IS a number and IS more than zero; numeric(10,2) makes it 0.00.
    expect(paymentAmountRefusal(0.004)).toBe("That payment amount is less than a cent.");
    expect(paymentAmountRefusal(0.005)).toBeNull();
    expect(paymentAmountRefusal(0.01)).toBeNull();
    expect(paymentAmountRefusal(542.53)).toBeNull();
  });
});
