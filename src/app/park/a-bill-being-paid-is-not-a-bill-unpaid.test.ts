import { describe, it, expect } from "vitest";
import {
  ledgerState, toRows, summarise, ledgerHeadline, LEDGER_LABEL,
  type Charge,
} from "./ledger-helpers";
import { planReminders, reminderSummary, type RenterContact } from "./reminder-helpers";

/**
 * A BILL BEING PAID IS NOT A BILL UNPAID (0191).
 *
 * A bank debit takes three to five working days. `park_charge_paid_total`
 * deliberately does not count one until it clears — an ACH that reverses after
 * the bill read "paid" is the whole reason 0191 exists — which leaves the bill
 * with a balance and no way to say WHY. So the roll read it as LATE, the
 * arrears figure counted it, and the reminder run posted a demand at a
 * household who had paid on the 1st.
 *
 * That is the same harm `disputed` was added to prevent, arriving by a
 * different route: a total that chases money it should not. The difference is
 * that a disputed bill needs somebody to go and look, and a clearing one needs
 * nothing at all but time.
 *
 * THE PRECEDENCE IS THE PART MOST LIKELY TO BE WRONG, so every neighbour is
 * collapsed against it here: below paid and credit, below disputed, above late
 * and due, and never on a cancelled bill.
 */

const TODAY = "2027-01-20";
const bill = (over: Partial<Charge> = {}): Charge => ({
  id: "c1",
  lotNumber: "9",
  renterName: "Household 9",
  periodMonth: "2027-01",
  dueOn: "2027-01-01",
  amount: 542.53,
  paidTotal: 0,
  status: "open",
  ...over,
});

describe("where clearing sits among the other states", () => {
  it("is late with nothing clearing, and clearing once the debit covers it", () => {
    // Collapsed both ways on the one fact, so the test cannot pass by
    // accident: the same overdue bill, with and without money in flight.
    expect(ledgerState(bill(), TODAY, 3, false, 0)).toBe("late");
    expect(ledgerState(bill(), TODAY, 3, false, 542.53)).toBe("clearing");
  });

  it("stays LATE when the debit covers only part of what is owed", () => {
    // Calling the whole row "clearing" would stop the office chasing $342.53
    // nobody has paid. Whether to post a LETTER is a separate, more cautious
    // decision — see the reminder test below.
    expect(ledgerState(bill(), TODAY, 3, false, 200)).toBe("late");
  });

  it("is clearing on a bill that is not even due yet", () => {
    // Paying early by bank is the ordinary case, not an edge one.
    const early = bill({ dueOn: "2027-02-01" });
    expect(ledgerState(early, "2027-01-20", 3, false, 0)).toBe("due");
    expect(ledgerState(early, "2027-01-20", 3, false, 542.53)).toBe("clearing");
  });

  it("does not outrank an open disagreement", () => {
    // They said they handed over cash AND a debit is on its way. The question
    // of the cash is still a question; money arriving does not answer it.
    expect(ledgerState(bill(), TODAY, 3, true, 542.53)).toBe("disputed");
  });

  it("does not outrank a bill already settled by money that arrived", () => {
    const settled = bill({ paidTotal: 542.53 });
    expect(ledgerState(settled, TODAY, 3, false, 100)).toBe("paid");
    const over = bill({ paidTotal: 600 });
    expect(ledgerState(over, TODAY, 3, false, 100)).toBe("credit");
  });

  it("never appears on a cancelled bill", () => {
    expect(ledgerState(bill({ status: "void" }), TODAY, 3, false, 542.53)).toBe("void");
  });

  it("has a word a person reads", () => {
    expect(LEDGER_LABEL.clearing).toBe("Clearing");
  });
});

describe("the row and the summary", () => {
  const rows = (clearing: number) =>
    toRows([bill()], TODAY, 3, new Set(), new Map(), new Map([["c1", clearing]]));

  it("carries the figure beside a balance that is still owed", () => {
    const [r] = rows(542.53);
    expect(r.state).toBe("clearing");
    expect(r.clearing).toBe(542.53);
    // NOT zero: the money has not landed, so the bill is not paid. The row has
    // to be able to say both, which is why the figure is carried separately.
    expect(r.balance).toBe(542.53);
  });

  it("a cancelled bill has nothing clearing on it", () => {
    const [r] = toRows([bill({ status: "void" })], TODAY, 3, new Set(), new Map(),
      new Map([["c1", 542.53]]));
    expect(r.clearing).toBe(0);
    expect(r.balance).toBe(0);
  });

  it("keeps it OUT of the late figure, which is what demand letters are built from", () => {
    const late = summarise(rows(0));
    expect(late.lateCount).toBe(1);
    expect(late.lateAmount).toBe(542.53);

    const flight = summarise(rows(542.53));
    expect(flight.lateCount, "money in flight was counted as arrears").toBe(0);
    expect(flight.lateAmount).toBe(0);
    expect(flight.clearingCount).toBe(1);
    expect(flight.clearingAmount).toBe(542.53);
  });

  it("but keeps it IN outstanding, because the bill genuinely is not paid", () => {
    const s = summarise(rows(542.53));
    expect(s.outstanding).toBe(542.53);
    expect(s.collected).toBe(0);
  });

  it("does not count it as paid or as due", () => {
    const s = summarise(rows(542.53));
    expect(s.paidCount).toBe(0);
    expect(s.dueCount).toBe(0);
  });
});

