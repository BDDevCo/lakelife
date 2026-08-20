import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ledgerState, balanceOf, toRows, summarise, ledgerHeadline,
  planRun, runSummary, daysBetween,
  prettyMonth, shiftMonth,
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
    expect(body).toMatch(/from\("park_charges"\)\.update\(\{ status: "void" \}\)/);
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
