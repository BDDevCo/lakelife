import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ledgerState, balanceOf, toRows, summarise, ledgerHeadline,
  planRun, runSummary, daysBetween,
  prettyMonth, shiftMonth, dueDayFor, nothingToBillReason,
  type Charge,
} from "./ledger-helpers";

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
    const p = planRun(candidates, new Set());
    expect(p.toBill).toHaveLength(2);
    expect(p.skippedNoTotal).toBe(1);
    expect(p.total).toBe(910);
    expect(runSummary(p, "2027-03")).toMatch(/1 skipped — no rent set/);
  });

  it("adds NOTHING on a second run", () => {
    // The unique constraint enforces this anyway, but he should see zero
    // rather than trust it.
    const p = planRun(candidates, new Set(["r1", "r2"]));
    expect(p.toBill).toHaveLength(0);
    expect(runSummary(p, "2027-03")).toMatch(/already billed/i);
  });

  it("bills a clean park in one go", () => {
    const p = planRun(candidates.slice(0, 2), new Set());
    expect(runSummary(p, "2027-03")).toBe("Bill 2 households for March 2027 — $910.00");
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
    expect(src).toMatch(/already\.has\(s\.id as string\)/);
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
    expect(s).toContain("lot 1, lot 2, lot 7");
    expect(s).toContain("Nobody moved out");
    expect(s).not.toContain("already");
  });

  it("does not list twenty lot numbers in one sentence", () => {
    const many = ["1", "2", "6", "7", "9", "10", "11"];
    const s = nothingToBillReason("April 2027", { ...none, expired: many });
    expect(s).toContain("lot 1, lot 2, lot 6 and 4 more");
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
