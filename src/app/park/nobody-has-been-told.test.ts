import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toRows, type Charge } from "./ledger-helpers";
import { planBillNotices, billNoticeBody, billNoticeSummary } from "./bill-notice-helpers";
import { planReminders, type RenterContact } from "./reminder-helpers";

/**
 * NOBODY HAS BEEN TOLD.
 *
 * `runCharges` ends its own success sentence with those four words. The run
 * raises eighteen bills and the only resident-facing money message in the
 * product was the OVERDUE demand, which by definition fires after somebody is
 * already late.
 *
 * On 1 January 2027 every household at The Haven signs at $542.53 — $400 rent
 * plus a $142.53 grounds fee most of them have never paid before — the run
 * raises their bills, and the first word any of them gets from the software is
 * a demand for money they were never told about.
 */

const TODAY = "2027-01-02";
const bill = (over: Partial<Charge> = {}): Charge => ({
  id: "c1", lotNumber: "9", renterName: "Household 9",
  periodMonth: "2027-01", dueOn: "2027-01-01",
  amount: 542.53, paidTotal: 0, status: "open", ...over,
});

const contact = (over: Partial<RenterContact> = {}): RenterContact => ({
  renterId: "r9", displayName: "Household 9",
  email: "nine@example.test", mobile: null, smsConsent: false,
  contactPref: "email", ...over,
});

const OPTS = {
  parkName: "The Haven",
  officeLine: "Drop it at the office — 9085 E 500 S — or give us a call.",
  // False, as it is in production: 0 of 81 texts have ever been delivered.
  smsEnabled: false,
  alreadyReminded: new Set<string>(),
  alreadyTold: new Set<string>(),
};

const plan = (
  charges: Charge[],
  contacts: Map<string, RenterContact>,
  over: Partial<typeof OPTS> & {
    linesByCharge?: Map<string, { label: string; amount: number }[]>;
  } = {},
  clearing = new Map<string, number>(),
) =>
  planBillNotices(
    toRows(charges, TODAY, 3, new Set(), new Map(), clearing),
    contacts, "2027-01", { ...OPTS, ...over },
  );

