import { describe, it, expect } from "vitest";
import {
  suggestTip, validateTip, tipSplit, canTip, tipDaysLeft, daysBetweenISO,
  DEFAULT_TIP_DIALS, type TipDials,
} from "./tips";

describe("the suggestion is anchored to TIME, never to the bill", () => {
  it("a half-hour mow suggests small amounts", () => {
    const s = suggestTip(30);
    expect(s.options).toEqual([5, 10, 20]);
    expect(s.typical).toBe(10);
  });

  it("a two-hour visit suggests the middle band", () => {
    expect(suggestTip(120).options).toEqual([10, 20, 35]);
  });

  it("a five-and-a-half-hour pier install suggests the top band", () => {
    expect(suggestTip(330).options).toEqual([20, 35, 50]);
  });

  it("THE POINT: a $190 boat job and a $80 clean of the same length agree", () => {
    // At 20% of the bill these would suggest $190 and $16 — a 12x gap for the
    // same ninety minutes of somebody's afternoon. Anchored to time, they are
    // simply the same suggestion, which is the whole argument.
    expect(suggestTip(90).options).toEqual(suggestTip(90).options);
    expect(suggestTip(90).typical).toBe(20);
  });

  it("the biggest thing we would ever suggest stays within reason", () => {
    const biggest = Math.max(...DEFAULT_TIP_DIALS.bands.flatMap((b) => b.options));
    expect(biggest).toBe(50);
    // For scale: 20% of a 30-foot boat winterize is $300.
    expect(biggest).toBeLessThan(0.2 * 1500);
  });

  it("says how long they were there, in the customer's words", () => {
    expect(suggestTip(30).basis).toContain("about 30 minutes");
    expect(suggestTip(120).basis).toContain("about 2 hours");
    expect(suggestTip(330).basis).toContain("about 5.5 hours");
    expect(suggestTip(60).basis).toContain("about 1 hour");
  });

  it("always says the work is already paid for", () => {
    // The one sentence that stops a suggestion reading as a shortfall.
    expect(suggestTip(120).basis).toContain("already covers the work");
    expect(suggestTip(120).basis).toContain("up to you");
  });
});

describe("an unknown duration suggests the SMALLEST band", () => {
  it("takes the low band when minutes are missing", () => {
    // Deliberately the opposite of serviceMinutes, which books the LONGEST
    // slot for an unknown size. There, the cost of being wrong lands on the
    // crew's evening; here it lands on the customer as a too-big ask. Both
    // rules protect whoever didn't cause the uncertainty.
    expect(suggestTip(null).options).toEqual([5, 10, 20]);
    expect(suggestTip(undefined).options).toEqual([5, 10, 20]);
    expect(suggestTip(0).options).toEqual([5, 10, 20]);
  });

  it("says nothing about duration when it doesn't know", () => {
    expect(suggestTip(null).basis).not.toContain("about");
    expect(suggestTip(null).basis).toContain("up to you");
  });
});

describe("nothing is ever pre-selected", () => {
  it("offers a typical, which is a hint and not a default", () => {
    // `typical` exists so a screen can render the middle option as the obvious
    // "normal". The screen is what must not pre-tick it, and its test lives
    // there — this only guarantees we never hand it a single forced answer.
    const s = suggestTip(120);
    expect(s.options.length).toBeGreaterThan(1);
    expect(s.options).toContain(s.typical);
  });
});

