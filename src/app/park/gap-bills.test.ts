import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE DOOR BILLS THE MONTHS IT MADE BILLABLE — gap-bills' three pieces:
 * whether the month's run happened (parkRanMonth), the loop over the
 * months a new row has missed (billLostMonths, through the one re-raise the
 * signing door already used), and the words the toast says about it
 * (lostMonthsWords). The re-raise itself is charge-edits', tested there;
 * here it is mocked so what is asserted is what this module ASKS of it —
 * which months, in what order, and what it does with each answer.
 */

const reraiseMonth = vi.hoisted(() => vi.fn());
vi.mock("./charge-edits", () => ({ reraiseMonth }));

const { parkRanMonth, billLostMonths, lostMonthsWords } = await import("./gap-bills");

type Older = { periodMonth: string; amount: number }[];
type Outcome = { raised: { id: string; month: string; amount: number; dueOn: string; basis: string } | null; why: string | null; fromOnAccount: number; toOlderBills: Older; settledFrom: { paymentId: string; amount: number }[]; settleProblem: string | null; sharesStamped: number };
const landed = (month: string, amount: number, over: Partial<Outcome> = {}): Outcome => ({
  raised: { id: `chg-${month}`, month, amount, dueOn: `${month}-01`, basis: "for the month" },
  why: null, fromOnAccount: 0, toOlderBills: [], settledFrom: [], settleProblem: null, sharesStamped: 0, ...over,
});
const skipped = (why: string): Outcome => ({ raised: null, why, fromOnAccount: 0, toOlderBills: [], settledFrom: [], settleProblem: null, sharesStamped: 0 });

/** An admin whose only read is the one billLostMonths makes itself — how a
 *  row is paid, for the not-monthly sentence. Everything else is the mocked
 *  re-raise. */
function adminPaying(row: { term: string; lot_number: string } | null, error: unknown = null) {
  const reads: string[] = [];
  const q = {
    select: (c: string) => { reads.push(c); return q; },
    eq: () => q,
    maybeSingle: () => Promise.resolve(error
      ? { data: null, error }
      : { data: row ? { term: row.term, park_lots: { lot_number: row.lot_number } } : null, error: null }),
  };
  return { admin: { from: () => q } as never, reads };
}
const admin = adminPaying(null).admin;

beforeEach(() => { reraiseMonth.mockReset(); });

describe("parkRanMonth — has this month's run happened at this park", () => {
  function adminReading(result: { data: unknown[] | null; error: unknown }) {
    const calls: Array<[string, unknown]> = [];
    const q = {
      select: (c: string) => { calls.push(["select", c]); return q; },
      eq: (c: string, v: unknown) => { calls.push(["eq", `${c}=${v}`]); return q; },
      neq: (c: string, v: unknown) => { calls.push(["neq", `${c}=${v}`]); return q; },
      limit: (n: number) => { calls.push(["limit", n]); return Promise.resolve(result); },
    };
    return { admin: { from: (t: string) => { calls.push(["from", t]); return q; } } as never, calls };
  }

  it("true when any live bill for the month exists on the park, false when none does", async () => {
    const yes = adminReading({ data: [{ id: "c1" }], error: null });
    expect(await parkRanMonth(yes.admin, "park-1", "2027-03")).toBe(true);
    // The park's bills for THAT month, live ones only — a voided bill is not a run.
    expect(yes.calls).toEqual([
      ["from", "park_charges"], ["select", "id"], ["eq", "park_id=park-1"], ["eq", "period_month=2027-03"], ["neq", "status=void"], ["limit", 1],
    ]);
    const no = adminReading({ data: [], error: null });
    expect(await parkRanMonth(no.admin, "park-1", "2027-03")).toBe(false);
  });

  it("a failed read is the problem it is — never 'no'", async () => {
    const bad = adminReading({ data: null, error: { message: "connection terminated" } });
    const r = await parkRanMonth(bad.admin, "park-1", "2027-03");
    expect(r).toEqual({ error: { message: "connection terminated" }, what: "the bills already raised this month" });
    expect(r).not.toBe(false);
  });
});

