import { describe, it, expect } from "vitest";
import {
  planReminders, channelFor, reminderBody, reminderSummary, ownerDigest,
  type RenterContact, type ReminderOptions,
} from "./reminder-helpers";
import { toRows, type Charge } from "./ledger-helpers";

const TODAY = "2026-08-20";
const OPTS: ReminderOptions = {
  parkName: "The Haven",
  officeLine: "Drop it at the office or call (260) 555-0100.",
  smsEnabled: false,          // A2P not registered yet
  alreadyReminded: new Set(),
};

const charge = (over: Partial<Charge> = {}): Charge => ({
  id: "c1", lotNumber: "1", renterName: "Wexler, Donna",
  periodMonth: "2026-08", dueOn: "2026-08-01",
  amount: 455, paidTotal: 0, status: "open", ...over,
});

const contact = (over: Partial<RenterContact> = {}): RenterContact => ({
  renterId: "r1", displayName: "Wexler, Donna",
  email: "donna@example.com", mobile: "+12605550100",
  smsConsent: true, contactPref: "email", ...over,
});

describe("THE PAPER RESIDENTS — the ones software usually misses", () => {
  it("gives a paper resident a printable notice, not a silent skip", () => {
    // A quarter to a third of a park never goes digital. If they can only be
    // emailed, they are the only people who never get reminded.
    const d = channelFor(contact({ contactPref: "paper" }), false);
    expect(d.channel).toBe("paper");
    expect(d.blocked).toBe(false);
  });

  it("prefers paper even when an email is on file — the preference IS the instruction", () => {
    expect(channelFor(contact({ contactPref: "paper", email: "x@y.com" }), true).channel).toBe("paper");
  });

  it("falls back to paper when somebody wants email but has none", () => {
    expect(channelFor(contact({ contactPref: "email", email: null }), false).channel).toBe("paper");
  });

  it("counts paper out loud in the summary", () => {
    const rows = toRows([charge({ id: "a" }), charge({ id: "b", lotNumber: "2" })], TODAY, 3);
    const plan = planReminders(rows, new Map([
      ["a", contact({ contactPref: "paper" })],
      ["b", contact({ contactPref: "paper" })],
    ]), "2026-08", OPTS);
    expect(plan.toPrint).toHaveLength(2);
    expect(reminderSummary(plan)).toContain("2 to print and hand over");
  });
});

describe("consent", () => {
  it("NEVER texts without operational consent — a verified mobile is not permission", () => {
    const d = channelFor(contact({ contactPref: "sms", smsConsent: false }), true);
    expect(d.channel).not.toBe("sms");
    expect(d.channel).toBe("email");
  });

  it("still reaches them while A2P is pending — texting off is not unreachable", () => {
    const d = channelFor(contact({ contactPref: "sms" }), false);
    expect(d.blocked).toBe(false);
    expect(d.channel).toBe("email");
    expect(d.note).toMatch(/registration is still pending/i);
  });

  it("prints for an SMS resident with no email while A2P is pending", () => {
    const d = channelFor(contact({ contactPref: "sms", email: null }), false);
    expect(d.blocked).toBe(false);
    expect(d.channel).toBe("paper");
    expect(d.note).toMatch(/printed instead/i);
  });

  it("sends SMS once it is switched on", () => {
    const d = channelFor(contact({ contactPref: "sms" }), true);
    expect(d).toEqual({ channel: "sms", blocked: false, reason: null, note: null });
  });

  it("only a resident who asked for no contact is ever left unreached", () => {
    // The one household the planner gives up on. Everything else falls through
    // to something that still arrives.
    const prefs = ["sms", "email", "paper"] as const;
    for (const p of prefs) {
      for (const email of [null, "a@b.co"]) {
        for (const sms of [true, false]) {
          const d = channelFor(contact({ contactPref: p, email, smsConsent: false }), sms);
          expect(d.blocked).toBe(false);
        }
      }
    }
  });

  it("respects a resident who asked for no contact at all", () => {
    const d = channelFor(contact({ contactPref: "none" }), true);
    expect(d.blocked).toBe(true);
    expect(d.reason).toMatch(/call in/i);
  });
});