describe("what the owner reads at the top", () => {
  const rows = (clearing: number, over: Partial<Charge> = {}) =>
    toRows([bill(over)], TODAY, 3, new Set(), new Map(), new Map([["c1", clearing]]));

  it("says nothing is late, and why the money is not in", () => {
    const line = ledgerHeadline(summarise(rows(542.53)), 3);
    expect(line).toMatch(/Nothing's late/i);
    expect(line).toMatch(/paid by bank/i);
    expect(line).toContain("$542.53");
  });

  it("names it beside a chase rather than instead of one", () => {
    // Two bills: one genuinely late, one in flight. Without the tail he reads
    // "1 household is late" on a morning when another has paid, and rings
    // somebody who has.
    const two = toRows(
      [bill(), bill({ id: "c2", lotNumber: "10" })],
      TODAY, 3, new Set(), new Map(), new Map([["c2", 542.53]]),
    );
    const line = ledgerHeadline(summarise(two), 3);
    expect(line).toMatch(/1 household is late/);
    expect(line).toMatch(/One more has paid by bank/i);
  });

  it("is silent about it when there is none", () => {
    expect(ledgerHeadline(summarise(rows(0)), 3)).not.toMatch(/paid by bank/i);
  });
});

describe("the reminder run", () => {
  const plan = (clearing: number) =>
    planReminders(
      toRows([bill()], TODAY, 3, new Set(), new Map(), new Map([["c1", clearing]])),
      new Map<string, RenterContact>([["c1", {
        renterId: "r9", displayName: "Household 9",
        email: "nine@example.test", mobile: null, smsConsent: false,
        contactPref: "email",
      }]]),
      "2027-01",
      {
        parkName: "The Haven",
        officeLine: "Pay the office at 9085 E 500 S",
        // False, as it is in production: 0 of 81 texts have ever been
        // delivered, so email and paper are the only channels.
        smsEnabled: false,
        alreadyReminded: new Set<string>(),
      },
    );

  it("chases an overdue bill with nothing in flight", () => {
    expect(plan(0).totalChased).toBe(1);
  });

  it("never posts a demand that crosses money in flight", () => {
    const p = plan(542.53);
    expect(p.totalChased, "a demand was sent at a household who had paid").toBe(0);
    expect(p.skippedClearing).toBe(1);
  });

  it("suppresses the chase even when the debit covers only PART of the bill", () => {
    // Deliberately more cautious than ledgerState, which still calls this row
    // "late". Suppressing a chase costs a month; posting one at a household
    // whose money is moving costs the relationship, and the figure is on his
    // screen either way.
    const p = plan(200);
    expect(p.totalChased).toBe(0);
    expect(p.skippedClearing).toBe(1);
  });

  it("tells him why there is nobody to chase, rather than just 'nobody is late'", () => {
    // "Nobody is late." would be true and would hide the fact that money is
    // coming — so he goes looking for a bill he thinks is unpaid.
    const line = reminderSummary(plan(542.53));
    expect(line).toMatch(/Nobody to chase/i);
    expect(line).toMatch(/paid by bank/i);
    expect(line).not.toBe("Nobody is late.");
  });
});

/**
 * AND THE MORNING SCREEN SAYS WHERE IT WENT.
 *
 * `arrears` on Today now excludes a clearing bill, which is right — "go and
 * get this" must not name somebody whose debit is three days from landing. But
 * the MoneyBlock comment states the opposite mistake plainly, about the
 * disputed line that had the same problem first: "Taking them out of arrears
 * without saying so would be the opposite mistake — they would vanish."
 *
 * So the figure has to be named somewhere, and this is that somewhere.
 */
describe("Today's money block", () => {
  const row = (over: Partial<Charge> = {}, clearing = 0) =>
    toRows([bill({ dueOn: "2026-12-01", periodMonth: "2026-12", ...over })],
      TODAY, 3, new Set(), new Map(), new Map([["c1", clearing]]))[0];

  it("names money in flight rather than letting it drop out of arrears", async () => {
    const { moneyBlock } = await import("./today-helpers");
    const clearing = row({}, 542.53);
    const block = moneyBlock({
      monthToDateCents: 0, todayCents: 0,
      monthSummary: summarise([]), lagDays: 3,
      arrears: [], clearingOlder: [clearing], today: TODAY,
    });
    expect(block.clearingLine).toMatch(/on its way/i);
    expect(block.clearingLine).toContain("$542.53");
    expect(block.clearingLine).toMatch(/time, not arrears/i);
    // And it is NOT in the arrears sentence, which is the whole point.
    expect(block.arrearsLine).toBeNull();
  });

  it("is silent when nothing is in flight", async () => {
    const { moneyBlock } = await import("./today-helpers");
    const block = moneyBlock({
      monthToDateCents: 0, todayCents: 0,
      monthSummary: summarise([]), lagDays: 3,
      arrears: [row()], today: TODAY,
    });
    expect(block.clearingLine).toBeNull();
    expect(block.arrearsLine).toMatch(/still owing from earlier months/i);
  });
});