describe("billLostMonths — each month, oldest first, through the one re-raise", () => {
  it("calls reraiseMonth once per month in ascending order, on the row it was given", async () => {
    reraiseMonth.mockImplementation(async (_a, _p, _r, month: string) => landed(month, 450));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-03", "2027-02"]);
    expect(reraiseMonth.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ["park-1", "res-2", "2027-02"], ["park-1", "res-2", "2027-03"],
    ]);
    expect(out.raised.map((r) => r.month)).toEqual(["2027-02", "2027-03"]);
    expect(out.raised[0]).toEqual({ month: "2027-02", amount: 450, fromOnAccount: 0, toOlderBills: [], settleProblem: null });
    expect(out.problems).toEqual([]);
  });

  it("a failed read on the first month does not stop the second — each month is its own", async () => {
    reraiseMonth
      .mockResolvedValueOnce({ error: new Error("boom"), what: "the rent history for that lot" })
      .mockResolvedValueOnce(landed("2027-03", 450));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-02", "2027-03"]);
    expect(reraiseMonth).toHaveBeenCalledTimes(2);
    expect(out.problems).toEqual([{ month: "2027-02", reason: "we couldn't read the rent history for that lot; bill it from the rent screen", why: null }]);
    expect(out.raised.map((r) => r.month)).toEqual(["2027-03"]);
  });

  it("'already' is silent — the run, or the signing door's own re-raise, got there first", async () => {
    reraiseMonth.mockResolvedValueOnce(skipped("already")).mockResolvedValueOnce(landed("2027-03", 450));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-02", "2027-03"]);
    expect(out.problems).toEqual([]);
    expect(out.raised.map((r) => r.month)).toEqual(["2027-03"]);
  });

  it("a rent nobody set names the door that sets it — the roll — never a Bill button that would refuse it too", async () => {
    reraiseMonth.mockResolvedValueOnce(skipped("noRent"));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-02"]);
    expect(out.problems).toEqual([{
      month: "2027-02",
      reason: "no rent is set for the lot — set their rent on the roll, then bill it from the rent screen",
      why: "noRent",
    }]);
    expect(out.problems[0].reason).not.toMatch(/^no rent is set for the lot; bill it/);
  });

  it("any other refusal is said as the run's, with its classification kept for the caller", async () => {
    reraiseMonth.mockResolvedValueOnce(skipped("expired")).mockResolvedValueOnce(skipped("movedOut"));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-02", "2027-03"]);
    expect(out.problems).toEqual([
      { month: "2027-02", reason: "the run wouldn't raise it; bill it from the rent screen", why: "expired" },
      { month: "2027-03", reason: "the run wouldn't raise it; bill it from the rent screen", why: "movedOut" },
    ]);
  });

  // "bill it from the rent screen" was said for this refusal too, and the
  // rent screen's Bill button refuses the same row for the same reason
  // (classifyForRun: notMonthly) and prints ledger-helpers' sentence with a
  // link to the roll. So the toast says that sentence — the one spelling.
  it("a row filed as paid yearly is said in the run's own words, naming Edit on the roll — never 'bill it from the rent screen'", async () => {
    const { admin: a, reads } = adminPaying({ term: "annual", lot_number: "9" });
    reraiseMonth.mockResolvedValueOnce(skipped("notMonthly")).mockResolvedValueOnce(skipped("notMonthly"));
    const out = await billLostMonths(a, "park-1", "res-2", ["2027-02", "2027-03"]);
    expect(out.problems).toEqual([
      { month: "2027-02", why: "notMonthly", reason: "Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent" },
      { month: "2027-03", why: "notMonthly", reason: "Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent" },
    ]);
    for (const p of out.problems) expect(p.reason).not.toMatch(/bill it from the rent screen/);
    // Read once for the call, not once per month, and it carries the lot.
    expect(reads).toEqual(["term, park_lots(lot_number)"]);
    expect(lostMonthsWords(out)).toBe(
      "⚠️ February 2027 couldn't be billed — Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent. " +
      "⚠️ March 2027 couldn't be billed — Lot 9 is filed as paid yearly — the run bills months only — change how it's paid to monthly from Edit on the roll and type the monthly rent.",
    );
  });

  it("a nightly home is priced per stay — no door, and NEVER 'change to monthly'", async () => {
    const { admin: a } = adminPaying({ term: "nightly", lot_number: "9" });
    reraiseMonth.mockResolvedValueOnce(skipped("notMonthly"));
    const out = await billLostMonths(a, "park-1", "res-2", ["2027-02"]);
    expect(out.problems[0].reason).toBe("Lot 9 is filed as paid nightly — the run bills months only; it's priced per stay, not by the month");
    expect(out.problems[0].reason).not.toMatch(/Edit on the roll|monthly rent/);
  });

  it("a failed read of how the lot is paid is said as one — never read as monthly, never 'bill it from the rent screen'", async () => {
    const { admin: a } = adminPaying(null, { message: "connection terminated" });
    reraiseMonth.mockResolvedValueOnce(skipped("notMonthly"));
    const out = await billLostMonths(a, "park-1", "res-2", ["2027-02"]);
    expect(out.problems).toEqual([{
      month: "2027-02", why: "notMonthly",
      reason: "the run wouldn't raise it, and we couldn't read how that lot is paid to say why; the rent screen for that month says why",
    }]);
  });

  it("carries what money on account settled, what it put against older bills first, and any settlement problem", async () => {
    reraiseMonth.mockResolvedValueOnce(landed("2027-02", 450, {
      fromOnAccount: 300,
      toOlderBills: [{ periodMonth: "2027-01", amount: 542.53 }],
      settleProblem: "money on account couldn't be put against it — the bill stands and the money stays on account",
    }));
    const out = await billLostMonths(admin, "park-1", "res-2", ["2027-02"]);
    expect(out.raised[0]).toMatchObject({
      fromOnAccount: 300,
      toOlderBills: [{ periodMonth: "2027-01", amount: 542.53 }],
      settleProblem: expect.stringMatching(/money on account/),
    });
  });

  it("no months, no calls, nothing to say", async () => {
    const out = await billLostMonths(admin, "park-1", "res-2", []);
    expect(reraiseMonth).not.toHaveBeenCalled();
    expect(out).toEqual({ raised: [], problems: [] });
    expect(lostMonthsWords(out)).toBe("");
  });
});

