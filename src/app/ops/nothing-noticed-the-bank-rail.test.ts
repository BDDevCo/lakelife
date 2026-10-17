import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { opsTasks, type OpsFacts } from "./ops-today-helpers";

/**
 * NOTHING NOTICED WHEN THE BANK RAIL BROKE.
 *
 * The outlet shipped as a panel on `/park/rent`, and a panel on a screen only
 * works when somebody opens it. At The Haven that is one person with a park to
 * run. So two watches, both of which read ZERO today and both of which had to
 * be built before the processor is connected rather than after:
 *
 *   A DEBIT NOBODY CLEARED. The household has paid, their bill reads open, and
 *   the arrears figure deliberately leaves clearing money out — so the money is
 *   in no total anywhere AND nobody is being chased for it. Invisible in both
 *   directions, which is the worst place for money to be.
 *
 *   A PROCESSOR MESSAGE NOBODY READ. 0157's webhook records every delivery with
 *   `processed_at` null and decides no policy on purpose: "the handler that
 *   drains that table is written after the processor call, against real event
 *   names." That handler does not exist, so the day a processor is connected
 *   events pile up in a table nothing reads — including the one that matters
 *   most, a debit returned on Thursday that succeeded on Monday.
 */

const QUIET: OpsFacts = {
  escalations: 0, payoutsReturned: 0, crewsInTheRed: 0, payoutsQueued: 0,
  jobsNeedingCrew: 0, stuckHouseholds: 0, parkEnquiries: 0, proposedFees: 0,
  liveCrews: 0, orphanServices: 0, coverageHoles: 0, coveragePairs: 0,
  unpricedCrews: 0, unreadThreads: 0, requestsWaiting: 0,
  parksAwaitingPayments: 0, parksNotBillable: 0, monthsUnbilled: 0, unbilledCents: 0,
  moneyStuckInFlight: 0, stuckInFlightCents: 0, stuckWorstWeekdays: 0,
  processorEventsUnread: 0,
};
const facts = (over: Partial<OpsFacts> = {}): OpsFacts => ({ ...QUIET, ...over });
const keys = (f: OpsFacts) => opsTasks(f).map((t) => t.key);
const row = (f: OpsFacts, key: string) => opsTasks(f).find((t) => t.key === key);

describe("money asked for that never landed", () => {
  it("says nothing when nothing is stuck", () => {
    expect(keys(QUIET)).not.toContain("money-stuck-in-flight");
  });

  it("NAMES BOTH HALVES OF WHY IT IS INVISIBLE", () => {
    // The sentence has to carry the thing a reader would not work out: the
    // household has already paid AND the bill still says they owe it. Either
    // half alone reads as an ordinary arrears row.
    const t = row(facts({ moneyStuckInFlight: 1, stuckInFlightCents: 54_253, stuckWorstWeekdays: 9 }), "money-stuck-in-flight");
    expect(t).toBeDefined();
    expect(t!.said).toMatch(/household has paid/i);
    expect(t!.said).toMatch(/still reads open/i);
    expect(t!.said).toMatch(/9 working days/);
    expect(t!.said).toMatch(/\$542\.53/);
  });

  it("is urgent, and sends them to check the debits actually went", () => {
    // The likeliest cause past a week is that the processor never sent it,
    // which from this side looks exactly like patience.
    const t = row(facts({ moneyStuckInFlight: 2, stuckWorstWeekdays: 11 }), "money-stuck-in-flight");
    expect(t!.urgency).toBe("now");
    expect(t!.verb).toMatch(/actually went/i);
    expect(t!.tab).toBe("parks");
  });

  it("counts in the plural correctly, and drops the figure when there is none", () => {
    const one = row(facts({ moneyStuckInFlight: 1, stuckWorstWeekdays: 8 }), "money-stuck-in-flight")!.said;
    expect(one).toMatch(/1 bank payment /);
    expect(one).not.toMatch(/worth \$/);
    const many = row(facts({ moneyStuckInFlight: 3, stuckInFlightCents: 100_000, stuckWorstWeekdays: 8 }), "money-stuck-in-flight")!.said;
    expect(many).toMatch(/3 bank payments worth \$1,000/);
    expect(many).toMatch(/households have paid/i);
    expect(many).toMatch(/their bills still read open/i);
  });

  it("OUTRANKS MONEY WE HAVE NOT ASKED FOR", () => {
    // A household that has already paid and is still shown as owing outranks
    // an invoice LakeLife has not raised for itself.
    const k = keys(facts({ moneyStuckInFlight: 1, stuckWorstWeekdays: 8, monthsUnbilled: 4 }));
    expect(k.indexOf("money-stuck-in-flight")).toBeLessThan(k.indexOf("months-unbilled"));
  });
});

