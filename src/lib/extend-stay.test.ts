import { describe, it, expect } from "vitest";
import {
  extendedRange, extensionPrice, remindDecision, canExtend, refusalText,
  LEAD_DAYS, MAX_SILENT_ROLLS,
} from "@/lib/extend-stay";
import { parseDaterange, toDaterange, type DateRange, type Term } from "@/lib/parks";

const r = (start: string, end: string): DateRange => ({ start, end });
const RATES = [
  { term: "nightly" as Term, amount: 55 },
  { term: "weekly" as Term, amount: 315 },
  { term: "monthly" as Term, amount: 340 },
];

describe("extendedRange — one more period, contiguous with the last", () => {
  it("adds exactly one period of the term", () => {
    expect(extendedRange(r("2026-07-01", "2026-07-08"), "weekly")).toEqual(r("2026-07-01", "2026-07-15"));
    expect(extendedRange(r("2026-07-01", "2026-07-02"), "nightly")).toEqual(r("2026-07-01", "2026-07-03"));
    expect(extendedRange(r("2026-07-01", "2026-07-31"), "monthly")).toEqual(r("2026-07-01", "2026-08-30"));
  });

  it("keeps the ORIGINAL start — it widens the stay, it does not start a new one", () => {
    // Starting a second range would leave a gap or an overlap with itself, and
    // the exclusion constraint would refuse the renter their own lot.
    expect(extendedRange(r("2019-05-01", "2020-04-30"), "annual").start).toBe("2019-05-01");
  });

  it("crosses a month, a year and a leap day without drifting", () => {
    expect(extendedRange(r("2028-02-01", "2028-02-28"), "nightly").end).toBe("2028-02-29");
    expect(extendedRange(r("2026-12-01", "2026-12-31"), "nightly").end).toBe("2027-01-01");
  });

  it("always produces a range Postgres round-trips", () => {
    for (const term of ["nightly", "weekly", "monthly", "seasonal", "annual"] as Term[]) {
      const next = extendedRange(r("2026-03-01", "2026-03-15"), term);
      expect(parseDaterange(toDaterange(next))).toEqual(next);
    }
  });
});

describe("extensionPrice — the park's card, never a number we invented", () => {
  it("quotes the same term the stay is on", () => {
    expect(extensionPrice(RATES, "weekly")).toBe(315);
  });
  it("is null when the park stopped selling that term", () => {
    expect(extensionPrice(RATES, "annual")).toBeNull();
    expect(extensionPrice([{ term: "weekly", amount: 0 }], "weekly")).toBeNull();
  });
});

describe("remindDecision — ask before they pack, and only once", () => {
  const base = {
    range: r("2026-07-01", "2026-07-08"), term: "weekly" as Term,
    status: "active", alreadySent: false,
  };

  it("sends when the checkout is inside the lead window", () => {
    // weekly leads by 2 days; checkout is the 8th
    expect(remindDecision({ ...base, todayISO: "2026-07-06" })).toBe("send");
    expect(remindDecision({ ...base, todayISO: "2026-07-07" })).toBe("send");
  });

  it("stays quiet while it is still too early", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-03" })).toBe("too_early");
  });

  it("a MISSED night is caught the next night — the ask is not lost forever", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-08" })).toBe("send");
  });

  it("gives up once the stay is over rather than texting about the past", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-09" })).toBe("too_late");
  });

  it("EXACTLY ONCE — a guest texted three nights running stops reading our texts", () => {
    // Which matters because the one they stop reading is the freeze warning.
    expect(remindDecision({ ...base, todayISO: "2026-07-07", alreadySent: true })).toBe("already_sent");
  });

  it("a long tenancy is asked far earlier than a nightly guest", () => {
    expect(LEAD_DAYS.nightly).toBeLessThan(LEAD_DAYS.monthly);
    const monthly = { range: r("2026-01-01", "2026-12-31"), term: "monthly" as Term, status: "active", alreadySent: false };
    expect(remindDecision({ ...monthly, todayISO: "2026-12-20" })).toBe("send");
    expect(remindDecision({ ...monthly, todayISO: "2026-11-01" })).toBe("too_early");
  });

  it("never chases an application, a decline or a cancellation", () => {
    for (const status of ["applied", "declined", "cancelled", "ended"]) {
      expect(remindDecision({ ...base, todayISO: "2026-07-07", status })).toBe("not_extendable");
    }
  });

  it("stops rolling silently after enough turns, so a forgotten tenancy surfaces", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-07", extendedCount: MAX_SILENT_ROLLS }))
      .toBe("not_extendable");
  });

  it("an unparseable range is never chased", () => {
    expect(remindDecision({ ...base, todayISO: "2026-07-07", range: null })).toBe("not_extendable");
  });
});

describe("canExtend — the tap we can actually honour", () => {
  const base = {
    range: r("2026-07-01", "2026-07-08"), term: "weekly" as Term,
    status: "active", todayISO: "2026-07-06", otherHeld: [] as DateRange[], rates: RATES,
  };

  it("extends a clear lot and quotes the park's rate", () => {
    const res = canExtend(base);
    expect(res.ok).toBe(true);
    expect(res.range).toEqual(r("2026-07-01", "2026-07-15"));
    expect(res.price).toBe(315);
  });

  it("REFUSES when someone else already holds the days after theirs", () => {
    const res = canExtend({ ...base, otherHeld: [r("2026-07-10", "2026-07-20")] });
    expect(res.refusal).toBe("lot_taken");
    // And says nothing about who took it or until when — somebody else's business.
    const text = refusalText("lot_taken");
    expect(text).not.toMatch(/\d/);
    expect(text).toMatch(/another one/i);
  });

  it("allows a BACK-TO-BACK neighbour — changeover day is not a conflict", () => {
    // Their extension ends the 15th; the next stay starts the 15th.
    expect(canExtend({ ...base, otherHeld: [r("2026-07-15", "2026-07-22")] }).ok).toBe(true);
  });

  it("refuses when the park no longer sells that term", () => {
    expect(canExtend({ ...base, rates: [{ term: "nightly", amount: 55 }] }).refusal).toBe("no_rate");
    expect(canExtend({ ...base, rates: [] }).refusal).toBe("no_rate");
  });

  it("refuses a stay that already finished, and one that was never live", () => {
    expect(canExtend({ ...base, todayISO: "2026-08-01" }).refusal).toBe("already_ended");
    expect(canExtend({ ...base, status: "applied" }).refusal).toBe("not_extendable");
  });

  it("every refusal has a sentence a stressed person can act on", () => {
    for (const k of ["not_found", "not_extendable", "lot_taken", "no_rate", "already_ended"] as const) {
      const t = refusalText(k);
      expect(t.length).toBeGreaterThan(30);
      // Never blames the renter.
      expect(t).not.toMatch(/you (didn't|failed|should have)/i);
    }
  });

  it("a month-to-month roll is just an extension, and stays clear of itself", () => {
    // The correctness half: Donna's tenancy rolls a year forward and the
    // exclusion constraint sees one contiguous range, not two overlapping ones.
    const res = canExtend({
      range: r("2026-08-09", "2027-08-09"), term: "monthly", status: "active",
      todayISO: "2027-07-28", otherHeld: [], rates: RATES,
    });
    expect(res.ok).toBe(true);
    expect(res.range!.start).toBe("2026-08-09");
    expect(res.range!.end).toBe("2027-09-08");
  });
});
