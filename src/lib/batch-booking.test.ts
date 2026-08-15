import { describe, it, expect } from "vitest";
import {
  MAX_BATCH_DATES,
  batchOutcomeCopy,
  normalizeBatchDates,
  planBatchDates,
  prettyDateList,
  refusalFor,
  refusalLines,
} from "./batch-booking";
import type { DayContext } from "./booking";

// Big Long Lake 2026: ice-out Mar 21, pull deadline Nov 14. Today is Jul 16,
// 9am lake time — inside the rush window (cutoff 2pm), so TODAY is bookable
// at the rush rate and yesterday is not bookable at all.
const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  today: "2026-07-16",
  isWaterWork: false,
  seasonStart: "2026-03-21",
  seasonEnd: "2026-11-14",
  fullDates: new Set<string>(),
  rushNowHour: 9,
  rushCutoffHour: 14,
  ...over,
});

describe("normalizeBatchDates — cleaning what the browser sent", () => {
  it("sorts ascending so the customer's click order can't scramble the batch", () => {
    expect(normalizeBatchDates(["2026-07-30", "2026-07-17", "2026-07-24"]).dates)
      .toEqual(["2026-07-17", "2026-07-24", "2026-07-30"]);
  });

  it("the same day twice is ONE visit, not a refusal", () => {
    const { dates, refused } = normalizeBatchDates(["2026-07-17", "2026-07-17"]);
    expect(dates).toEqual(["2026-07-17"]);
    expect(refused).toEqual([]);
  });

  it("a string that isn't a date is refused BY NAME, never dropped", () => {
    const { dates, refused } = normalizeBatchDates(["2026-07-17", "2026-02-31", "nope"]);
    expect(dates).toEqual(["2026-07-17"]);
    expect(refused.map((r) => r.date)).toEqual(["2026-02-31", "nope"]);
    expect(refused.every((r) => r.reason === "That isn't a real date.")).toBe(true);
  });

  it("dates past the cap come back named — the list is never silently truncated", () => {
    const many = Array.from({ length: MAX_BATCH_DATES + 3 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
    const { dates, refused } = normalizeBatchDates(many);
    expect(dates).toHaveLength(MAX_BATCH_DATES);
    expect(refused).toHaveLength(3);
    expect(dates.length + refused.length).toBe(many.length);
    expect(refused[0].reason).toContain(`Only ${MAX_BATCH_DATES} visits`);
  });

  it("an empty pick is empty, not an exception", () => {
    expect(normalizeBatchDates([]).dates).toEqual([]);
    expect(normalizeBatchDates(null).dates).toEqual([]);
  });
});

describe("planBatchDates — EVERY date is validated, not just the first", () => {
  it("all-clear dates all come back ok", () => {
    const plan = planBatchDates(["2026-07-17", "2026-07-24", "2026-07-31"], ctx());
    expect(plan.every((p) => p.ok)).toBe(true);
    expect(plan.every((p) => p.isRush)).toBe(false);
  });

  it("a good first date does NOT wave through a bad second one", () => {
    const plan = planBatchDates(["2026-07-17", "2026-07-01"], ctx());
    expect(plan[0]).toMatchObject({ date: "2026-07-17", ok: true });
    expect(plan[1]).toMatchObject({ date: "2026-07-01", ok: false, reason: "That date has passed." });
  });

  it("a full day is refused inside a batch of otherwise-fine days", () => {
    const plan = planBatchDates(
      ["2026-07-17", "2026-07-24", "2026-07-31"],
      ctx({ fullDates: new Set(["2026-07-24"]) }),
    );
    expect(plan.map((p) => p.ok)).toEqual([true, false, true]);
    expect(plan[1].reason).toBe("That day's crew is full — pick another.");
  });

  it("water work honours each date against the lake's season (rule 7)", () => {
    const plan = planBatchDates(["2026-11-10", "2026-11-20"], ctx({ isWaterWork: true }));
    expect(plan[0].ok).toBe(true);
    expect(plan[1]).toMatchObject({ ok: false, reason: "That date is outside this lake's water-work season." });
  });

  it("land work ignores the season — a December mow is fine", () => {
    expect(planBatchDates(["2026-12-05"], ctx())[0].ok).toBe(true);
  });

  it("only TODAY is rush; the rest of the batch is standard", () => {
    const plan = planBatchDates(["2026-07-16", "2026-07-17", "2026-07-24"], ctx());
    expect(plan.map((p) => p.isRush)).toEqual([true, false, false]);
    expect(plan.every((p) => p.ok)).toBe(true);
  });

  it("after the same-day cutoff, today is past — and the rest still book", () => {
    const plan = planBatchDates(["2026-07-16", "2026-07-17"], ctx({ rushNowHour: 15 }));
    expect(plan[0]).toMatchObject({ ok: false, reason: "That date has passed." });
    expect(plan[1].ok).toBe(true);
  });

  it("refusalFor agrees with the single-date confirm, word for word", () => {
    expect(refusalFor("available")).toBeNull();
    expect(refusalFor("rush")).toBeNull();
    expect(refusalFor("past")).toBe("That date has passed.");
    expect(refusalFor("off-season")).toBe("That date is outside this lake's water-work season.");
    expect(refusalFor("full")).toBe("That day's crew is full — pick another.");
  });
});

describe("partial success — what the customer is told when 4 of 6 land", () => {
  const refused = [
    { date: "2026-07-24", ok: false, isRush: false, reason: "That day's crew is full — pick another." },
    { date: "2026-08-07", ok: false, isRush: false, reason: "That day's crew is full — pick another." },
  ];
  const booked = ["2026-07-17", "2026-07-31", "2026-08-14", "2026-08-21"];

  it("the headline carries the arithmetic, never a bare 'done'", () => {
    const copy = batchOutcomeCopy("Housekeeping", booked, refused);
    expect(copy.headline).toBe("4 of 6 Housekeeping visits booked.");
  });

  it("every refused day is named", () => {
    const copy = batchOutcomeCopy("Housekeeping", booked, refused);
    expect(copy.lines).toEqual(["Jul 24 and Aug 7: That day's crew is full — pick another."]);
  });

  it("one line per reason, not one per date", () => {
    expect(
      refusalLines([
        ...refused,
        { date: "2026-11-20", ok: false, isRush: false, reason: "That date is outside this lake's water-work season." },
      ]),
    ).toEqual([
      "Jul 24 and Aug 7: That day's crew is full — pick another.",
      "Nov 20: That date is outside this lake's water-work season.",
    ]);
  });

  it("a clean sweep says so plainly, with no refusal lines", () => {
    const copy = batchOutcomeCopy("Housekeeping", booked, []);
    expect(copy.headline).toBe("4 Housekeeping visits booked — see “My requests.”");
    expect(copy.lines).toEqual([]);
  });

  it("a single booked visit is singular", () => {
    expect(batchOutcomeCopy("Housekeeping", ["2026-07-17"], []).headline)
      .toBe("1 Housekeeping visit booked — see “My requests.”");
  });

  it("nothing booked is stated as nothing booked, with the reasons", () => {
    const copy = batchOutcomeCopy("Housekeeping", [], refused);
    expect(copy.headline).toBe("None of those days could be booked for Housekeeping.");
    expect(copy.lines).toHaveLength(1);
  });
});

describe("prettyDateList", () => {
  it("reads like a sentence", () => {
    expect(prettyDateList(["2026-07-17"])).toBe("Jul 17");
    expect(prettyDateList(["2026-07-17", "2026-07-24"])).toBe("Jul 17 and Jul 24");
    expect(prettyDateList(["2026-07-17", "2026-07-24", "2026-07-31"])).toBe("Jul 17, Jul 24 and Jul 31");
  });

  it("caps for a text message without hiding the count", () => {
    const dates = ["2026-07-17", "2026-07-24", "2026-07-31", "2026-08-07", "2026-08-14"];
    expect(prettyDateList(dates, 3)).toBe("Jul 17, Jul 24, Jul 31 and 2 more");
  });

  it("no timezone drift — the day named is the day picked", () => {
    expect(prettyDateList(["2026-01-01"])).toBe("Jan 1");
    expect(prettyDateList(["2026-12-31"])).toBe("Dec 31");
  });
});
