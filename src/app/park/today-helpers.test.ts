import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  moneyBlock, describeOffBook, occupancyLine, generateTasks, visibleTasks, quietState, preCutover,
  addDays, daysBetween, ordinal,
  type TaskFacts, type OccupancySnapshot,
} from "./today-helpers";
import { toRows, summarise, type Charge } from "./ledger-helpers";

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
    expect(b.arrearsLine).toContain("2026-06-01");
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
        endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: false,
      }],
    }));
    expect(t.title).toBe("Lot 3's agreement ends in 30 days");
    expect(t.detail).toMatch(/rent stops being billed/);
  });

  it("does NOT nag when the next agreement already exists", () => {
    expect(generateTasks(facts({
      agreements: [{
        reservationId: "r1", lotNumber: "3", renterName: null,
        endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: true,
      }],
    }))).toEqual([]);
  });

  it("keys renewals per SEQUENCE, so dismissing one doesn't hide the next", () => {
    const a = generateTasks(facts({
      agreements: [{ reservationId: "r1", lotNumber: "3", renterName: null,
        endsOn: "2026-09-10", chainId: "ch1", seq: 3, hasSuccessor: false }],
    }))[0];
    // Both inside the 45-day window, or the second produces no card at all
    // and the test proves nothing.
    const b = generateTasks(facts({
      agreements: [{ reservationId: "r2", lotNumber: "3", renterName: null,
        endsOn: "2026-09-20", chainId: "ch1", seq: 4, hasSuccessor: false }],
    }))[0];
    expect(a.key).not.toBe(b.key);
  });

  it("collapses a pile of renewals into one card", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      reservationId: `r${i}`, lotNumber: String(i), renterName: null,
      endsOn: `2026-09-${String(10 + i).padStart(2, "0")}`,
      chainId: `ch${i}`, seq: 1, hasSuccessor: false,
    }));
    const ts = generateTasks(facts({ agreements: many }));
    expect(ts).toHaveLength(1);
    expect(ts[0].title).toBe("6 agreements are running out");
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
    expect(t.title).toContain("needs its rent notice by 2026-08-11");
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
    expect(t.title).toMatch(/can't start 2026-09-25/);
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
        endsOn: "2026-09-10", chainId: "ch1", seq: 1, hasSuccessor: false }],
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
    expect(t.title).toBe("Lot 7 was due to leave on 2026-08-02");
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
  });

  it("survives a household with no name on file", () => {
    const [t] = generateTasks(facts({ noticed: one({ renterName: null }) }));
    expect(t.detail).toMatch(/^Out on 2026-08-30/);
  });
});

describe("who still hasn't signed", () => {
  it("names the holdover lots, because chasing a signature is a door-knock", () => {
    const [t] = generateTasks(facts({ holdoverLots: ["4", "9"] }));
    expect(t.title).toBe("2 households haven't signed the new lease");
    expect(t.detail).toContain("Lots 4, 9");
    expect(t.detail).toMatch(/cap doesn't apply to them yet/);
  });

  it("says nothing at all once everybody has signed", () => {
    expect(generateTasks(facts({ holdoverLots: [] }))).toEqual([]);
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
  const sewer = (over: Record<string, unknown> = {}) => [{
    scheduleId: "s1", category: "sewer", label: "Sewer",
    periodKey: "2026-08", periodLabel: "August 2026",
    dueOn: "2026-08-05", typical: 1433.17, ...over,
  }];

  it("says what to expect, so a wrong invoice is noticeable", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ dueOn: "2026-08-20" }) }));
    expect(t.title).toBe("Sewer for August 2026 is due about now");
    expect(t.detail).toContain("$1,433.17");
    expect(t.urgency).toBe("soon");
  });

  it("escalates once the day has passed", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ dueOn: "2026-08-05" }) }));
    expect(t.title).toBe("Sewer for August 2026 still isn't entered");
    expect(t.urgency).toBe("overdue");
  });

  // NEVER DISMISSIBLE. The software must not offer to stop mentioning a bill
  // nineteen households are waiting to be charged their share of.
  it("cannot be dismissed", () => {
    expect(generateTasks(facts({ billsDue: sewer() }))[0].canDismiss).toBe(false);
  });

  it("says the month in words, not 2026-08", () => {
    const [t] = generateTasks(facts({ billsDue: sewer() }));
    expect(t.title).toContain("August 2026");
    expect(t.title).not.toContain("2026-08");
  });

  it("manages without a typical amount rather than inventing one", () => {
    const [t] = generateTasks(facts({ billsDue: sewer({ typical: null }) }));
    expect(t.detail).not.toMatch(/\$/);
    expect(t.detail).toMatch(/splits across the lots/);
  });

  // A NEW PARK HAS NO SCHEDULES AND SEES NOTHING. Nothing about The Haven is
  // a default for somebody else's park.
  it("is silent for a park that has set none up", () => {
    expect(generateTasks(facts({ billsDue: [] }))).toEqual([]);
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

  it("says nothing when nothing is owed from earlier months", () => {
    const tasks = generateTasks(facts({ arrearsCount: 0, arrearsAmount: 0 }));
    expect(tasks.some((t) => t.key.startsWith("arrears:"))).toBe(false);
  });

  it("the loader feeds it, and the quiet line consults the money block", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./today-actions.ts", import.meta.url)), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // arrears was computed and handed ONLY to moneyBlock.
    expect(src).toMatch(/arrearsCount: arrears\.length/);
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
    expect(describeOffBook(["rent"])).toBe("money on account, not yet put against a bill");
    expect(describeOffBook(["amenity"])).toBe("income from something the park rents out");
    expect(describeOffBook(["rent", "deposit"])).toBe(
      "deposit money you're holding and money on account, not yet put against a bill",
    );
    // Order comes from the list, not from whatever order the rows arrived in.
    expect(describeOffBook(["rent", "deposit"])).toBe(describeOffBook(["deposit", "rent"]));
    expect(describeOffBook(["amenity", "deposit", "rent"])).toBe(
      "deposit money you're holding, income from something the park rents out and money on account, not yet put against a bill",
    );
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
});