describe("lostMonthsWords — what landed, in words", () => {
  const raised = (month: string, amount: number, fromOnAccount = 0, settleProblem: string | null = null, toOlderBills: Older = []) =>
    ({ month, amount, fromOnAccount, toOlderBills, settleProblem });

  it("one month", () => {
    expect(lostMonthsWords({ raised: [raised("2027-02", 450)], problems: [] })).toBe("February 2027 is now billed — $450.00.");
  });

  it("two months, with the total", () => {
    expect(lostMonthsWords({ raised: [raised("2027-02", 450), raised("2027-03", 450)], problems: [] })).toBe(
      "February 2027 and March 2027 are now billed — $450.00 and $450.00 ($900.00 in all).",
    );
    expect(lostMonthsWords({ raised: [raised("2027-02", 450), raised("2027-03", 450), raised("2027-04", 425)], problems: [] })).toBe(
      "February 2027, March 2027 and April 2027 are now billed — $450.00, $450.00 and $425.00 ($1,325.00 in all).",
    );
  });

  it("money on account that settled part of it replaces the full stop", () => {
    expect(lostMonthsWords({ raised: [raised("2027-02", 450, 300), raised("2027-03", 450, 150)], problems: [] })).toBe(
      "February 2027 and March 2027 are now billed — $450.00 and $450.00 ($900.00 in all), $450.00 of it settled from money on account.",
    );
    // Nothing on account: no such clause.
    expect(lostMonthsWords({ raised: [raised("2027-02", 450, 0)], problems: [] })).not.toMatch(/on account/);
  });

  // R1 is oldest-OPEN-bill-first: $700 on account with January's $542.53
  // still open on the lapsed prior went $542.53 to January and $157.47 to
  // the new February — and the toast said "$157.47 of it settled from money
  // on account". The tap moved $700; January went unsaid. The clause is the
  // run's own (onAccountClause), so the shape matches the preview and the
  // run's signal.
  it("money that went against an OLDER bill first is named, the whole movement and every month — the run's own clause", () => {
    expect(lostMonthsWords({
      raised: [
        raised("2027-02", 542.53, 157.47, null, [{ periodMonth: "2027-01", amount: 542.53 }]),
        raised("2027-03", 542.53, 0),
      ],
      problems: [],
    })).toBe(
      "February 2027 and March 2027 are now billed — $542.53 and $542.53 ($1,085.06 in all); " +
      "$700.00 of money on account went against January 2027 and February 2027.",
    );
    // Enough on account to reach the older bill AND both new months: every
    // month the money touched, oldest first, and the whole figure.
    expect(lostMonthsWords({
      raised: [
        raised("2027-02", 542.53, 542.53, null, [{ periodMonth: "2027-01", amount: 542.53 }]),
        raised("2027-03", 542.53, 414.94),
      ],
      problems: [],
    })).toBe(
      "February 2027 and March 2027 are now billed — $542.53 and $542.53 ($1,085.06 in all); " +
      "$1,500.00 of money on account went against January 2027, February 2027 and March 2027.",
    );
    // All of it to the older bill, nothing left for the new month.
    expect(lostMonthsWords({
      raised: [raised("2027-02", 542.53, 0, null, [{ periodMonth: "2027-01", amount: 500 }])],
      problems: [],
    })).toBe("February 2027 is now billed — $542.53; $500.00 of money on account went against January 2027.");
    // A zero older line is not a line: the short form stands.
    expect(lostMonthsWords({
      raised: [raised("2027-02", 450, 300, null, [{ periodMonth: "2027-01", amount: 0 }])],
      problems: [],
    })).toBe("February 2027 is now billed — $450.00, $300.00 of it settled from money on account.");
  });

  it("a settlement problem is appended to the month it belongs to", () => {
    expect(lostMonthsWords({ raised: [raised("2027-02", 450, 0, "money on account couldn't be put against it — the bill stands and the money stays on account")], problems: [] })).toBe(
      "February 2027 is now billed — $450.00. ⚠️ February 2027: money on account couldn't be put against it — the bill stands and the money stays on account.",
    );
  });

  it("every problem line names the month and ends at a door the screen has", () => {
    const words = lostMonthsWords({
      raised: [raised("2027-02", 450)],
      problems: [
        { month: "2027-03", reason: "the run wouldn't raise it; bill it from the rent screen", why: "expired" },
        { month: "2027-04", reason: "no rent is set for the lot — set their rent on the roll, then bill it from the rent screen", why: "noRent" },
      ],
    });
    expect(words).toBe(
      "February 2027 is now billed — $450.00. " +
      "⚠️ March 2027 couldn't be billed — the run wouldn't raise it; bill it from the rent screen. " +
      "⚠️ April 2027 couldn't be billed — no rent is set for the lot — set their rent on the roll, then bill it from the rent screen.",
    );
    for (const line of words.split(" ⚠️ ").slice(1)) expect(line).toMatch(/bill it from the rent screen\.$/);
  });

  it("nothing for nothing", () => {
    expect(lostMonthsWords({ raised: [], problems: [] })).toBe("");
  });

  it("never an ISO month", () => {
    expect(lostMonthsWords({ raised: [raised("2027-02", 450)], problems: [{ month: "2027-03", reason: "x", why: null }] })).not.toMatch(/\d{4}-\d{2}/);
    expect(lostMonthsWords({
      raised: [raised("2027-02", 450, 100, null, [{ periodMonth: "2027-01", amount: 50 }])],
      problems: [],
    })).not.toMatch(/\d{4}-\d{2}/);
  });
});
