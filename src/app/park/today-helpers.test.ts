import { describe, it, expect } from "vitest";
import {
  moneyBlock, occupancyLine, generateTasks, visibleTasks, quietState, preCutover,
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
  disputedCount: 0,
  unallocatedCosts: [],
  pendingRentChanges: [],
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
    expect(soon[0].title).toBe("2026-08 isn't billed yet");
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

describe("before the park is his", () => {
  const base = {
    today: TODAY, cutoverOn: "2026-12-15", parkName: "The Haven",
    lots: 21, lotsWithRates: 21, monthlyRoll: 5200, households: 0,
    rentDueDay: 1, maxAgreementMonths: 3,
  };

  it("counts down to closing rather than showing an empty park", () => {
    const p = preCutover(base);
    expect(p.headline).toBe("The Haven — 126 days to closing.");
    expect(p.sub).toMatch(/Nothing is collectable/);
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
