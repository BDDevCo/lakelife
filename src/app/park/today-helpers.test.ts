import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  moneyBlock, describeOffBook, occupancyLine, generateTasks, visibleTasks, quietState, preCutover,
  addDays, daysBetween, ordinal, householdsIn, holdoverLotsOf,
  type TaskFacts, type OccupancySnapshot,
} from "./today-helpers";
import { toRows, summarise, prettyMonth, type Charge } from "./ledger-helpers";
import { preCutoverCostRefusal } from "@/lib/billing-start";
import { SIGNED_LEASE_LABEL } from "./sign-helpers";

const TODAY = "2026-08-11";

const charge = (over: Partial<Charge> = {}): Charge => ({
  id: "c1", lotNumber: "1", renterName: "Amberg, Roy",
  periodMonth: "2026-08", dueOn: "2026-08-01",
  amount: 455, paidTotal: 0, status: "open", ...over,
});

const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  today: TODAY,
  parkId: "p1",
  currentMonth: "2026-08",
  rentDueDay: 1,
  agreements: [],
  monthBilled: true,
  liveOccupiedLots: 19,
  lateCount: 0,
  lateAmount: 0,
  arrearsCount: 0,
  arrearsAmount: 0,
  disputedCount: 0,
  unallocatedCosts: [],
  holdoverLots: [],
  pendingRentChanges: [],
  noticed: [],
  billsDue: [],
  heldForDeparted: [],
  // NULL = no go-live restriction, which is what a park with no handover has.
  cutoverOn: null,
  ...over,
});

describe("the money block", () => {
  const empty = summarise([]);

  it("leads with month-to-date, not a daily figure", () => {
    // 19 rents land in the first five days and nothing lands for 25. A "today"
    // headline is zero most of the month and teaches him to stop looking.
    const b = moneyBlock({
      monthToDateCents: 432_500, todayCents: 0, monthSummary: empty,
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.headline).toBe("$4,325.00 in so far this month.");
    expect(b.todayLine).toBeNull();
  });

  it("says nothing has come in rather than showing $0.00", () => {
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty,
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.headline).toBe("Nothing has come in yet this month.");
    expect(b.headline).not.toContain("$0.00");
  });

  it("shows today only when today actually had money", () => {
    const b = moneyBlock({
      monthToDateCents: 45_500, todayCents: 45_500, monthSummary: empty,
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.todayLine).toBe("$455.00 came in today.");
  });

  it("surfaces older months the single-month ledger cannot see", () => {
    // getLedger is scoped to one period_month, so arrears from June are
    // structurally invisible to it. This is the only place they appear.
    const june = toRows(
      [charge({ id: "j1", periodMonth: "2026-06", dueOn: "2026-06-01", lotNumber: "4" }),
       charge({ id: "j2", periodMonth: "2026-07", dueOn: "2026-07-01", lotNumber: "9" })],
      TODAY, 3,
    );
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty,
      lagDays: 3, arrears: june, today: TODAY,
    });
    expect(b.arrearsLine).toContain("$910.00");
    expect(b.arrearsLine).toContain("2 households");
    // A day a person reads — never "2026-06-01".
    expect(b.arrearsLine).toContain("oldest due June 1, 2026");
    expect(b.arrearsLine).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(b.arrearsLine).toContain("71 days");
  });

  it("says nothing about arrears when there are none", () => {
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty,
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.arrearsLine).toBeNull();
  });
});

describe("occupancy at 21 lots", () => {
  const snap = (o: Partial<OccupancySnapshot> = {}): OccupancySnapshot => ({
    liveLots: 21, occupied: 19, reserved: 0, vacant: 2,
    vacantLotNumbers: ["7", "12"], ...o,
  });

  it("reports counts, never a percentage", () => {
    // One move-out swings 21 lots by 4.8 points. A percentage here is a
    // disguised count with a step bigger than any decision he'd make.
    const l = occupancyLine(snap());
    expect(l.main).toBe("19 of 21 lots taken.");
    expect(l.main).not.toMatch(/%/);
  });

  it("NAMES the empty lots while there are few enough to name", () => {
    expect(occupancyLine(snap()).sub).toBe("Empty: lot 7, lot 12.");
  });

  it("stops naming them above five", () => {
    const l = occupancyLine(snap({
      occupied: 13, vacant: 8, vacantLotNumbers: ["1","2","3","4","5","6","7","8"],
    }));
    expect(l.sub).toBe("8 empty.");
  });

  it("says so plainly when nothing is empty", () => {
    expect(occupancyLine(snap({ occupied: 21, vacant: 0, vacantLotNumbers: [] })).sub)
      .toBe("Nothing empty.");
  });

  it("handles a park whose tenancies all start later — no 0%", () => {
    // The Haven at takeover: 21 lots, everyone reserved from the cutover date.
    const l = occupancyLine(snap({ occupied: 0, reserved: 19, vacant: 2 }));
    expect(l.main).toBe("19 of 21 lots spoken for.");
    expect(l.main).not.toContain("0%");
    expect(l.sub).toMatch(/start later/);
  });

  it("says there are no lots rather than dividing by zero", () => {
    const l = occupancyLine(snap({ liveLots: 0, occupied: 0, reserved: 0, vacant: 0 }));
    expect(l.main).toBe("No lots set up yet.");
    expect(l.sub).toBeNull();
  });
});