describe("processor messages nobody read", () => {
  it("says nothing before the first delivery", () => {
    expect(keys(QUIET)).not.toContain("processor-events-unread");
  });

  it("NAMES THE ONE THAT MATTERS, because the count alone means nothing", () => {
    // "3 messages have arrived" is not actionable. "One of them may be a bank
    // payment that came back" is why somebody should get up.
    const t = row(facts({ processorEventsUnread: 3 }), "processor-events-unread");
    expect(t).toBeDefined();
    expect(t!.said).toMatch(/3 messages/);
    expect(t!.said).toMatch(/nothing has acted on them/i);
    expect(t!.said).toMatch(/came back/i);
    expect(t!.urgency).toBe("now");
  });

  it("and one message is singular throughout", () => {
    const said = row(facts({ processorEventsUnread: 1 }), "processor-events-unread")!.said;
    expect(said).toMatch(/1 message from the payment processor has arrived/);
    expect(said).toMatch(/acted on it\b/);
  });
});

describe("the loaders behind them", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = strip(readFileSync(
    fileURLToPath(new URL("./money-rail-data.ts", import.meta.url)), "utf8"));

  it("both assert ops", () => {
    for (const fn of ["getStuckInFlight", "getUnreadProcessorEvents"]) {
      const at = src.indexOf(`export async function ${fn}`);
      expect(at, `${fn} is gone — repoint this`).toBeGreaterThan(-1);
      expect(src.slice(at, at + 220), fn).toMatch(/await assertOps\(\)/);
    }
  });

  it("A FAILED READ IS NULL, NEVER ZERO", () => {
    // Zero reads as "all the money landed" and "we are up to date with the
    // processor". Both are the reassuring way to be wrong.
    const stuck = src.slice(src.indexOf("export async function getStuckInFlight"));
    const branch = stuck.slice(stuck.indexOf("if (error)"), stuck.indexOf("let count"));
    expect(branch.length, "the error branch is gone — this scan is measuring nothing")
      .toBeGreaterThan(20);
    expect(branch).toMatch(/return null;/);
    expect(branch).not.toMatch(/return \{ count: 0/);

    const events = src.slice(src.indexOf("export async function getUnreadProcessorEvents"));
    const eb = events.slice(events.indexOf("if (error)"));
    expect(eb).toMatch(/return null;/);
    expect(eb).not.toMatch(/return 0;/);
  });

  it("A DECLINED HEAD COUNT IS NOT ZERO EITHER", () => {
    // `{ count: null, error: null }` is a real answer shape, and `count ?? 0`
    // would make it zero — the shape that once let a charge through a
    // disputed-bill guard by reading a failed count as "no disputes".
    const events = src.slice(src.indexOf("export async function getUnreadProcessorEvents"));
    expect(events).toMatch(/return count \?\? null;/);
    expect(events).not.toMatch(/return count \?\? 0;/);
  });

  it("A DEBIT WHOSE DATE WE CANNOT READ IS COUNTED, NOT SKIPPED", () => {
    // A row we cannot age is a payment we cannot watch, and dropping it is
    // exactly how a stuck debit becomes invisible.
    expect(src).toMatch(/verdict\.kind !== "stuck" && verdict\.kind !== "unknown"/);
  });

  it("and it uses the same three exclusions as every other reader", () => {
    const stuck = src.slice(src.indexOf("export async function getStuckInFlight"));
    const read = stuck.slice(stuck.indexOf('.from("park_payments")'), stuck.indexOf("if (error)"));
    expect(read).toMatch(/\.is\("settled_at", null\)/);
    expect(read).toMatch(/\.is\("reversed_at", null\)/);
    expect(read).toMatch(/\.is\("returned_at", null\)/);
  });
});

describe("the console reads them", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const page = strip(readFileSync(
    fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"));

  it("calls both loaders and feeds all four facts", () => {
    expect(page).toMatch(/getStuckInFlight\(todayLakeDate\(\)\)/);
    expect(page).toMatch(/getUnreadProcessorEvents\(\)/);
    expect(page).toMatch(/moneyStuckInFlight: stuckBankMoney\?\.count \?\? 0/);
    expect(page).toMatch(/stuckInFlightCents: stuckBankMoney\?\.cents \?\? 0/);
    expect(page).toMatch(/stuckWorstWeekdays: stuckBankMoney\?\.worstWeekdays \?\? 0/);
    expect(page).toMatch(/processorEventsUnread: unreadEvents \?\? 0/);
  });

  it("and a throwing loader does not take the console down with it", () => {
    // The Promise.all at the top of this page is all-or-nothing: one loader
    // throwing 500s the whole operations dashboard, and a brand-new module is
    // the likeliest thing to throw.
    const at = page.indexOf("let stuckBankMoney");
    const block = page.slice(at, page.indexOf("const parksRes", at) > -1
      ? page.indexOf("const parksRes", at) : at + 700);
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/catch \(e\)/);
    expect(block).toMatch(/console\.error/);
  });
});