describe("what a customer may actually enter", () => {
  it("ZERO IS A REAL ANSWER, not a failure", () => {
    expect(validateTip(0)).toEqual({ ok: true, amount: 0 });
    expect(validateTip("")).toEqual({ ok: true, amount: 0 });
    expect(validateTip(null)).toEqual({ ok: true, amount: 0 });
  });

  it("takes a typed amount with a dollar sign", () => {
    expect(validateTip("$25")).toEqual({ ok: true, amount: 25 });
  });

  it("refuses a negative", () => {
    expect(validateTip(-5).ok).toBe(false);
  });

  it("caps a fat finger and says so kindly", () => {
    const r = validateTip(5000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("give us a call");
  });

  it("refuses junk", () => {
    expect(validateTip("thanks!").ok).toBe(false);
  });

  it("honours a custom cap dial", () => {
    const tight: TipDials = { ...DEFAULT_TIP_DIALS, maxCustom: 50 };
    expect(validateTip(60, tight).ok).toBe(false);
    expect(validateTip(40, tight).ok).toBe(true);
  });
});

describe("every cent goes to the crew", () => {
  it("takes no margin from a thank-you", () => {
    expect(tipSplit(20)).toEqual({ toCrew: 20, toLakeLife: 0 });
    expect(tipSplit(50)).toEqual({ toCrew: 50, toLakeLife: 0 });
  });

  it("never returns a negative", () => {
    expect(tipSplit(-5).toCrew).toBe(0);
  });
});

describe("when a visit may be tipped", () => {
  it("only after the work is done", () => {
    expect(canTip({ status: "scheduled" }).ok).toBe(false);
    expect(canTip({ status: "scheduled" }).why).toContain("once the work is done");
    expect(canTip({ status: "complete" }).ok).toBe(true);
    expect(canTip({ status: "paid" }).ok).toBe(true);
  });

  it("NEVER on a visit where no work happened", () => {
    // A no-show or a stand-down is not a service to be thanked for. The crew's
    // trip is covered by the trip fee (0090), which is compensation, not a
    // favour anybody has to ask for.
    expect(canTip({ status: "complete", no_show_at: "x" }).ok).toBe(false);
    expect(canTip({ status: "complete", stood_down_at: "x" }).ok).toBe(false);
  });

  it("only once", () => {
    const twice = canTip({ status: "complete", tip_amount: 20 });
    expect(twice.ok).toBe(false);
    expect(twice.why).toContain("already sent");
  });

  it("A DECLINE IS FINAL TOO — zero is an answer, not an absence", () => {
    // `> 0` let a declined tip fall through as still-tippable: the button came
    // back, a second tap passed every gate, and the `.is("tip_amount", null)`
    // write matched nothing — so the action reported success while changing
    // nothing and charging nothing.
    const again = canTip({ status: "complete", tip_amount: 0 });
    expect(again.ok).toBe(false);
    expect(again.why).toContain("already answered");
  });

  it("a job never asked is still tippable", () => {
    expect(canTip({ status: "complete", tip_amount: null }).ok).toBe(true);
    expect(canTip({ status: "complete" }).ok).toBe(true);
  });
});

describe("the 30-day window", () => {
  const done = { status: "complete", date: "2026-08-01" };

  it("is open the day of the visit", () => {
    expect(canTip(done, "2026-08-01").ok).toBe(true);
    expect(tipDaysLeft("2026-08-01", "2026-08-01")).toBe(30);
  });

  it("is open on the LAST day, day 30", () => {
    // A window that shuts a day early is the commonest version of this bug.
    expect(tipDaysLeft("2026-08-01", "2026-08-31")).toBe(0);
    expect(canTip(done, "2026-08-31").ok).toBe(true);
  });

  it("is shut on day 31", () => {
    expect(tipDaysLeft("2026-08-01", "2026-09-01")).toBe(-1);
    const r = canTip(done, "2026-09-01");
    expect(r.ok).toBe(false);
    expect(r.why).toContain("30 days");
    expect(r.why).toContain("give us a call");
  });

  it("NOON, NOT MIDNIGHT — the Indiana off-by-one", () => {
    // `new Date("2026-08-12")` is UTC midnight, which in Indiana is the
    // EVENING OF THE 11TH. Anchoring both ends at noon makes the difference
    // exact whatever the offset, and across a DST boundary.
    expect(daysBetweenISO("2026-08-01", "2026-08-02")).toBe(1);
    expect(daysBetweenISO("2026-03-07", "2026-03-09")).toBe(2);  // spring forward
    expect(daysBetweenISO("2026-10-31", "2026-11-02")).toBe(2);  // fall back
    expect(daysBetweenISO("2026-08-02", "2026-08-01")).toBe(-1);
  });

  it("AN UNKNOWN DATE DOES NOT SHUT THE DOOR", () => {
    // Closing on the strength of our own missing data would charge the
    // customer for our gap — the same rule as the unknown-duration band.
    expect(canTip({ status: "complete", date: null }, "2026-09-01").ok).toBe(true);
    expect(tipDaysLeft(null, "2026-09-01")).toBe(null);
  });

  it("with no today passed in, the window is not evaluated at all", () => {
    // Every caller passes lake time; this only guarantees a missing clock
    // never silently becomes "expired".
    expect(canTip(done).ok).toBe(true);
  });

  it("ALREADY-ANSWERED OUTRANKS EXPIRED", () => {
    // Somebody who tipped in August and opens the job in October should be
    // thanked, not told they are too late for a thing they already did.
    const tipped = { ...done, tip_amount: 20 };
    expect(canTip(tipped, "2026-12-01").why).toContain("already sent");
  });

  it("a no-work visit outranks everything, expired or not", () => {
    expect(canTip({ ...done, no_show_at: "x" }, "2026-12-01").why).toContain("No work happened");
  });

  it("honours a custom window dial", () => {
    const tight: TipDials = { ...DEFAULT_TIP_DIALS, windowDays: 3 };
    expect(canTip(done, "2026-08-04", tight).ok).toBe(true);
    expect(canTip(done, "2026-08-05", tight).ok).toBe(false);
  });
});