describe("the to-do list", () => {
  it("returns nothing at all for a quiet park, and never throws", () => {
    expect(generateTasks(facts())).toEqual([]);
    expect(generateTasks(facts({ liveOccupiedLots: 0, monthBilled: false }))).toEqual([]);
  });

  it("makes money owed aggregate and IMPOSSIBLE to dismiss", () => {
    const [t] = generateTasks(facts({ lateCount: 3, lateAmount: 1365 }));
    expect(t.title).toBe("3 households are late");
    expect(t.canDismiss).toBe(false);
    expect(t.urgency).toBe("overdue");
  });

  it("puts a disagreement above everything else", () => {
    const ts = generateTasks(facts({ lateCount: 2, lateAmount: 900, disputedCount: 1 }));
    expect(ts.some((t) => /disagrees/.test(t.title))).toBe(true);
    expect(ts.every((t) => t.canDismiss === false)).toBe(true);
  });

  it("warns before an agreement lapses, because billing then stops SILENTLY", () => {
    const [t] = generateTasks(facts({
      agreements: [{
        reservationId: "r1", lotNumber: "3", renterName: "Roy Amberg",
        startsOn: "2026-06-10", endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: false,
      }],
    }));
    expect(t.title).toBe("Lot 3's agreement ends in 30 days");
    expect(t.detail).toMatch(/rent stops being billed/);
  });

  it("does NOT nag when the next agreement already exists", () => {
    expect(generateTasks(facts({
      agreements: [{
        reservationId: "r1", lotNumber: "3", renterName: null,
        startsOn: "2026-06-10", endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: true,
      }],
    }))).toEqual([]);
  });

  it("keys renewals per SEQUENCE, so dismissing one doesn't hide the next", () => {
    const a = generateTasks(facts({
      agreements: [{ reservationId: "r1", lotNumber: "3", renterName: null,
        startsOn: "2026-06-10", endsOn: "2026-09-10", chainId: "ch1", seq: 3, hasSuccessor: false }],
    }))[0];
    // Both inside their own lead (three-month spans, 45 days), or the second
    // produces no card at all and the test proves nothing.
    const b = generateTasks(facts({
      agreements: [{ reservationId: "r2", lotNumber: "3", renterName: null,
        startsOn: "2026-06-20", endsOn: "2026-09-20", chainId: "ch1", seq: 4, hasSuccessor: false }],
    }))[0];
    expect(a.key).not.toBe(b.key);
  });

  it("collapses a pile of renewals into one card", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      reservationId: `r${i}`, lotNumber: String(i), renterName: null,
      startsOn: `2026-06-${String(10 + i).padStart(2, "0")}`,
      endsOn: `2026-09-${String(10 + i).padStart(2, "0")}`,
      chainId: `ch${i}`, seq: 1, hasSuccessor: false,
    }));
    const ts = generateTasks(facts({ agreements: many }));
    expect(ts).toHaveLength(1);
    expect(ts[0].title).toBe("6 agreements are running out");
    // A day a person reads — never "2026-09-10".
    expect(ts[0].detail).toMatch(/^The first ends September 10, 2026\./);
    expect(ts[0].detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  // LAPSED IS NOT RUNNING OUT. On 17 June fifteen one-month agreements from
  // the 1 January signing had ended on 1 February with nothing billed since,
  // and three were genuinely in their last half; the card said "18 agreements
  // are running out — The first ends February 1, 2027", the future tense for
  // a four-month-old past. Same test the per-lot branch uses (d < 0), split
  // into the two counts.
  it("splits lapsed agreements from ones running out, in the past tense", () => {
    const lapsed = Array.from({ length: 15 }, (_, i) => ({
      reservationId: `l${i}`, lotNumber: String(i + 1), renterName: null,
      startsOn: "2027-01-01", endsOn: "2027-02-01", chainId: `ch${i}`, seq: 1, hasSuccessor: false,
    }));
    const running = [
      { reservationId: "r14", lotNumber: "14", renterName: null, startsOn: "2027-06-01", endsOn: "2027-07-01", chainId: "c14", seq: 3, hasSuccessor: false },
      { reservationId: "r7", lotNumber: "7", renterName: null, startsOn: "2027-06-05", endsOn: "2027-07-05", chainId: "c7", seq: 3, hasSuccessor: false },
      { reservationId: "r9", lotNumber: "9", renterName: null, startsOn: "2027-06-10", endsOn: "2027-07-10", chainId: "c9", seq: 3, hasSuccessor: false },
    ];
    const [t] = generateTasks(facts({ today: "2027-06-25", currentMonth: "2027-06", agreements: [...lapsed, ...running] }));
    expect(t.title).toBe("15 agreements have lapsed and 3 are running out");
    expect(t.detail).toBe("15 have lapsed — the first on February 1, 2027; nothing billed since. 3 are running out.");
    expect(t.urgency).toBe("overdue");
    expect(t.detail).not.toMatch(/running out — The first ends/);
    // Only lapsed: no running-out clause at all.
    const [only] = generateTasks(facts({ today: "2027-06-25", currentMonth: "2027-06", agreements: lapsed }));
    expect(only.title).toBe("15 agreements have lapsed");
    expect(only.detail).toBe("15 have lapsed — the first on February 1, 2027; nothing billed since.");
    // And with none lapsed the card keeps its future tense.
    const [soon] = generateTasks(facts({ today: "2027-06-25", currentMonth: "2027-06", agreements: [...running, { ...running[0], reservationId: "r2", lotNumber: "2", chainId: "c2" }] }));
    expect(soon.title).toBe("4 agreements are running out");
    expect(soon.urgency).toBe("soon");
  });

  // R2 — THE CARD ASKS WITH THE SAME LEAD AS THE LIST IT LINKS TO. The lead
  // is the agreement's own last half, capped at 45 days (renewalLeadDays,
  // agreement-helpers), and it is read from `startsOn` and `endsOn` together.
  // With a flat 45 days, a one-month agreement was on this card from the
  // morning it was signed — above an "Agreements to write" list that R2 had
  // just made keep quiet about it.
  it("a one-month agreement gets NO card on its first day, and one in its last half", () => {
    // 11 August – 10 September is 30 days: asked from the 26th, 15 days out.
    const one = {
      reservationId: "r1", lotNumber: "14", renterName: "Doris",
      startsOn: "2026-08-11", endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: false,
    };
    expect(generateTasks(facts({ today: "2026-08-11", agreements: [one] }))).toEqual([]);
    expect(generateTasks(facts({ today: "2026-08-25", agreements: [one] }))).toEqual([]);
    const [t] = generateTasks(facts({ today: "2026-08-26", agreements: [one] }));
    expect(t.title).toBe("Lot 14's agreement ends in 15 days");
    expect(t.detail).toMatch(/^Doris — write the next one/);
  });

  it("a just-written one-month successor gets no card — the tap visibly took", () => {
    // 27 August: he renewed Lot 14 for the month from 10 September. The new
    // row is two weeks off its start and has no successor of its own; the
    // flat lead put it straight back on the card as "ends in 44 days".
    const successor = {
      reservationId: "r2", lotNumber: "14", renterName: "Doris",
      startsOn: "2026-09-10", endsOn: "2026-10-10", chainId: "ch1", seq: 2, hasSuccessor: false,
    };
    expect(generateTasks(facts({ today: "2026-08-27", agreements: [successor] }))).toEqual([]);
    expect(generateTasks(facts({ today: "2026-09-10", agreements: [successor] }))).toEqual([]);
    // Its own last half: 30 days, asked from 25 September.
    expect(generateTasks(facts({ today: "2026-09-25", agreements: [successor] }))).toHaveLength(1);
    // And a three-month one keeps the 45-day lead it always had.
    const three = { ...successor, reservationId: "r3", startsOn: "2026-07-10", endsOn: "2026-10-10" };
    expect(generateTasks(facts({ today: "2026-08-26", agreements: [three] }))).toHaveLength(1);
    expect(generateTasks(facts({ today: "2026-08-25", agreements: [three] }))).toEqual([]);
  });

  it("the card's lead is renewalLeadDays from agreement-helpers — ONE home, no second constant (source)", () => {
    const src = readFileSync(fileURLToPath(new URL("./today-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{[^}]*renewalLeadDays[^}]*\} from "\.\/agreement-helpers"/);
    expect(src).toMatch(/d <= renewalLeadDays\(a\.startsOn, a\.endsOn\)/);
    expect(src).not.toMatch(/RENEWAL_LEAD_DAYS/);
    // The move-out card's lead is its own named number, not the renewal's.
    expect(src).toMatch(/n\.days <= MOVE_OUT_LEAD_DAYS/);
    expect(src).toMatch(/The first ends \$\{dayInWords\(soonest\)\}/);
  });

  it("raises unbilled rent near the due day, not weeks early", () => {
    // Due on the 15th, today the 2nd — thirteen days out, not his problem yet.
    expect(generateTasks(facts({
      monthBilled: false, rentDueDay: 15, today: "2026-08-02",
    }))).toEqual([]);

    // Two days out: worth a word.
    const soon = generateTasks(facts({
      monthBilled: false, rentDueDay: 15, today: "2026-08-13",
    }));
    expect(soon[0].title).toBe("August 2026 isn't billed yet");
    expect(soon[0].urgency).toBe("soon");

    // Due on the 1st and it's the 11th with nobody billed — that is overdue.
    const late = generateTasks(facts({
      monthBilled: false, rentDueDay: 1, today: "2026-08-11",
    }));
    expect(late[0].urgency).toBe("overdue");
    expect(late[0].detail).toMatch(/Nobody has been billed/);
    // "the 1" reads like a truncated number wherever it appears.
    expect(late[0].detail).toContain("due on the 1st");
  });

  it("never asks to bill a park with nobody in it", () => {
    expect(generateTasks(facts({
      monthBilled: false, today: "2026-08-04", liveOccupiedLots: 0,
    }))).toEqual([]);
  });

  it("never asks to bill a month that began before go-live — the run would refuse it anyway", () => {
    // Somebody filed with a December start at a park going live 1 January:
    // "December 2026 isn't billed yet" sent him to a button that says
    // December isn't ours. Same rule, same function, as the bill reminders.
    expect(generateTasks(facts({
      monthBilled: false, today: "2026-12-15", currentMonth: "2026-12",
      rentDueDay: 1, liveOccupiedLots: 3, cutoverOn: "2027-01-01",
    }))).toEqual([]);
    // And the first month that IS ours is raised as before.
    const [t] = generateTasks(facts({
      monthBilled: false, today: "2027-01-11", currentMonth: "2027-01",
      rentDueDay: 1, liveOccupiedLots: 3, cutoverOn: "2027-01-01",
    }));
    expect(t?.title).toBe("January 2027 isn't billed yet");
    expect(t?.urgency).toBe("overdue");
  });

  it("says a cost that isn't split bills NOBODY", () => {
    const [t] = generateTasks(facts({
      unallocatedCosts: [{ id: "k1", label: "Water — July", amount: 412.5 }],
    }));
    expect(t.detail).toMatch(/does not bill anyone/);
    expect(t.detail).toContain("$412.50");
  });

  it("warns before a rent-notice deadline makes the date impossible", () => {
    const [t] = generateTasks(facts({
      today: "2026-08-11",
      pendingRentChanges: [{
        id: "rc1", lotNumber: "5", effectiveOn: "2026-09-25",
        noticeDaysRequired: 45, noticeServedOn: null,
      }],
    }));
    expect(t.title).toContain("needs its rent notice by August 11, 2026");
    expect(t.urgency).toBe("soon");
  });

  it("switches to 'that date is impossible' once the deadline passes", () => {
    const [t] = generateTasks(facts({
      today: "2026-08-20",
      pendingRentChanges: [{
        id: "rc1", lotNumber: "5", effectiveOn: "2026-09-25",
        noticeDaysRequired: 45, noticeServedOn: null,
      }],
    }));
    expect(t.title).toMatch(/can't start September 25, 2026/);
    expect(t.urgency).toBe("overdue");
    expect(t.canDismiss).toBe(false);
  });

  it("stops mentioning a rent change once notice has been served", () => {
    expect(generateTasks(facts({
      pendingRentChanges: [{
        id: "rc1", lotNumber: "5", effectiveOn: "2026-09-25",
        noticeDaysRequired: 45, noticeServedOn: "2026-08-01",
      }],
    }))).toEqual([]);
  });

  it("sorts overdue above soon above whenever", () => {
    const ts = generateTasks(facts({
      lateCount: 1, lateAmount: 455,
      unallocatedCosts: [{ id: "k1", label: "Water", amount: 100 }],
      agreements: [{ reservationId: "r1", lotNumber: "3", renterName: null,
        startsOn: "2026-06-10", endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: false }],
    }));
    expect(ts.map((t) => t.urgency)).toEqual(["overdue", "soon", "whenever"]);
  });
});

describe("who is leaving", () => {
  // 0101 added `expected_move_out`, `giveNotice` wrote it, and NOTHING read it
  // — the action had no caller either. The feature existed as two columns and
  // a validated write into the dark. These tests are the reader.
  const one = (over: Record<string, unknown> = {}) => [{
    reservationId: "r1", lotNumber: "7", renterName: "Dave Nolan",
    leavingOn: "2026-08-30", ...over,
  }];

  it("gives the warning the whole feature was for", () => {
    const [t] = generateTasks(facts({ noticed: one() }));
    expect(t.title).toBe("Lot 7 leaves in 19 days");
    expect(t.detail).toContain("Dave Nolan");
    expect(t.urgency).toBe("soon");
  });

  it("says today, not 'in 0 days'", () => {
    const [t] = generateTasks(facts({ noticed: one({ leavingOn: TODAY }) }));
    expect(t.title).toBe("Lot 7 leaves today");
  });

  it("keeps quiet about a date months out", () => {
    expect(generateTasks(facts({ noticed: one({ leavingOn: "2027-03-01" }) }))).toEqual([]);
  });

  // THE ONE WITH MONEY IN IT. A tenancy still open after the leaving date
  // keeps billing rent every month to somebody who has gone. No other check
  // catches it: they all ask whether the roll is billed, not whether it's true.
  it("escalates past the date, because an open tenancy keeps billing", () => {
    const [t] = generateTasks(facts({ noticed: one({ leavingOn: "2026-08-02" }) }));
    expect(t.title).toBe("Lot 7 was due to leave on August 2, 2026");
    expect(t.urgency).toBe("overdue");
    expect(t.detail).toMatch(/keeps billing rent/);
    expect(t.canDismiss).toBe(false);
  });

  it("can be put aside while it is still ahead, but never once it is late", () => {
    expect(generateTasks(facts({ noticed: one() }))[0].canDismiss).toBe(true);
    expect(generateTasks(facts({ noticed: one({ leavingOn: "2026-08-02" }) }))[0].canDismiss).toBe(false);
  });

  it("rolls up past three, and still names the lots", () => {
    const many = ["3", "7", "9", "12"].map((lotNumber, i) => ({
      reservationId: `r${i}`, lotNumber, renterName: null,
      leavingOn: `2026-08-2${i}`,
    }));
    const ts = generateTasks(facts({ noticed: many }));
    expect(ts).toHaveLength(1);
    expect(ts[0].title).toBe("4 households are leaving");
    expect(ts[0].detail).toContain("3, 7, 9, 12");
    expect(ts[0].detail).toMatch(/^The first goes August 20, 2026\./);
  });

  it("names the day in words on every move-out card — never an ISO date", () => {
    const [t] = generateTasks(facts({ noticed: one() }));
    expect(t.detail).toContain("Dave Nolan is out on August 30, 2026.");
    for (const ts of [
      generateTasks(facts({ noticed: one() })),
      generateTasks(facts({ noticed: one({ leavingOn: "2026-08-02" }) })),
    ]) {
      expect(ts[0].title + ts[0].detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("survives a household with no name on file", () => {
    const [t] = generateTasks(facts({ noticed: one({ renterName: null }) }));
    expect(t.detail).toMatch(/^Out on August 30, 2026\./);
  });
});

describe("who still hasn't signed", () => {
  it("names the holdover lots, because chasing a signature is a door-knock", () => {
    const [t] = generateTasks(facts({ holdoverLots: ["4", "9"] }));
    expect(t.title).toBe("2 households haven't signed the new lease");
    expect(t.detail).toContain("Lots 4, 9");
    expect(t.detail).toMatch(/cap doesn't apply to them yet/);
  });

  it("says where to record a signature, by the control's own label", () => {
    // The card sent him to the roll and the roll had nothing to tap: a
    // household that signed on 1 January stayed "unsigned" — and fee-exempt.
    const [t] = generateTasks(facts({ holdoverLots: ["4"] }));
    expect(t.detail).toContain("record it from their row on the rent roll");
    expect(t.detail).toContain("'They signed the new lease'");
    expect(t.href).toBe("/park");
  });

  it("says nothing at all once everybody has signed", () => {
    expect(generateTasks(facts({ holdoverLots: [] }))).toEqual([]);
  });

  // A SIGNING NEVER REWRITES THE HOLDOVER. sign-actions trims the
  // grandfathered row to end on the signing day and holds the new lease as
  // the next link in the same chain — so on 20 December a household who
  // signed for 1 January is still current on the old row, origin
  // grandfathered, and was listed under "haven't signed" until the 1st with
  // the card pointing at a button that would refuse them.
  describe("a holdover whose chain already carries the signed lease is not a holdover", () => {
    const lots = (id: string) => ({ "lot-4": "4", "lot-9": "9" } as Record<string, string>)[id] ?? "?";
    const trimmed = { park_lot_id: "lot-4", during: "[2026-01-01,2027-01-01)", origin: "grandfathered", agreement_chain_id: "chain-4", agreement_seq: 1 };
    const signed = { park_lot_id: "lot-4", during: "[2027-01-01,2027-04-01)", origin: "office", agreement_chain_id: "chain-4", agreement_seq: 2 };
    const unsigned = { park_lot_id: "lot-9", during: "[2026-01-01,2027-01-01)", origin: "grandfathered", agreement_chain_id: "chain-9", agreement_seq: 1 };
    /** The loader's own map: the highest seq standing in each chain. */
    const chainsOf = (rows: { agreement_chain_id: string | null; agreement_seq: number | null }[]) => {
      const m = new Map<string, number>();
      for (const r of rows) if (r.agreement_chain_id) m.set(r.agreement_chain_id, Math.max(m.get(r.agreement_chain_id) ?? 0, r.agreement_seq ?? 1));
      return m;
    };

    it("trimmed holdover + approved successor on 20 December: not listed, no card", () => {
      const rows = [trimmed, signed];
      const lotsOut = holdoverLotsOf(rows, "2026-12-20", chainsOf(rows), lots);
      expect(lotsOut).toEqual([]);
      expect(generateTasks(facts({ holdoverLots: lotsOut })).filter((t) => /signed the new lease/.test(t.title))).toEqual([]);
    });

    it("a holdover with no successor is listed, and the card names it", () => {
      const rows = [unsigned];
      const lotsOut = holdoverLotsOf(rows, "2026-12-20", chainsOf(rows), lots);
      expect(lotsOut).toEqual(["9"]);
      const [t] = generateTasks(facts({ holdoverLots: lotsOut }));
      expect(t.title).toBe("1 household hasn't signed the new lease");
      expect(t.detail).toContain("Lot 9");
    });

    it("both on the roll: only the unsigned one, and the signed lease's own row is never a holdover", () => {
      const rows = [trimmed, signed, unsigned];
      expect(holdoverLotsOf(rows, "2026-12-20", chainsOf(rows), lots)).toEqual(["9"]);
      // Collapsed the other way: the same map with the successor gone lists both.
      expect(holdoverLotsOf([trimmed, unsigned], "2026-12-20", chainsOf([trimmed, unsigned]), lots)).toEqual(["4", "9"]);
      // ON 1 JANUARY BOTH GRANDFATHERED RANGES HAVE RUN OUT — and only the
      // one with a signed successor stops being a holdover. Lot 9 has still
      // not signed the new lease; a range expiring does not sign it for them.
      // (This used to read every lapsed row as "signed", so the morning every
      // household was meant to have signed, the count went to zero on its
      // own. The lapsed-tenancy build relies on the count staying honest.)
      expect(holdoverLotsOf(rows, "2027-01-01", chainsOf(rows), lots)).toEqual(["9"]);
      expect(holdoverLotsOf(rows, "2027-06-01", chainsOf(rows), lots)).toEqual(["9"]);
    });

    it("a holdover whose signed lease was later CLOSED OUT has left — the map sees the ended link, and the lapsed old row is not a holdover", () => {
      // A move-out inside the signed lease marks only that link `ended`;
      // the trimmed grandfathered row before it is untouched. The loader's
      // map is built from every row including the ended ones now, so the
      // ended link still counts as "signed" and the lot is left off — it
      // used to reappear under "hasn't signed the new lease" the day the
      // family left, with the card pointing at a signing button.
      const rows = [trimmed, { ...signed, during: "[2027-01-01,2027-02-11)", status: "ended" }];
      expect(holdoverLotsOf(rows, "2027-03-16", chainsOf(rows), lots)).toEqual([]);
      // Collapsed the other way: a map that never saw the ended link lists lot 4.
      expect(holdoverLotsOf(rows, "2027-03-16", chainsOf([trimmed]), lots)).toEqual(["4"]);
    });

    it("a grandfathered row that has not STARTED is not a holdover yet — the date filter is still there", () => {
      // Collapsed the other way: dropping the date filter entirely would list
      // a future grandfathered row the day it was filed.
      const future = { ...unsigned, during: "[2027-03-01,2028-03-01)" };
      expect(holdoverLotsOf([future], "2027-01-01", chainsOf([future]), lots)).toEqual([]);
      expect(holdoverLotsOf([future], "2027-03-01", chainsOf([future]), lots)).toEqual(["9"]);
    });

    it("the loader hands holdoverLotsOf its own chains map — the one the renewal card reads", () => {
      const src = readFileSync(fileURLToPath(new URL("./today-actions.ts", import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src).toMatch(/holdoverLots: holdoverLotsOf\(/);
      const call = src.slice(src.indexOf("holdoverLots: holdoverLotsOf("), src.indexOf("lateCount:"));
      expect(call.length).toBeGreaterThan(100);
      expect(call).toMatch(/\n\s+chains,\n/);
      expect(call).toMatch(/agreement_chain_id: \(s\.agreement_chain_id as string \| null\)/);
      // And that map is built from EVERY row, the ended ones included — a
      // successor that was closed out is still a later link.
      expect(src).toMatch(/const chains = latestSeqByChain\(\s*\(everyRow \?\? \[\]\)\.map/);
      // The private filter is gone — one home for "who is a holdover".
      expect(src).not.toMatch(/\.filter\(\(s\) => \(s\.origin as string\) === "grandfathered"\)/);
    });
  });

  it("never outranks money owed", () => {
    const ts = generateTasks(facts({ holdoverLots: ["4"], lateCount: 1, lateAmount: 455 }));
    expect(ts[0].urgency).toBe("overdue");
    expect(ts[ts.length - 1].title).toMatch(/signed the new lease/);
  });
});

describe("his decisions about the list", () => {
  const t = generateTasks(facts({
    unallocatedCosts: [{ id: "k1", label: "Water", amount: 100 }],
  }));

  it("hides a dismissed task", () => {
    expect(visibleTasks(t, [
      { taskKey: t[0].key, snoozedUntil: null, dismissedAt: "2026-08-01T00:00:00Z" },
    ], TODAY)).toEqual([]);
  });

  it("hides a snoozed task, then brings it BACK when the snooze expires", () => {
    // Putting something off is not deciding against it, and the difference
    // matters a month later.
    expect(visibleTasks(t, [
      { taskKey: t[0].key, snoozedUntil: "2026-08-20", dismissedAt: null },
    ], TODAY)).toEqual([]);
    expect(visibleTasks(t, [
      { taskKey: t[0].key, snoozedUntil: "2026-08-10", dismissedAt: null },
    ], TODAY)).toHaveLength(1);
  });

  it("leaves a task with no decision against it alone", () => {
    expect(visibleTasks(t, [], TODAY)).toHaveLength(1);
  });
});

describe("the quiet state — which is most days", () => {
  it("says what it LOOKED at, so silence doesn't read as broken", () => {
    const q = quietState(["rent", "agreements", "costs"]);
    expect(q.headline).toBe("Nothing needs you this morning.");
    expect(q.checkedLine).toBe("Checked: rent · agreements · costs.");
  });

  it("admits when there is nothing set up to check", () => {
    expect(quietState([]).checkedLine).toBe("Nothing set up to check yet.");
  });
});

describe("before the park goes live", () => {
  const base = {
    today: TODAY, cutoverOn: "2026-12-15", parkName: "The Haven",
    lots: 21, lotsWithRates: 21, monthlyRoll: 5200, households: 0,
    rentDueDay: 1, maxAgreementMonths: 3,
  };

  it("counts down to go-live rather than showing an empty park", () => {
    const p = preCutover(base);
    expect(p.headline).toBe("The Haven — 126 days to go-live.");
    expect(p.sub).toMatch(/Nothing is collectable/);
  });

  it("counts down without assuming the park was BOUGHT", () => {
    // Most parks joining already own themselves: no closing, no seller, no
    // purchase — just the day they start running the place on this system.
    const p = preCutover(base);
    expect(`${p.headline} ${p.sub}`).not.toMatch(/closing|seller|purchase|take over/i);
  });

  it("measures readiness against lots and rates, which exist", () => {
    const p = preCutover(base);
    const rates = p.items.find((i) => i.label === "Rate cards")!;
    expect(rates.value).toBe("21 of 21 — $5,200.00 a month");
    expect(rates.done).toBe(true);
    // Tenancies do NOT exist yet — the roll names nobody — so this must read as
    // outstanding rather than as a failure.
    expect(p.items.find((i) => i.label === "Households on the roll")!.done).toBe(false);
  });

  it("flags an unset agreement cap, since its trigger silently skips on NULL", () => {
    const p = preCutover({ ...base, maxAgreementMonths: null });
    const cap = p.items.find((i) => i.label === "Agreement cap")!;
    expect(cap.value).toBe("not set");
    expect(cap.done).toBe(false);
  });

  it("changes its words on the day itself", () => {
    const p = preCutover({ ...base, today: "2026-12-15" });
    expect(p.headline).toBe("The Haven — today is the day.");
    expect(p.sub).toBe("Money and occupancy start now.");
  });
});

describe("date arithmetic", () => {
  it("crosses a month boundary backwards", () => {
    expect(addDays("2026-09-25", -45)).toBe("2026-08-11");
  });
  it("counts inclusive-exclusive days the same way everywhere", () => {
    expect(daysBetween("2026-08-11", "2026-09-10")).toBe(30);
    expect(daysBetween("2026-09-10", "2026-08-11")).toBe(-30);
  });
});

describe("ordinals", () => {
  it("reads like a date rather than a truncated number", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(15)).toBe("15th");
    // The teens are the trap: 11th/12th/13th, not 11st/12nd/13rd.
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(21)).toBe("21st");
  });
});

describe("a lot is counted once", () => {
  it("never double-counts a lot that is occupied AND has a booked successor", () => {
    // Renewing a tenant writes a future tenancy on a lot that already has a
    // current one. If both sets hold it, every renewal inflates occupancy by a
    // lot that never changed hands.
    const l = occupancyLine({
      liveLots: 3, occupied: 1, reserved: 0, vacant: 2,
      vacantLotNumbers: ["7", "12"],
    });
    expect(l.main).toBe("1 of 3 lots taken.");
  });
});

describe("a disputed bill is not arrears", () => {
  const TODAY2 = "2026-08-13";
  const empty2 = { billed: 0, collected: 0, outstanding: 0, late: 0, paid: 0, disputed: 0 } as never;
  const row = (id: string, balance: number, state: string) => ({
    id, lotNumber: id, renterName: "Someone", periodMonth: "2026-07",
    dueOn: "2026-07-01", amount: balance, paidTotal: 0,
    status: "open", balance, state, overdueDays: 43,
  }) as never;

  it("chases what is owed, and SETTLES what is disputed — separately", () => {
    // The arrears figure is the one number on the morning screen that means
    // "go and get this". Money a household says they already handed over does
    // not belong in it; it belongs in a conversation.
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty2, lagDays: 3,
      arrears: [row("Lot 4", 500, "late")],
      disputedOlder: [row("Lot 9", 450, "disputed")],
      today: TODAY2,
    });
    expect(b.arrearsLine).toContain("$500.00");
    expect(b.arrearsLine).not.toContain("$950.00");   // never the sum of both
    expect(b.disputedLine).toContain("$450.00");
    expect(b.disputedLine).toContain("not arrears");
  });

  it("stays silent about disputes when there are none", () => {
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty2, lagDays: 3,
      arrears: [row("Lot 4", 500, "late")], today: TODAY2,
    });
    expect(b.disputedLine).toBeNull();
  });

  it("A DISPUTE ALONE IS NOT ARREARS AT ALL — no chase line", () => {
    const b = moneyBlock({
      monthToDateCents: 0, todayCents: 0, monthSummary: empty2, lagDays: 3,
      arrears: [], disputedOlder: [row("Lot 9", 450, "disputed")], today: TODAY2,
    });
    expect(b.arrearsLine).toBeNull();
    expect(b.disputedLine).toContain("$450.00");
  });
});

// ---------------------------------------------------------------------------
// A BILL THAT ARRIVES EVERY MONTH.
//
// The Haven's sewer is 82% of everything the park spends on its residents'
// behalf and it arrives monthly. Miss it and nineteen households are never
// billed their share — invisibly, because a cost nobody entered leaves no
// trace anywhere.
// ---------------------------------------------------------------------------
describe("bills that come round again", () => {
  // `periodFrom` is what billPeriod hands the loader: the first day of the
  // period the bill is FOR. Derived from the key so an override of one cannot
  // leave the other pointing at a different month.
  // `periodLabel` is billPeriod's. UNFLAGGED — which every fixture here is —
  // it names the DUE DATE and never a period the schedule has not said it
  // covers: "(bill due August 5)" for a monthly bill, "due November 10,
  // 2026" for a yearly one. A schedule that HAS said so (0170,
  // coversPriorPeriod true) gets "for July 2026 (bill due August 5)"; those
  // cases live in their own describe below.
  const sewer = (over: Record<string, unknown> = {}) => {
    const periodKey = (over.periodKey as string | undefined) ?? "2026-08";
    return [{
      scheduleId: "s1", category: "sewer", label: "Sewer",
      periodKey, periodLabel: "(bill due August 5)", periodFrom: `${periodKey}-01`,
      dueOn: "2026-08-05", typical: 1433.17, coversPriorPeriod: false, ...over,
    }];
  };

  it("says what to expect, so a wrong invoice is noticeable", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ dueOn: "2026-08-20", periodLabel: "(bill due August 20)" }) }));
    expect(t.title).toBe("Sewer (bill due August 20) is coming up");
    expect(t.detail).toContain("$1,433.17");
    expect(t.urgency).toBe("soon");
  });

  it("escalates once the day has passed", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ dueOn: "2026-08-05" }) }));
    expect(t.title).toBe("Sewer (bill due August 5) still isn't entered");
    expect(t.urgency).toBe("overdue");
  });

  // AN UNFLAGGED CARD NAMES THE DUE DATE, NOT A PERIOD IT IS GUESSING AT.
  // "Sewer for January 2027" about the bill dated 5 January was December's
  // service (the park's own note: the bill dated the 5th is for the previous
  // month); "Property tax for 2027" about the bill due 10 November 2027 was
  // the seller's 2026 tax under the buyer's year. Until the owner ticks the
  // 0170 box the schedule knows when a bill lands and nothing else, so the
  // title says exactly that and no more.
  it("never names a service month or a tax year unless the schedule says so — only the day the bill is due", () => {
    const [t] = generateTasks(facts({ billsDue: sewer() }));
    expect(t.title).not.toMatch(/ for /);
    expect(t.title).toMatch(/^Sewer \(bill due August 5\)/);
  });

  // NEVER DISMISSIBLE. The software must not offer to stop mentioning a bill
  // nineteen households are waiting to be charged their share of.
  it("cannot be dismissed", () => {
    expect(generateTasks(facts({ billsDue: sewer() }))[0].canDismiss).toBe(false);
  });

  it("says the day in words, not 2026-08-05", () => {
    const [t] = generateTasks(facts({ billsDue: sewer() }));
    expect(t.title).toContain("August 5");
    expect(t.title).not.toContain("2026-08");
  });

  it("manages without a typical amount rather than inventing one", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ typical: null }) }));
    expect(t.detail).not.toMatch(/\$/);
    expect(t.detail).toMatch(/costs screen/);
  });

  // THE CARD DOES NOT KNOW WHAT THE DOOR WILL DO WITH THE BILL. The loader
  // reads no fees, and at The Haven the monthly sewer is fee-covered: the
  // costs screen records it under the Grounds fee and divides it to nobody.
  // "Enter the real figure and it splits across the lots — until it is in,
  // nobody is billed for it" promised, on the 5th of every month, a split and
  // a bill that the screen it links to then — correctly — refuses to make.
  // So the sentence names both things the door can do and promises neither.
  it("promises no split it cannot know about — the sentence is the same for a covered category", () => {
    for (const typical of [1433.17, null]) {
      const [t] = generateTasks(facts({ billsDue: sewer({ typical }) }));
      expect(t.detail).toMatch(/costs screen/);
      expect(t.detail).toMatch(/a fee that covers it/);
      expect(t.detail).toMatch(/or splits across the lots/);
      expect(t.detail).toMatch(/nobody's books and nobody's fee comparison/);
      // The unconditional promise, in the shape it had.
      expect(t.detail).not.toMatch(/it splits across the lots —/);
      expect(t.detail).not.toMatch(/nobody is billed for it/);
    }
    // And the typical figure still leads when there is one, in one sentence
    // of its own, so the instruction reads the same either way.
    const [withTypical] = generateTasks(facts({ billsDue: sewer({ typical: 1433.17 }) }));
    expect(withTypical.detail).toMatch(/^Usually about \$1,433\.17\. Enter the real figure/);
    const [without] = generateTasks(facts({ billsDue: sewer({ typical: null }) }));
    expect(without.detail).toMatch(/^Enter the real figure/);
  });

  // A NEW PARK HAS NO SCHEDULES AND SEES NOTHING. Nothing about The Haven is
  // a default for somebody else's park.
  it("is silent for a park that has set none up", () => {
    expect(generateTasks(facts({ billsDue: [] }))).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // "DUE ABOUT NOW" HAS TO BE ABOUT NOW.
  //
  // Only the monthly case was ever tested, which is why this survived: a
  // schedule with no cost in its period raised a card on the FIRST DAY of
  // that period. The Haven has a real annual `tax` schedule, due 10 November.
  // On the morning of 1 January 2027 — the morning twenty households are
  // billed for the first time — his Needs-you list opened with "Property tax
  // for 2027 is due about now", 313 days early, and `canDismiss: false`.
  // -------------------------------------------------------------------------
  const tax = (over: Record<string, unknown> = {}) => {
    const periodKey = (over.periodKey as string | undefined) ?? "2026";
    const dueOn = (over.dueOn as string | undefined) ?? "2026-11-10";
    const [yy, mm, dd] = dueOn.split("-").map(Number);
    const day = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    return [{
      scheduleId: "s9", category: "tax", label: "Property tax",
      periodKey, periodLabel: `due ${day}, ${yy}`, periodFrom: `${periodKey}-01-01`,
      dueOn, typical: 3517.96, coversPriorPeriod: false, ...over,
    }];
  };

  it("does not claim an annual bill is due 313 days out", () => {
    // TODAY is 2026-08-11; a bill due 2027-11-10 is well over a year away.
    expect(generateTasks(facts({ billsDue: tax({ dueOn: "2027-11-10" }) })))
      .toEqual([]);
  });

  it("raises it once it is genuinely about now", () => {
    // TODAY is 2026-08-11; +28 days = 2026-09-08, the edge of the window.
    const [t] = generateTasks(facts({ billsDue: tax({ dueOn: "2026-09-08" }) }));
    expect(t?.title).toBe("Property tax due September 8, 2026 is coming up");
    expect(t?.urgency).toBe("soon");
  });

  it("stays quiet one day outside the window", () => {
    expect(generateTasks(facts({ billsDue: tax({ dueOn: "2026-09-09" }) }))).toEqual([]);
  });

  it("never clips a LATE bill, however long ago it was due", () => {
    // The forgotten bill is the whole point of the reminder — a year late is
    // the case that costs money, not the case to hide.
    const [t] = generateTasks(facts({ billsDue: tax({ dueOn: "2025-11-10" }) }));
    expect(t?.title).toBe("Property tax due November 10, 2025 still isn't entered");
    expect(t?.urgency).toBe("overdue");
    expect(t?.canDismiss).toBe(false);
  });

  it("leaves every monthly bill exactly where it was", () => {
    // 28 is chosen for this. The worst case a monthly schedule can produce is
    // the first of the month looking at a bill due on the 28th — 27 days, one
    // inside the window. A shorter lead would silence the sewer bill, which
    // is 82% of what the park spends on its residents' behalf: a worse bug
    // than the one being fixed.
    for (const day of ["01", "05", "14", "28"]) {
      const [t] = generateTasks(facts({
        today: "2026-09-01",
        billsDue: sewer({ dueOn: `2026-09-${day}`, periodLabel: `(bill due September ${Number(day)})` }),
      }));
      expect(t?.title, `sewer due 2026-09-${day} vanished`)
        .toMatch(new RegExp(`Sewer \\(bill due September ${Number(day)}\\)`));
    }
  });

  // -------------------------------------------------------------------------
  // A BILL FOR A MONTH THAT WAS NEVER OURS.
  //
  // The Haven closes 15 December 2026 and goes live 1 January 2027. Its two
  // schedules are real — sewer monthly due the 5th, property tax annual due
  // 10 November — and on closing morning both raised a red, non-dismissible
  // card for the bills due 10 November 2026 and 5 December 2026. Both are
  // the seller's (the tax is a credit at the closing table; the sewer bill
  // arrived at the seller's address), neither may ever be a park_costs row,
  // and the card instructed him to enter both.
  //
  // ONE KEY FOR ONE RULE. The gate is keyed on the month billPeriod gives
  // the bill — the first day of the period it is due IN — because that is
  // the month the cost door compares against `period_start`. Keyed on the
  // DUE month, the two doors disagreed for any annual bill at a park that
  // went live mid-year: the card was raised and the door refused the period
  // he would type.
  //
  // WHAT THE GATE CANNOT KNOW ON ITS OWN is whether a bill is FOR the period
  // it is due in. Indiana bills property tax in arrears — the bill due 10
  // November 2027 is the 2026 tax, the seller's — and the sewer bill dated
  // the 5th is for the previous month. Since 0170 the SCHEDULE can say so
  // (coversPriorPeriod), and then billPeriod hands the gate the covered
  // period. Every fixture in THIS describe is unflagged: the gate lets the
  // November 2027 bill through at a 1 January park, and the card names it by
  // its DUE DATE and nothing more. The flagged cases — where the same bill
  // is keyed on 2026 and the card becomes one dismissible "starts before you
  // went live" line — are in the describe after this one.
  // -------------------------------------------------------------------------
  describe("before the park went live", () => {
    const HAVEN = { cutoverOn: "2027-01-01" };

    it("does not raise the seller's tax on closing day", () => {
      expect(generateTasks(facts({
        ...HAVEN, today: "2026-12-15",
        billsDue: tax({ dueOn: "2026-11-10" }),
      }))).toEqual([]);
    });

    it("does not raise the December sewer for a January go-live", () => {
      expect(generateTasks(facts({
        ...HAVEN, today: "2026-12-15",
        billsDue: sewer({ periodKey: "2026-12", periodLabel: "(bill due December 5)", dueOn: "2026-12-05" }),
      }))).toEqual([]);
    });

    it("raises the bill due 5 January — the first that is ours — and names it by its due day, not as 'January's'", () => {
      // The park's own note: the sewer bill dated the 5th is for the
      // PREVIOUS month's service. "Sewer for January 2027" was December's
      // bill under January's name; the due day is the one fact the card has.
      const [t] = generateTasks(facts({
        ...HAVEN, today: "2027-01-06",
        billsDue: sewer({ periodKey: "2027-01", periodLabel: "(bill due January 5)", dueOn: "2027-01-05" }),
      }));
      expect(t?.title).toBe("Sewer (bill due January 5) still isn't entered");
      expect(t?.title).not.toMatch(/for (December|January)/);
      expect(t?.urgency).toBe("overdue");
      expect(t?.canDismiss).toBe(false);
    });

    it("still never clips a LATE bill the gate lets through — and names it by its due date, never as 'the 2027 tax'", () => {
      // Go-live 1 Jan 2027; a tax bill due 10 Nov 2027 and it is now
      // February 2028. THE GATE LETS IT THROUGH: the schedule is unflagged,
      // so billPeriod keys the bill on the year it is due IN. At an Indiana
      // park that bill is the 2026 tax — the seller's year, a closing-table
      // credit, never a park_costs row — so calling it "Property tax for
      // 2027" was the lie; the card says only what the schedule knows. Once
      // the owner ticks the 0170 box the same schedule is keyed on 2026 and
      // gated out (see the flagged describe below).
      const [t] = generateTasks(facts({
        ...HAVEN, today: "2028-02-11",
        billsDue: tax({ dueOn: "2027-11-10", periodKey: "2027" }),
      }));
      expect(t?.title).toBe("Property tax due November 10, 2027 still isn't entered");
      expect(t?.title).not.toMatch(/for 2027|for 2026/);
      expect(t?.urgency).toBe("overdue");
    });

    it("keys on the bill's own period, so a mid-year go-live sees no tax card for the year that began before it", () => {
      // Go-live 1 April 2027. billPeriod gives the bill due November 2027 a
      // period starting 1 January 2027 — before go-live. The cost door
      // refuses that period (period_start January 2027 is before April
      // 2027), so a card for it would send him to a door that says no. And
      // at an Indiana park that bill is the 2026 tax anyway — the previous
      // owner's year, the buyer's share a closing credit, never a park_costs
      // row. Decided, not accidental; the comment on the gate says the same.
      expect(generateTasks(facts({
        cutoverOn: "2027-04-01", today: "2027-11-11",
        billsDue: tax({ dueOn: "2027-11-10", periodKey: "2027" }),
      }))).toEqual([]);
      // The next year's is the first that is his — and it is raised.
      const [t] = generateTasks(facts({
        cutoverOn: "2027-04-01", today: "2028-11-11",
        billsDue: tax({ dueOn: "2028-11-10", periodKey: "2028" }),
      }));
      expect(t?.title).toBe("Property tax due November 10, 2028 still isn't entered");
    });

    it("a quarterly bill is keyed the same way — the quarter it is for", () => {
      // Anchored Feb/May/Aug/Nov, due on the 10th of the anchor month. The
      // November 2026 quarter began before a 1 January go-live; February
      // 2027's is the first that is ours. For quarterly, as for monthly, the
      // due month IS the period's first month, so nothing moves here.
      const quarter = (key: string, from: string, dueOn: string, label: string) => [{
        scheduleId: "s4", category: "trash", label: "Trash",
        periodKey: key, periodLabel: label, periodFrom: from, dueOn, typical: null,
        coversPriorPeriod: false,
      }];
      expect(generateTasks(facts({
        ...HAVEN, today: "2026-12-15",
        billsDue: quarter("2026-Q11", "2026-11-01", "2026-11-10", "(bill due November 10)"),
      }))).toEqual([]);
      const [t] = generateTasks(facts({
        ...HAVEN, today: "2027-02-11",
        billsDue: quarter("2027-Q2", "2027-02-01", "2027-02-10", "(bill due February 10)"),
      }));
      expect(t?.title).toBe("Trash (bill due February 10) still isn't entered");
    });

    it("raises a card exactly when the cost door would take the bill — both cadences, both flag values, both ways", () => {
      // The reminder and the door are two doorways on one rule. Collapsed both
      // ways: every bill the card raises, preCutoverCostRefusal accepts for
      // the period the card names; every bill it refuses, the card omits.
      // A FLAGGED schedule hands the gate its COVERED period (0170), so the
      // invariant is on the `bill_due:` card specifically — a flagged bill
      // the door refuses may still put a `bill_not_ours:` line up, which is
      // not a reminder to enter it.
      const flagged = { coversPriorPeriod: true };
      const cases = [
        { cutoverOn: "2027-01-01", today: "2026-12-15", bill: tax({ dueOn: "2026-11-10" })[0] },
        { cutoverOn: "2027-01-01", today: "2027-11-11", bill: tax({ dueOn: "2027-11-10", periodKey: "2027" })[0] },
        { cutoverOn: "2027-04-01", today: "2027-11-11", bill: tax({ dueOn: "2027-11-10", periodKey: "2027" })[0] },
        { cutoverOn: "2027-04-01", today: "2028-11-11", bill: tax({ dueOn: "2028-11-10", periodKey: "2028" })[0] },
        { cutoverOn: "2027-01-01", today: "2026-12-06", bill: sewer({ periodKey: "2026-12", dueOn: "2026-12-05" })[0] },
        { cutoverOn: "2027-01-01", today: "2027-01-06", bill: sewer({ periodKey: "2027-01", dueOn: "2027-01-05" })[0] },
        { cutoverOn: "2026-12-15", today: "2026-12-20", bill: sewer({ periodKey: "2026-12", dueOn: "2026-12-05" })[0] },
        { cutoverOn: "2026-12-15", today: "2027-01-06", bill: sewer({ periodKey: "2027-01", dueOn: "2027-01-05" })[0] },
        // Flagged: the 2026 tax due November 2027 is keyed on 2026 — refused
        // at a 1 January 2027 park; the 2027 tax due November 2028 is the
        // first that is his.
        { cutoverOn: "2027-01-01", today: "2027-11-11", bill: tax({ dueOn: "2027-11-10", periodKey: "2026", ...flagged })[0] },
        { cutoverOn: "2027-01-01", today: "2028-11-11", bill: tax({ dueOn: "2028-11-10", periodKey: "2027", ...flagged })[0] },
        // Flagged sewer: December's service billed 5 January is refused at a
        // 1 January park; January's service billed 5 February is taken.
        { cutoverOn: "2027-01-01", today: "2027-01-06", bill: sewer({ periodKey: "2026-12", dueOn: "2027-01-05", ...flagged })[0] },
        { cutoverOn: "2027-01-01", today: "2027-02-06", bill: sewer({ periodKey: "2027-01", dueOn: "2027-02-05", ...flagged })[0] },
        // Flagged, mid-month go-live: December STARTS before 15 December, so
        // the December bill (due 5 January) is refused; January's is taken.
        { cutoverOn: "2026-12-15", today: "2027-01-06", bill: sewer({ periodKey: "2026-12", dueOn: "2027-01-05", ...flagged })[0] },
        { cutoverOn: "2026-12-15", today: "2027-02-06", bill: sewer({ periodKey: "2027-01", dueOn: "2027-02-05", ...flagged })[0] },
      ];
      let raised = 0;
      let flaggedRaised = 0;
      for (const c of cases) {
        const card = generateTasks(facts({ cutoverOn: c.cutoverOn, today: c.today, billsDue: [c.bill] }));
        const doorTakes = preCutoverCostRefusal(c.bill.periodFrom.slice(0, 7), c.cutoverOn, prettyMonth, null) === null;
        expect(card.some((t) => t.key.startsWith("bill_due:")), `${c.bill.periodKey} at go-live ${c.cutoverOn}`).toBe(doorTakes);
        if (doorTakes) raised += 1;
        if (doorTakes && c.bill.coversPriorPeriod) flaggedRaised += 1;
      }
      // Both halves exercised, or the loop proved nothing: 4 unflagged and 3
      // flagged bills taken, 4 unflagged and 3 flagged refused.
      expect(cases.length).toBe(14);
      expect(raised).toBe(7);
      expect(flaggedRaised).toBe(3);
    });

    it("treats a mid-month go-live's own month as not ours", () => {
      // Go-live 15 Dec 2026: December began before us, so a bill due in
      // December is whoever-was-collecting's; January's is ours.
      expect(generateTasks(facts({
        cutoverOn: "2026-12-15", today: "2026-12-20",
        billsDue: sewer({ periodKey: "2026-12", periodLabel: "(bill due December 5)", dueOn: "2026-12-05" }),
      }))).toEqual([]);
      expect(generateTasks(facts({
        cutoverOn: "2026-12-15", today: "2027-01-06",
        billsDue: sewer({ periodKey: "2027-01", periodLabel: "(bill due January 5)", dueOn: "2027-01-05" }),
      })).length).toBe(1);
    });

    it("changes nothing for a park with no go-live date", () => {
      const [t] = generateTasks(facts({
        cutoverOn: null, today: "2026-12-15",
        billsDue: tax({ dueOn: "2026-11-10" }),
      }));
      expect(t?.title).toBe("Property tax due November 10, 2026 still isn't entered");
    });
  });

  // -------------------------------------------------------------------------
  // A SCHEDULE THAT SAYS ITS BILL IS FOR THE PERIOD BEFORE (0170).
  //
  // The owner's decision of 16 September. When the box is ticked, billPeriod
  // hands the loader the COVERED period — December for the sewer bill dated
  // 5 January, 2026 for the tax bill due 10 November 2027 — and the gate
  // compares that. So the seller's bills are gated out at a 1 January park
  // exactly as the cost door refuses them. But silence on 5 January, with
  // LaGrange's December envelope in his hand, reads as "the reminder is
  // broken" or "enter it" — and the door then refuses with a paragraph. So
  // the card becomes ONE dismissible line that names the envelope and where
  // it goes, and asks for nothing.
  //
  // Unflagged schedules keep today's silence (every `toEqual([])` above
  // stands); a bill due BEFORE go-live stays silent too — never his envelope.
  // -------------------------------------------------------------------------
  describe("a schedule that says its bill is for the period before", () => {
    const HAVEN = { cutoverOn: "2027-01-01" };
    /** The December sewer, billed 5 January, as billPeriod keys it when flagged. */
    const decemberSewer = (over: Record<string, unknown> = {}) => sewer({
      periodKey: "2026-12", periodLabel: "for December 2026 (bill due January 5)",
      periodFrom: "2026-12-01", dueOn: "2027-01-05", coversPriorPeriod: true, ...over,
    });

    it("on 5 January at a 1 January park: one line, not a reminder to enter it", () => {
      const cards = generateTasks(facts({ ...HAVEN, today: "2027-01-06", billsDue: decemberSewer() }));
      expect(cards).toHaveLength(1);
      const [t] = cards;
      expect(t.key).toBe("bill_not_ours:s1:2026-12");
      // "STARTS before", not "is from before" — for a go-live on the 15th
      // the December bill is half his, and the rule is about where the
      // period begins.
      expect(t.title).toBe("Sewer for December 2026 (bill due January 5) starts before you went live");
      // The detail IS the cost door's sentence — the reminder and the door
      // share one — so it names the go-live day and the closing statement.
      expect(t.detail).toContain("went live on January 1, 2027");
      expect(t.detail).toContain("closing statement");
      expect(t.detail).toBe(
        `${preCutoverCostRefusal("2026-12", "2027-01-01", prettyMonth, null)} ` +
        "'Sort it' opens the costs screen, which says the same — unless one of your " +
        "fees covers this bill, when it can still go in there as evidence for the fee comparison.",
      );
      expect(t.urgency).toBe("whenever");
      expect(t.canDismiss).toBe(true);
      expect(t.dueOn).toBeNull();
      expect(t.href).toBe("/park/costs");
      expect(cards.some((c) => c.key.startsWith("bill_due:"))).toBe(false);
    });

    it("the detail never says 'nothing to enter' — a fee-covered bill can still go in as evidence", () => {
      const [t] = generateTasks(facts({ ...HAVEN, today: "2027-01-06", billsDue: decemberSewer() }));
      expect(t.detail).not.toMatch(/nothing to enter/i);
      expect(t.detail).toMatch(/evidence for the fee comparison/);
    });

    it("collapsed: the same facts unflagged are today's silence", () => {
      expect(generateTasks(facts({
        ...HAVEN, today: "2027-01-06", billsDue: decemberSewer({ coversPriorPeriod: false }),
      }))).toEqual([]);
    });

    it("a bill due BEFORE go-live was never his envelope — silent", () => {
      // November's service, billed 5 December, at a park going live 1 January.
      expect(generateTasks(facts({
        ...HAVEN, today: "2026-12-20",
        billsDue: decemberSewer({ periodKey: "2026-11", periodLabel: "for November 2026 (bill due December 5)", periodFrom: "2026-11-01", dueOn: "2026-12-05" }),
      }))).toEqual([]);
    });

    it("the first covered period that is his gets the ordinary card, named by what it covers", () => {
      const [t] = generateTasks(facts({
        ...HAVEN, today: "2027-02-06",
        billsDue: decemberSewer({ periodKey: "2027-01", periodLabel: "for January 2027 (bill due February 5)", periodFrom: "2027-01-01", dueOn: "2027-02-05" }),
      }));
      expect(t?.key).toBe("bill_due:s1:2027-01");
      expect(t?.title).toBe("Sewer for January 2027 (bill due February 5) still isn't entered");
      expect(t?.urgency).toBe("overdue");
      expect(t?.canDismiss).toBe(false);
    });

    it("a mid-month go-live: December STARTS before 15 December, so its bill is the one line", () => {
      const [t] = generateTasks(facts({
        cutoverOn: "2026-12-15", today: "2027-01-06", billsDue: decemberSewer(),
      }));
      expect(t?.key).toBe("bill_not_ours:s1:2026-12");
      expect(t?.title).toMatch(/starts before you went live$/);
      expect(t?.detail).toContain("went live on December 15, 2026");
      expect(t?.detail).toContain("Your books here start with January 2027");
    });

    describe("the tax bill", () => {
      const tax2026 = (over: Record<string, unknown> = {}) => tax({
        periodKey: "2026", periodLabel: "for 2026, due November 10, 2027",
        periodFrom: "2026-01-01", dueOn: "2027-11-10", coversPriorPeriod: true, ...over,
      });

      it("the seller's 2026 tax, due November 2027, is the one line", () => {
        const [t] = generateTasks(facts({ ...HAVEN, today: "2027-11-11", billsDue: tax2026() }));
        expect(t?.key).toBe("bill_not_ours:s9:2026");
        expect(t?.title).toBe("Property tax for 2026, due November 10, 2027 starts before you went live");
        expect(t?.canDismiss).toBe(true);
      });

      it("the 28-day clip applies to the line too — nothing in October about November", () => {
        expect(generateTasks(facts({ ...HAVEN, today: "2027-10-01", billsDue: tax2026() }))).toEqual([]);
      });

      it("the 2027 tax, due November 2028, is the first that is his — the ordinary card", () => {
        const [t] = generateTasks(facts({
          ...HAVEN, today: "2028-11-11",
          billsDue: tax2026({ periodKey: "2027", periodLabel: "for 2027, due November 10, 2028", periodFrom: "2027-01-01", dueOn: "2028-11-10" }),
        }));
        expect(t?.key).toBe("bill_due:s9:2027");
        expect(t?.title).toBe("Property tax for 2027, due November 10, 2028 still isn't entered");
        expect(t?.canDismiss).toBe(false);
      });
    });

    it("a park with no go-live date has no 'before' — the flagged bill is an ordinary card", () => {
      const [t] = generateTasks(facts({ cutoverOn: null, today: "2027-01-06", billsDue: decemberSewer() }));
      expect(t?.key).toBe("bill_due:s1:2026-12");
    });

    it("the control the line names exists, with that label", () => {
      // "'Sort it' opens the costs screen" is a promise about a button in a
      // file this helper never imports. Pinned so the copy cannot outlive it.
      const card = readFileSync(fileURLToPath(new URL("../../components/ParkToday.tsx", import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(card).toMatch(/href=\{task\.href\}[\s\S]{0,200}?Sort it/);
      const [t] = generateTasks(facts({ ...HAVEN, today: "2027-01-06", billsDue: decemberSewer() }));
      expect(t.detail).toContain("'Sort it' opens the costs screen");
    });
  });
});

// ---------------------------------------------------------------------------

describe("money owed from earlier months stays on the to-do list", () => {
  /**
   * THE DEBT THAT LEFT THE LIST AT MIDNIGHT.
   *
   * `late_rent` is keyed `late_rent:<park>:<currentMonth>` and computed from
   * charges whose period_month IS the current month. Lot 6 never pays its July
   * rent; on 20 July the screen carries the non-dismissible task "1 household
   * is late — $256.00". At 00:00 on 1 August the month rolls, that charge
   * leaves the window, the task disappears, and no successor is ever generated
   * for it. At nineteen households one skipped month is roughly $2,700 that
   * quietly left the one surface designed to be non-dismissible about money.
   *
   * The money was never hidden — the arrears line renders in bold on the money
   * card. It was absent from the TASKS, and "Nothing needs you this morning"
   * could print directly beneath it.
   */

  it("raises a task for earlier months", () => {
    const tasks = generateTasks(facts({ arrearsCount: 1, arrearsAmount: 256 }));
    const t = tasks.find((x) => x.key.startsWith("arrears:"));
    expect(t).toBeTruthy();
    expect(t!.title).toContain("household owes");
    expect(t!.detail).toContain("256");
  });

  it("keys it on the park ALONE, so a month rollover cannot take it away", () => {
    const aug = generateTasks(facts({ currentMonth: "2026-08", arrearsCount: 1, arrearsAmount: 256 }));
    const sep = generateTasks(facts({ currentMonth: "2026-09", arrearsCount: 1, arrearsAmount: 256 }));
    const keyOf = (ts: ReturnType<typeof generateTasks>) =>
      ts.find((x) => x.key.startsWith("arrears:"))!.key;
    // The same key in both months. `late_rent` deliberately differs — that one
    // is re-raised monthly; this one must not vanish when the calendar turns.
    expect(keyOf(aug)).toBe(keyOf(sep));
    expect(keyOf(aug)).not.toContain("2026-08");
  });

  it("is never dismissible — the software must not offer to stop mentioning money", () => {
    const t = generateTasks(facts({ arrearsCount: 2, arrearsAmount: 900 }))
      .find((x) => x.key.startsWith("arrears:"))!;
    expect(t.canDismiss).toBe(false);
    expect(t.urgency).toBe("overdue");
  });

  it("stays separate from this month's late rent, because they are different jobs", () => {
    const tasks = generateTasks(facts({
      lateCount: 3, lateAmount: 1365,
      arrearsCount: 1, arrearsAmount: 256,
    }));
    const arrears = tasks.filter((t) => t.key.startsWith("arrears:"));
    const late = tasks.filter((t) => t.key.startsWith("late_rent:"));
    expect(arrears).toHaveLength(1);
    expect(late).toHaveLength(1);
    // And neither figure swallows the other.
    expect(arrears[0].detail).toContain("256");
    expect(late[0].detail).toContain("1,365");
  });

  it("counts HOUSEHOLDS, the same figure the money card prints — one household with two open months is one", () => {
    const rows = toRows([
      charge({ id: "jan", lotNumber: "14", periodMonth: "2027-01", dueOn: "2027-01-01", amount: 542.53 }),
      charge({ id: "feb", lotNumber: "14", periodMonth: "2027-02", dueOn: "2027-02-01", amount: 542.53 }),
    ], "2027-03-01", 3, new Set());
    const card = moneyBlock({ monthToDateCents: 0, todayCents: 0, monthSummary: summarise([]), lagDays: 3, arrears: rows, today: "2027-03-01" });
    expect(card.arrearsLine).toContain("1 household,");
    // Wired exactly as today-actions wires it.
    const [t] = generateTasks(facts({ currentMonth: "2027-03", arrearsCount: householdsIn(rows), arrearsAmount: rows.reduce((s2, r) => s2 + r.balance, 0) }));
    expect(t.title).toBe("1 household owes from earlier months");
    expect(t.detail).toBe("$1,085.06 still outstanding from before March 2027.");
    expect(t.detail).not.toMatch(/2027-03/);
    // Collapsed the other way: the row count would have said two.
    expect(householdsIn(rows)).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("says nothing when nothing is owed from earlier months", () => {
    const tasks = generateTasks(facts({ arrearsCount: 0, arrearsAmount: 0 }));
    expect(tasks.some((t) => t.key.startsWith("arrears:"))).toBe(false);
  });

  it("the loader feeds it, and the quiet line consults the money block", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./today-actions.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // arrears was computed and handed ONLY to moneyBlock — and then handed
    // as a ROW count: one row per bill, so a household with January and
    // February open read "2 households owe" beside the money card's "1
    // household". The same helper the money block counts with.
    expect(src).toMatch(/arrearsCount: householdsIn\(arrears\)/);
    expect(src).not.toMatch(/arrearsCount: arrears\.length/);
    expect(src).toMatch(/arrearsAmount: arrears\.reduce/);
    // "Nothing needs you this morning." must not print under a debt. A
    // disputed older bill generates no task by design, so quiet consults the
    // money block directly rather than trusting tasks.length alone.
    expect(src).toMatch(/money\.arrearsLine === null && money\.disputedLine === null/);
  });
});

// ---------------------------------------------------------------------------

describe("money that arrived without a bill behind it", () => {
  const empty = summarise([]);

  /**
   * "NOTHING HAS COME IN YET THIS MONTH" ON A MONTH THE OFFICE BANKED CASH.
   *
   * `park_payments.charge_id` has been nullable since 0102, and three kinds of
   * money legitimately have none: a deposit (park_payments_deposit_is_held
   * REQUIRES charge_id to be null), amenity income, and rent handed over
   * before its bill exists. The Today read was keyed on `.in("charge_id",
   * allIds)`, so none of it counted — and the `allIds.length` guard in front
   * of it meant that before a park's first charge run, when there are no bills
   * at all, the read was skipped and EVERY payment vanished.
   *
   * I refuted this finding earlier in the session on the grounds that
   * charge_id is NOT NULL. It was, in 0070. 0102 dropped it.
   */

  it("no longer says NOTHING when only billless money came in", () => {
    const b = moneyBlock({
      monthToDateCents: 50_000, todayCents: 0, monthSummary: empty,
      offBookCents: 50_000, offBookKinds: ["deposit"],
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.headline).toBe("$500.00 in so far this month.");
    expect(b.headline).not.toContain("Nothing");
  });

  it("names the part that is not rent, so the two numbers reconcile", () => {
    // The headline is every dollar banked. The ledger line under it counts
    // bills only. Without this sentence they simply disagree and he cannot
    // tell which is wrong.
    const b = moneyBlock({
      monthToDateCents: 484_200, todayCents: 0, monthSummary: empty,
      offBookCents: 50_000, offBookKinds: ["deposit"],
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.headline).toBe("$4,842.00 in so far this month.");
    expect(b.offBookLine).toBe(
      "$500.00 of that is deposit money you're holding. The rent line below counts bills only.",
    );
  });

  it("stays silent when every dollar was against a bill", () => {
    const b = moneyBlock({
      monthToDateCents: 432_500, todayCents: 0, monthSummary: empty,
      lagDays: 3, arrears: [], today: TODAY,
    });
    expect(b.offBookLine).toBeNull();
  });

  it("names each kind, in a fixed order, never committing to a singular", () => {
    // The caller passes which KINDS are present, not how many rows, so a
    // sentence saying "a deposit" would be wrong the moment there are two.
    expect(describeOffBook(["deposit"])).toBe("deposit money you're holding");
    expect(describeOffBook(["rent"])).toBe("money on account — counted the day it arrived, whichever bills it goes against");
    expect(describeOffBook(["amenity"])).toBe("income from something the park rents out");
    expect(describeOffBook(["rent", "deposit"])).toBe(
      "deposit money you're holding and money on account — counted the day it arrived, whichever bills it goes against",
    );
    // Order comes from the list, not from whatever order the rows arrived in.
    expect(describeOffBook(["rent", "deposit"])).toBe(describeOffBook(["deposit", "rent"]));
    expect(describeOffBook(["amenity", "deposit", "rent"])).toBe(
      "deposit money you're holding, income from something the park rents out and money on account — counted the day it arrived, whichever bills it goes against",
    );
  });

  it("never asserts 'not yet put against a bill' about a figure that counts money the run has spent", () => {
    // The Today block is a cash-received figure — every dollar that came in
    // this month. Since 0167 the run and the recording door put money on
    // account against bills the moment either exists, so a label asserting
    // it is "not yet put against a bill" is false the morning after the
    // first run. Pinned on the SOURCE, comments stripped, so a rewording
    // that quietly reintroduces the claim fails here.
    const src = readFileSync(fileURLToPath(new URL("./today-helpers.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/rent: "money on account/);
    expect(src).not.toMatch(/not yet put against/);
    expect(src).not.toMatch(/not yet against/);
    expect(describeOffBook(["rent"])).not.toMatch(/not yet/);
  });

  it("falls back to plain English for a kind nobody has added yet", () => {
    // A fourth kind would otherwise render "undefined" on his morning screen.
    expect(describeOffBook(["storage"])).toBe("not rent against a bill");
    expect(describeOffBook([])).toBe("not rent against a bill");
  });
});

describe("the read behind it", () => {
  /**
   * STRIPPED FIRST. The doc block above this read explains the defect at
   * length, and it names `allIds.length` and `.in("charge_id"` while doing it
   * — so an unstripped scan is satisfied by the explanation of the bug rather
   * than by its absence. The first version of these tests failed exactly that
   * way, which is the only reason they are worth having.
   */
  const src = readFileSync(
    fileURLToPath(new URL("./today-actions.ts", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the scanner is reading real code, not prose", () => {
    expect(src).toContain('from("park_payments")');
    expect(src).not.toContain("EVERY payment");
  });

  it("a lot whose paperwork ran out is TAKEN, never 'Empty' — the roll's own rule (RollRow.lapsed), and short stays are not lapsed", () => {
    // Today derived occupied/reserved/vacant itself, not through summarise(),
    // so a household living on lot 9 past a lapsed monthly agreement read as
    // "Empty: lot 9" here while the roll said "Ran out" beside their name.
    const stmt = src.split("\n").join(" ").match(/const occupiedLotIds = new Set<string>\(\);[\s\S]*?const vacantLots/);
    expect(stmt).not.toBeNull();
    const block = stmt![0];
    expect(block).toContain("const lapsedLotIds = new Set<string>();");
    // THE RULE HAS ONE HOME — park-helpers lapsedRowOf, which the roll and
    // the nightly read too. This loader used to carry its own copy (an
    // inline ["nightly", "weekly"] and its own "later agreement wins"
    // deletes), which is how a household closed out of its successor stayed
    // "taken" here: the copy never saw the ended row.
    expect(block).toMatch(/if \(lapsedRowOf\(rows, today\)\) lapsedLotIds\.add\(lotId\);/);
    expect(block).not.toMatch(/\["nightly", ?"weekly"\]/);
    expect(block).not.toMatch(/r\.end <= today/);
    // A lapsed lot counts as taken.
    expect(block).toContain("for (const id of lapsedLotIds) occupiedLotIds.add(id);");
    // The read carries the term the rule branches on, and the ENDED rows the
    // close-out test needs — split into `stays` (held only) for every list.
    const read = src.split("\n").join(" ").match(/from\("lot_reservations"\)\s*\.select\("([^"]*)"\)\s*\.in\("park_lot_id", liveIds\)\s*\.in\("status", \[([^\]]*)\]\)/);
    expect(read).not.toBeNull();
    expect(read![1].split(", ")).toContain("term");
    expect(read![2]).toBe('"approved", "active", "ended"');
    expect(src).toContain('const stays = (everyRow ?? []).filter((s) => s.status === "approved" || s.status === "active");');
    // The lapsed test and the chain map see every row; the lists see `stays`.
    expect(src).toMatch(/for \(const s of everyRow \?\? \[\]\) \{\s*const list = rowsOfLot/);
    expect(src).toMatch(/const chains = latestSeqByChain\(\s*\(everyRow \?\? \[\]\)\.map/);
    expect(src).toMatch(/const agreements = stays\.flatMap/);
    expect(src).toMatch(/noticed: stays\s*\.filter/);
  });

  it("asks the park for its payments, not the bills for theirs", () => {
    // 0102 made park_payments.park_id NOT NULL, so this key reaches every row
    // — including the ones no charge points at.
    const stmt = src
      .split("\n")
      .join(" ")
      .match(/from\("park_payments"\)[\s\S]{0,600}?;/);
    expect(stmt).not.toBeNull();
    expect(stmt![0]).toContain('.eq("park_id", parkId)');
  });

  it("never filters that read by charge id again", () => {
    // The exact shape of the defect. `.in("charge_id", ...)` is the whole bug.
    const stmt = src
      .split("\n")
      .join(" ")
      .match(/from\("park_payments"\)[\s\S]{0,600}?;/);
    expect(stmt![0]).not.toMatch(/\.in\("charge_id"/);
  });

  it("does not gate the read on any bills existing", () => {
    // `allIds.length ? mustRead(...) : []` was why a park with no charge run
    // yet showed none of its own money.
    const stmt = src
      .split("\n")
      .join(" ")
      .match(/allIds\.length[\s\S]{0,400}?park_payments/);
    expect(stmt).toBeNull();
  });

  /**
   * ON THE GO-LIVE DAY THE PARK IS HIS.
   *
   * The gate read `cutoverOn >= today`, so the readiness checklist stayed up
   * for one day too many — and ParkToday renders the checklist INSTEAD of the
   * money card, not beside it. With go-live 1 Jan 2027 and rent due on the
   * 1st, that is the morning nineteen bills fall due, and he would have opened
   * the app to a setup list.
   */
  it("stops showing the readiness checklist ON the go-live day", () => {
    expect(src).toMatch(/cutoverOn\s*>\s*today/);
    expect(src).not.toMatch(/cutoverOn\s*>=\s*today/);
  });

  it("still keeps the labelled receipts to rows that HAVE a bill", () => {
    // Every label on a Receipt — lot, period, bill total, bill status — comes
    // off the charge. Folding billless rows in would give them "?" and "", and
    // would double-count them into the month total.
    expect(src).toMatch(/filter\(\(p\) => p\.charge_id != null\)/);
  });

  it("hands the gate the bill's own period start, straight from billPeriod", () => {
    // The go-live gate compares `periodFrom`; if the loader stopped passing
    // `p.from` here the type would catch it, but a literal (say the due date)
    // would not — and the reminder and the cost door would disagree again.
    expect(src).toMatch(/periodFrom:\s*p\.from/);
  });

  /**
   * THE FLAG REACHES billPeriod, AND THE CLEAR RULE HAS ONE HOME (0170).
   *
   * A column the loader does not select is a column with no reader; a flag
   * read but not handed to billPeriod is a card keyed on the wrong period;
   * and the two-signal clear rule inlined here beside a copy in cost-helpers
   * is two rules that drift. Each is a source shape, so each is pinned.
   */
  it("reads covers_prior_period off the schedule and hands it to billPeriod", () => {
    const stmt = src.split("\n").join(" ").match(/from\("park_cost_schedules"\)[\s\S]{0,300}?\)/);
    expect(stmt).not.toBeNull();
    expect(stmt![0]).toContain("covers_prior_period");
    expect(src).toMatch(/billPeriod\(\s*[\s\S]*?,\s*Boolean\(sc\.covers_prior_period\),?\s*\)/);
    // And the card is told from the same result, never from a second read.
    expect(src).toMatch(/coversPriorPeriod:\s*p\.coversPriorPeriod/);
  });

  it("asks costAnswersBill instead of keeping its own copy of the clear rule", () => {
    expect(src).toMatch(/costAnswersBill\(/);
    // The inline `>=` workaround, in the shape it had.
    expect(src).not.toMatch(/period_end \?\? ""\) >= p\.from/);
  });

  it("fetches costs back to last 1 January — a flagged annual bill covers the year before", () => {
    const stmt = src.split("\n").join(" ").match(/from\("park_costs"\)\s*\.select\("category, period_start[\s\S]{0,300}?\.or\([^)]*\)/);
    expect(stmt).not.toBeNull();
    expect(stmt![0]).toContain("priorYear");
    expect(src).toMatch(/const priorYear = String\(Number\(year\) - 1\)/);
  });
});

describe("the control the copy names", () => {
  /**
   * Two sentences — the 'households haven't signed' card and the fee page —
   * tell him to record a signature "from their row on the rent roll ('They
   * signed the new lease')". That is a button's label, and the button lives in
   * a file neither sentence imports. If it is renamed or removed, both
   * sentences become an instruction for an action the screen lacks. Pinned
   * here so the copy cannot outlive the control.
   */
  const roll = readFileSync(
    fileURLToPath(new URL("../../components/ParkRentRoll.tsx", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("the scanner is reading real JSX, not prose", () => {
    expect(roll).toContain("ParkRentRoll");
    expect(roll).toMatch(/<button/);
  });

  it("the rent roll still has the 'They signed the new lease' control the card sends him to", () => {
    // ONE HOME FOR THE WORDS. The roll renders SIGNED_LEASE_LABEL on its
    // button (anchored on the JSX expression, so a comment that merely
    // mentions it cannot satisfy this), the constant IS these words, and the
    // card's own sentence renders the same constant — so the three cannot
    // drift apart, and the words a person reads are pinned here in full.
    expect(SIGNED_LEASE_LABEL).toBe("They signed the new lease");
    expect(roll).toMatch(/import \{[^}]*\bSIGNED_LEASE_LABEL\b[^}]*\} from "@\/app\/park\/sign-helpers"/);
    // The constant is a <button>'s own child — the words on the control.
    expect(roll).toMatch(/\bSIGNED_LEASE_LABEL\}\s*<\/button>/);
    const [t] = generateTasks(facts({ holdoverLots: ["4"] }));
    expect(t.detail).toContain("'They signed the new lease'");
    // And the fees screen, which makes the same promise, uses the same home.
    const fees = readFileSync(
      fileURLToPath(new URL("../../components/ParkFees.tsx", import.meta.url)), "utf8",
    ).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(fees).toMatch(/\{SIGNED_LEASE_LABEL\}/);
    expect(fees).not.toMatch(/They signed the new lease/);
  });
});

// ---------------------------------------------------------------------------
// MONEY TO HAND BACK (0168). A household has left, their last month is
// billed, and the park still holds money of theirs — on account, where no
// bill will ever take it, or a deposit. Fed from the held panel's own read;
// never dismissible, so the quiet state cannot print over a liability.
// ---------------------------------------------------------------------------
describe("money held for a household that has left", () => {
  const nine = { renterId: "renter-9", renterName: "Household 9", movedOutOn: "2027-01-27", finalMonthBilled: true, onAccount: 57.47, depositsHeld: 0 };

  it("raises a named, non-dismissible card that says how much, when they left, and where the door is", () => {
    const [t] = generateTasks(facts({ today: "2027-02-01", currentMonth: "2027-02", heldForDeparted: [nine] }));
    expect(t.key).toBe("hand_back:renter-9");
    expect(t.title).toBe("Money to hand back — Household 9");
    expect(t.detail).toBe(
      "$57.47 on account: they moved out January 27, 2027 and nothing more bills for them. " +
      "Hand it back from \"Money not against a bill\" on the Rent screen, or put it against a bill of theirs if one is still open.",
    );
    expect(t.detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(t.canDismiss).toBe(false);
    expect(t.href).toBe("/park/rent");
  });

  it("a deposit still held says so, with its own door; both together are one card", () => {
    const [dep] = generateTasks(facts({ heldForDeparted: [{ ...nine, onAccount: 0, depositsHeld: 500 }] }));
    expect(dep.detail).toMatch(/^\$500\.00 deposit: they moved out January 27, 2027 and nothing more bills for them\. Give it back from "Money not against a bill" on the Rent screen — or keep some, with a reason\.$/);
    const [both] = generateTasks(facts({ heldForDeparted: [{ ...nine, depositsHeld: 500 }] }));
    expect(both.detail).toMatch(/^\$57\.47 on account and \$500\.00 deposit: /);
    expect(generateTasks(facts({ heldForDeparted: [{ ...nine, depositsHeld: 500 }] }))).toHaveLength(1);
  });

  it("'nothing more bills for them' is said ONLY when their final month is billed — a deposit listed before the run names the bill still to come", () => {
    // Moved out on 2 February, closed out before the office pressed Bill
    // February: the deposit is held, the two-day part-month is still to be
    // raised. The card used to promise "nothing more bills" here; the office
    // handed the deposit back and the arrears task chased a household that
    // had gone.
    const early = { ...nine, movedOutOn: "2027-02-02", finalMonthBilled: false, onAccount: 0, depositsHeld: 500 };
    const [dep] = generateTasks(facts({ today: "2027-02-03", currentMonth: "2027-02", heldForDeparted: [early] }));
    expect(dep.title).toBe("Money to hand back — Household 9");
    expect(dep.detail).toBe(
      "$500.00 deposit: they moved out February 2, 2027; their final month isn't billed yet — it's raised when you bill February 2027. " +
      "Give it back from \"Money not against a bill\" on the Rent screen — or keep some, with a reason.",
    );
    expect(dep.detail).not.toMatch(/nothing more bills/);
    expect(dep.detail).not.toMatch(/\d{4}-\d{2}/);
    expect(dep.canDismiss).toBe(false);
    // With money on account in the same card (the loader lists it only once
    // the month is billed, but the sentence is true of the shape either
    // way): the run takes that money first.
    const [both] = generateTasks(facts({ heldForDeparted: [{ ...early, onAccount: 57.47 }] }));
    expect(both.detail).toMatch(/^\$57\.47 on account and \$500\.00 deposit: they moved out February 2, 2027; their final month isn't billed yet — it's raised when you bill February 2027, which takes anything on account first\. Hand it back/);
    // Collapsed the other way: billed, and the old promise is back because it is true.
    const [billed] = generateTasks(facts({ heldForDeparted: [{ ...early, finalMonthBilled: true }] }));
    expect(billed.detail).toMatch(/they moved out February 2, 2027 and nothing more bills for them\. Give it back/);
    expect(billed.detail).not.toMatch(/isn't billed yet/);
  });

  it("nothing held means no card, and a zero row is not a card", () => {
    expect(generateTasks(facts({ heldForDeparted: [] }))).toEqual([]);
    expect(generateTasks(facts({ heldForDeparted: [{ ...nine, onAccount: 0, depositsHeld: 0 }] }))).toEqual([]);
  });

  it("the loader feeds it from the held panel's read, on BOTH facts, and the quiet state cannot print over it", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./today-actions.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import \{ getHeldMoney \} from "\.\/money-actions"/);
    expect(src).toMatch(/const held = await getHeldMoney\(parkId\)/);
    expect(src).toMatch(/r\.tenancyEnded && r\.finalMonthBilled && r\.remaining > 0/);
    expect(src).toMatch(/d\.tenancyEnded && !d\.returnedOn/);
    expect(src).toMatch(/heldForDeparted,/);
    // The household carries the fact the sentence branches on — from the
    // row, never asserted: `finalMonthBilled: r.finalMonthBilled`.
    expect(src).toMatch(/finalMonthBilled: r\.finalMonthBilled/);
    expect(src).not.toMatch(/finalMonthBilled: (true|false)\b/);
    // The card is a task, so `tasks.length === 0` is false and quiet is null.
    const facts2 = facts({ heldForDeparted: [nine] });
    expect(generateTasks(facts2).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// EVERY DAY AND EVERY FIGURE A PERSON READS IS IN WORDS. Today printed "You
// go live on 2027-01-01", "oldest due 2027-01-01", "from before 2027-02" and
// the rent screen "$1085.06 of $11620.20 in." beside tiles reading
// "$11,620.20". dayInWords, prettyMonth and money() were all one import away.
// ---------------------------------------------------------------------------
describe("months and days in words, and one money() shape, across the office's sentences", () => {
  it("the readiness panel names the go-live day in words", () => {
    const p = preCutover({
      today: "2026-12-20", cutoverOn: "2027-01-01", parkName: "The Haven",
      lots: 21, lotsWithRates: 21, monthlyRoll: 8400, households: 0, rentDueDay: 1, maxAgreementMonths: 6,
    });
    expect(p.sub).toBe("You go live on January 1, 2027. Nothing is collectable until then.");
    expect(p.headline).toBe("The Haven — 12 days to go-live.");
  });

  it("no sentence in today-helpers, ledger-helpers, money-actions, ledger-actions or today-actions builds a figure with toFixed", () => {
    // A `$${x.toFixed(2)}` inside a template literal is a second formatter
    // for a number the same screen prints through money(). Scanned with
    // comments stripped, and the scan proves it still finds sentences.
    const strip = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const rel of ["./today-helpers.ts", "./ledger-helpers.ts", "./money-actions.ts", "./ledger-actions.ts", "./today-actions.ts"]) {
      const src = strip(rel);
      // today-actions builds no money sentence of its own (its figures go
      // through moneyBlock); the other four must still be found doing so, or
      // this scan is measuring nothing.
      if (rel !== "./today-actions.ts") {
        expect((src.match(/`[^`]*\$\{money\(/g) ?? []).length, `${rel}: no money() sentences found — this scan is measuring nothing`).toBeGreaterThan(2);
      }
      expect(src.match(/`[^`]*\.toFixed\(2\)[^`]*`/g) ?? [], `${rel}: a sentence built with toFixed`).toEqual([]);
      expect(src, `${rel}: a private money() beside the imported one`).not.toMatch(/^const money = /m);
    }
    // ledger-helpers OWNS money(); the other two import it.
    expect(strip("./ledger-helpers.ts")).toMatch(/^export const money = /m);
    expect(strip("./today-helpers.ts")).toMatch(/import \{[^}]*\bmoney\b[^}]*\} from "\.\/ledger-helpers"/);
    expect(strip("./money-actions.ts")).toMatch(/import \{[^}]*\bmoney\b[^}]*\} from "@\/lib\/allocations"/);
    expect(strip("./ledger-actions.ts")).toMatch(/import \{[^}]*\bmoney\b[^}]*\} from "@\/lib\/allocations"/);
    // AND NO ISO DAY IN A SENTENCE: `${until}` / `${leaving}` where a person
    // reads it. Every `${x}` that is a YYYY-MM-DD input in these files goes
    // through dayInWords; the snooze toast said "Back on 2027-02-01".
    expect(strip("./today-actions.ts")).toMatch(/Back on \$\{dayInWords\(until\)\}/);
  });

  it("the arrears task and the money card name the month and the day in words", () => {
    const [t] = generateTasks(facts({ currentMonth: "2027-02", arrearsCount: 1, arrearsAmount: 542.53 }));
    expect(t.detail).toBe("$542.53 still outstanding from before February 2027.");
    const rows = toRows([charge({ periodMonth: "2027-01", dueOn: "2027-01-01", amount: 542.53 })], "2027-02-10", 3, new Set());
    const card = moneyBlock({ monthToDateCents: 0, todayCents: 0, monthSummary: summarise([]), lagDays: 3, arrears: rows, today: "2027-02-10" });
    expect(card.arrearsLine).toBe("$542.53 still owing from earlier months — 1 household, oldest due January 1, 2027 (40 days).");
  });
});