describe("telling a household their bill is ready", () => {
  it("tells somebody who has a bill and has not been told", () => {
    const p = plan([bill()], new Map([["c1", contact()]]));
    expect(p.totalTold).toBe(1);
    expect(p.toSend).toHaveLength(1);
    expect(p.toSend[0].body).toMatch(/Your bill for January 2027 on lot 9 is \$542\.53/);
    // The day as a person reads it, in the repo's one format (dayInWords),
    // never 2027-01-01.
    expect(p.toSend[0].body).toMatch(/due January 1, 2027/);
    expect(p.toSend[0].body).not.toMatch(/2027-01-01/);
  });

  it("explains WHAT THE BILL IS FOR when the bill carries a breakdown", () => {
    // The whole reason this matters at The Haven: a household who has only
    // ever paid $400 is being asked for $542.53, and the second line has to
    // be named before they are asked for it rather than after they ring up.
    const p = plan([bill()], new Map([["c1", contact()]]), {
      linesByCharge: new Map([["c1", [
        { label: "Rent", amount: 400 },
        { label: "Grounds fee", amount: 142.53 },
      ]]]),
    });
    const body = p.toSend[0].body;
    expect(body).toMatch(/Rent — \$400\.00/);
    expect(body).toMatch(/Grounds fee — \$142\.53/);
  });

  it("states the total and invents nothing when the bill has no breakdown", () => {
    const p = plan([bill()], new Map([["c1", contact()]]));
    expect(p.toSend[0].body).toContain("$542.53");
    expect(p.toSend[0].body).not.toMatch(/Rent —/);
    expect(p.toSend[0].body).not.toMatch(/undefined|NaN|\$0\.00/);
  });

  it("reads as a statement and never as a demand", () => {
    // This is the software's FIRST contact with a household about money.
    const body = billNoticeBody({
      name: "Household 9", lotNumber: "9", month: "2027-01",
      amount: 542.53, dueOn: "2027-01-01",
      parkName: "The Haven", officeLine: "Drop it at the office.",
    });
    expect(body).not.toMatch(/outstanding|overdue|late|owed|remit|immediately|must|failure/i);
    // And it allows for having crossed with their payment, like the chase does.
    expect(body).toMatch(/already paid/i);
  });

  it("says nothing to a household whose bill is settled", () => {
    const p = plan([bill({ paidTotal: 542.53 })], new Map([["c1", contact()]]));
    expect(p.totalTold).toBe(0);
    expect(p.skippedSettled).toBe(1);
    expect(billNoticeSummary(p)).toMatch(/every bill this month is settled/i);
  });

  it("says nothing about a cancelled bill", () => {
    const p = plan([bill({ status: "void" })], new Map([["c1", contact()]]));
    expect(p.totalTold).toBe(0);
    expect(p.skippedSettled).toBe(1);
  });

  it("says nothing to a household who already told US they paid", () => {
    // They know the bill exists — that is why they are disputing it. A notice
    // announcing it would read as though nobody had listened.
    const p = planBillNotices(
      toRows([bill()], TODAY, 3, new Set(["c1"]), new Map(), new Map()),
      new Map([["c1", contact()]]), "2027-01", OPTS,
    );
    expect(p.totalTold).toBe(0);
    expect(p.skippedTheyKnow).toBe(1);
  });

  it("says nothing to a household whose bank debit is already clearing", () => {
    const p = plan([bill()], new Map([["c1", contact()]]), {}, new Map([["c1", 542.53]]));
    expect(p.totalTold).toBe(0);
    expect(p.skippedTheyKnow).toBe(1);
  });

  it("never tells the same household twice about the same bill", () => {
    const p = plan([bill()], new Map([["c1", contact()]]), { alreadyTold: new Set(["c1"]) });
    expect(p.totalTold).toBe(0);
    expect(p.skippedAlreadyTold).toBe(1);
    expect(billNoticeSummary(p)).toMatch(/already been told/i);
  });

  it("prints for a household with no email instead of silently skipping them", () => {
    const p = plan([bill()], new Map([["c1", contact({ email: null, contactPref: "paper" })]]));
    expect(p.toPrint).toHaveLength(1);
    expect(p.totalTold).toBe(1);
    expect(billNoticeSummary(p)).toMatch(/print and hand over/i);
  });

  it("prints for a household with no contact row at all", () => {
    const p = plan([bill()], new Map());
    expect(p.toPrint).toHaveLength(1);
  });

  it("does not text a household who asked for texts, and says why", () => {
    // 0 of 81 delivered. `channelFor` is the one home for this rule and this
    // run must not route around it.
    const p = plan([bill()], new Map([["c1", contact({
      contactPref: "sms", mobile: "+12605551234", smsConsent: true,
    })]]));
    expect(p.toSend.concat(p.toPrint).every((r) => r.channel !== "sms")).toBe(true);
    expect(p.toSend.concat(p.toPrint)[0].note).toMatch(/Texting isn't switched on/i);
  });

  it("respects a household who asked not to be contacted", () => {
    const p = plan([bill()], new Map([["c1", contact({ contactPref: "none" })]]));
    expect(p.totalTold).toBe(0);
    expect(p.blocked).toHaveLength(1);
    expect(p.blocked[0].reason).toMatch(/asked not to be contacted/i);
  });

  it("tells a household whose bill is already late, rather than nothing at all", () => {
    // The owner may be catching up weeks after the run. "We never told you" is
    // worse than "we told you late", and the copy carries the due date as a
    // fact so it reads correctly either side of it.
    const p = plan([bill()], new Map([["c1", contact()]]), {});
    const late = planBillNotices(
      toRows([bill()], "2027-01-20", 3, new Set(), new Map(), new Map()),
      new Map([["c1", contact()]]), "2027-01", OPTS,
    );
    expect(p.totalTold).toBe(1);
    expect(late.totalTold).toBe(1);
  });
});

/**
 * THE INTERACTION THAT WOULD HAVE BEEN SILENT.
 *
 * park_reminders carries a UNIQUE index on (charge_id, party) where the outcome
 * stands — the hard guarantee behind "never chased twice". An announcement
 * written as a resident row would have taken that charge's only slot, and the
 * demand that came later could never have been written at all: a bare INSERT
 * returning 23505, which this codebase has already learned reads as
 * `data: null` and puts "try again" on screen for a path that cannot succeed.
 *
 * And the chase's own `alreadyReminded` read would have seen the announcement
 * and dropped that household — so telling somebody their bill existed would
 * have quietly cancelled the demand.
 *
 * 0192 makes both per-act. These pin the application half.
 */
describe("an announcement is not a demand", () => {
  const src = readFileSync(fileURLToPath(new URL("./reminder-actions.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the chase only counts chases as having been sent", () => {
    expect(src.length, "the scan is measuring nothing").toBeGreaterThan(1000);
    expect(src, "the chase would read an announcement as a demand already sent")
      .toMatch(/alreadyNotified\(parkId, "chase"\)/);
  });

  it("every row the chase writes says it is a chase", () => {
    const rows = [...src.matchAll(/party: "(resident|owner)",/g)];
    expect(rows.length, "no log rows found — the scan is stale").toBeGreaterThan(3);
    // Not one may rely on the column default: a default is a fact asserted
    // somewhere else, and this file's rows are demands.
    for (const m of rows) {
      const after = src.slice(m.index ?? 0, (m.index ?? 0) + 60);
      expect(after, `a log row does not name its kind: ${after}`).toMatch(/kind: "chase"/);
    }
  });

  it("and the announcement writes a different kind", () => {
    const notices = readFileSync(
      fileURLToPath(new URL("./bill-notice-actions.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(notices.length).toBeGreaterThan(1000);
    expect(notices).toMatch(/alreadyNotified\(parkId, "raised"\)/);
    expect((notices.match(/kind: "raised"/g) ?? []).length,
      "every outcome — sent, printed, blocked, failed — has to be recorded as an announcement")
      .toBeGreaterThanOrEqual(4);
    expect(notices, "an announcement must never be logged as a chase").not.toMatch(/kind: "chase"/);
  });

  it("telling them does not stop the chase, in the planner", () => {
    // The chase plans off state, not off the notice log, so an announced bill
    // that goes late is still chased. Collapsed: the only thing that stops a
    // chase is having already chased.
    const rows = toRows([bill()], "2027-01-20", 3, new Set(), new Map(), new Map());
    const contacts = new Map([["c1", contact()]]);
    const chased = planReminders(rows, contacts, "2027-01", OPTS);
    expect(chased.totalChased, "an announced bill was never chased").toBe(1);

    const already = planReminders(rows, contacts, "2027-01",
      { ...OPTS, alreadyReminded: new Set(["c1"]) });
    expect(already.totalChased).toBe(0);
  });

  it("both runs share one loader, so the contact rules cannot drift", () => {
    // An unverified mobile is not a channel, and nobody consented to the phone
    // merely on file. Two copies of that would eventually disagree.
    expect(src).toMatch(/loadNoticeContext\(parkId, month\)/);
    const notices = readFileSync(
      fileURLToPath(new URL("./bill-notice-actions.ts", import.meta.url)), "utf8",
    );
    expect(notices).toMatch(/loadNoticeContext\(parkId, month\)/);
    // And neither rebuilds the contact map itself.
    expect(src).not.toMatch(/mobile_verified_at/);
    expect(notices).not.toMatch(/mobile_verified_at/);
  });
});