describe("who gets chased", () => {
  it("NEVER reminds somebody inside the office catch-up window", () => {
    // Due the 1st, today the 20th, but the office runs 30 days behind — that
    // is unrecorded, not unpaid.
    const rows = toRows([charge()], TODAY, 30);
    const plan = planReminders(rows, new Map([["c1", contact()]]), "2026-08", OPTS);
    expect(plan.totalChased).toBe(0);
    expect(plan.skippedNotLate).toBe(1);
    expect(reminderSummary(plan)).toMatch(/nobody is late/i);
  });

  it("chases once the window has passed", () => {
    const rows = toRows([charge()], TODAY, 3);
    const plan = planReminders(rows, new Map([["c1", contact()]]), "2026-08", OPTS);
    expect(plan.toSend).toHaveLength(1);
    expect(plan.toSend[0].balance).toBe(455);
  });

  it("NEVER chases the same bill twice", () => {
    // Somebody chased three times stops reading anything from the park.
    const rows = toRows([charge()], TODAY, 3);
    const plan = planReminders(rows, new Map([["c1", contact()]]), "2026-08",
      { ...OPTS, alreadyReminded: new Set(["c1"]) });
    expect(plan.totalChased).toBe(0);
    expect(plan.skippedAlreadyReminded).toBe(1);
    expect(reminderSummary(plan)).toMatch(/already been reminded/i);
  });

  it("never chases a paid or cancelled bill", () => {
    const rows = toRows([
      charge({ id: "p", paidTotal: 455 }),
      charge({ id: "v", status: "void" }),
    ], TODAY, 3);
    const plan = planReminders(rows, new Map(), "2026-08", OPTS);
    expect(plan.totalChased).toBe(0);
  });

  it("falls back to paper for an unclaimed file with no contact record", () => {
    const rows = toRows([charge()], TODAY, 3);
    const plan = planReminders(rows, new Map(), "2026-08", OPTS);
    expect(plan.toPrint).toHaveLength(1);
  });
});

describe("what the notice says", () => {
  const body = reminderBody({
    name: "Wexler, Donna", lotNumber: "1", month: "2026-08", balance: 455,
    parkName: "The Haven", officeLine: "Drop it at the office.",
  });

  it("states the amount, the month and where to pay", () => {
    expect(body).toContain("$455.00");
    expect(body).toContain("lot 1");
    expect(body).toContain("August 2026");
    expect(body).toContain("Drop it at the office.");
  });

  it("carries NO threat and no invented fee", () => {
    // A reminder that reads as a warning turns a forgotten cheque into a
    // fight, and most of these are forgotten cheques.
    expect(body).not.toMatch(/evict|terminat|legal|penalt|late fee|attorney|notice to quit/i);
  });

  it("assumes it may have crossed with their payment", () => {
    expect(body).toMatch(/already paid/i);
  });

  it("greets a 'Surname, Given' name by the surname it was given", () => {
    expect(body.startsWith("Hi Wexler,")).toBe(true);
  });
});

describe("the owner's digest", () => {
  it("is ONE message about twenty, never twenty messages", () => {
    const rows = toRows([
      charge({ id: "a", lotNumber: "1" }),
      charge({ id: "b", lotNumber: "2" }),
      charge({ id: "c", lotNumber: "3" }),
    ], TODAY, 3);
    const plan = planReminders(rows, new Map([
      ["a", contact()],
      ["b", contact({ contactPref: "paper" })],
      ["c", contact({ contactPref: "none" })],
    ]), "2026-08", OPTS);

    const d = ownerDigest(plan, "The Haven", "2026-08")!;
    expect(d).toContain("2 households chased");
    expect(d).toContain("1 need a printed notice");
    expect(d).toContain("Couldn't reach 1");
    expect(d).toContain("Lot 3");
  });

  it("says nothing at all when there is nothing to say", () => {
    const plan = planReminders([], new Map(), "2026-08", OPTS);
    expect(ownerDigest(plan, "The Haven", "2026-08")).toBeNull();
  });
});

describe("never chase somebody who says they already paid", () => {
  it("skips a disputed household entirely", () => {
    // The park is wrong about as often as the renter. A demand sent to
    // somebody who handed over cash last week is how a clerical gap becomes
    // a fight -- and the software would be the one that started it.
    const rows = toRows([charge({ id: "a" })], TODAY, 3, new Set(["a"]));
    const plan = planReminders(rows, new Map([["a", contact()]]), "2026-08", OPTS);
    expect(plan.totalChased).toBe(0);
    expect(plan.skippedDisputed).toBe(1);
    expect(plan.toSend).toHaveLength(0);
    expect(plan.toPrint).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);
  });

  it("still chases the genuinely late ones alongside", () => {
    const rows = toRows(
      [charge({ id: "a" }), charge({ id: "b", lotNumber: "2" })],
      TODAY, 3, new Set(["a"]),
    );
    const plan = planReminders(rows, new Map([
      ["a", contact()], ["b", contact()],
    ]), "2026-08", OPTS);
    expect(plan.totalChased).toBe(1);
    expect(plan.skippedDisputed).toBe(1);
  });

  it("says why there is nobody to chase rather than 'nobody is late'", () => {
    const rows = toRows([charge({ id: "a" })], TODAY, 3, new Set(["a"]));
    const plan = planReminders(rows, new Map([["a", contact()]]), "2026-08", OPTS);
    expect(reminderSummary(plan)).toMatch(/say they've already paid/);
    expect(reminderSummary(plan)).not.toMatch(/Nobody is late/);
  });
});
