import { describe, it, expect } from "vitest";
import { expiryActionFor } from "@/lib/waitlist";

describe("expiryActionFor — a wrong cancel costs a house, a wrong escalate costs a glance", () => {
  it("protective work escalates, never cancels", () => {
    expect(expiryActionFor("protective")).toBe("escalate");
  });
  it("routine work still cancels — the honest floor is right for a mow", () => {
    expect(expiryActionFor("routine")).toBe("cancel");
  });
  it("null and undefined are routine — matching the column default, so the back catalogue is not swept into ops", () => {
    expect(expiryActionFor(null)).toBe("cancel");
    expect(expiryActionFor(undefined)).toBe("cancel");
  });
  it("an UNRECOGNISED tier fails SAFE — a future criticality we haven't been taught escalates", () => {
    // Deliberately asymmetric with null. A value someone deliberately wrote
    // that we don't understand is a reason to be careful, not to cancel.
    expect(expiryActionFor("life_safety")).toBe("escalate");
    expect(expiryActionFor("critical")).toBe("escalate");
  });
});

import { warningDue, isExpired } from "./waitlist";

const today = "2026-07-22";

describe("warningDue — warning owed by the boundary (no spam: see the ledger)", () => {
  it("fires exactly warnDays before the date", () => {
    expect(warningDue("2026-07-24", today, 2)).toBe(true);
  });
  // UPDATED for audit bug 10d: a job ONE day out used to be silent, which is
  // exactly how a single missed nightly lost the warning forever. It is now
  // inside the catch-up window; the sent-ledger — not the date — is what
  // keeps the send to exactly once. Firing EARLY is still wrong, and still is.
  it("silent before the boundary; inside the catch-up window after it", () => {
    expect(warningDue("2026-07-25", today, 2)).toBe(false); // 3 days out — too early
    expect(warningDue("2026-07-23", today, 2)).toBe(true); // 1 day out — the catch-up
    expect(warningDue("2026-07-23", today, 2, 0)).toBe(false); // …not with catch-up off
  });
  it("crosses month boundaries without drift", () => {
    expect(warningDue("2026-08-01", "2026-07-30", 2)).toBe(true);
  });
  it("null date or zero/negative dial never fires", () => {
    expect(warningDue(null, today, 2)).toBe(false);
    expect(warningDue("2026-07-24", today, 0)).toBe(false);
  });
});

describe("isExpired — the honest floor", () => {
  it("true once the date has passed, false today and ahead", () => {
    expect(isExpired("2026-07-21", today)).toBe(true);
    expect(isExpired("2026-07-22", today)).toBe(false); // day-of: still fillable
    expect(isExpired("2026-07-23", today)).toBe(false);
  });
  it("null date never expires", () => {
    expect(isExpired(null, today)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AUDIT BUG 10d: the warning was pure equality on jobDate === today + warnDays
// — no catch-up window and no record of sending. ONE missed nightly (deploy,
// outage, Vercel incident) lost that customer's warning FOREVER, and a manual
// re-run of the same night re-texted everyone in it. That warning is the
// customer's only chance to pick another day or invite their own crew before
// the machine cancels. Exactly-once now comes from the sent-ledger
// (waitlist_notice_log, migration 0049) — so the predicate is free to offer a
// catch-up window without becoming a nightly nag.
// ---------------------------------------------------------------------------
describe("warningDue — catch-up window (audit bug 10d)", () => {
  it("a MISSED nightly still warns the next night", () => {
    // Job 2026-07-24, warnDays 2: the 07-22 run never happened.
    expect(warningDue("2026-07-24", "2026-07-23", 2)).toBe(true);
  });
  it("still fires on the boundary night, and never early", () => {
    expect(warningDue("2026-07-24", today, 2)).toBe(true);
    expect(warningDue("2026-07-25", today, 2)).toBe(false); // 3 days out
  });
  it("the window has a floor — a multi-night outage doesn't warn forever", () => {
    // warnDays 7, default catch-up: 07-29 is due from 07-22 through 07-24.
    expect(warningDue("2026-07-29", "2026-07-24", 7)).toBe(true);
    expect(warningDue("2026-07-29", "2026-07-25", 7)).toBe(false); // past the catch-up
  });
  it("never warns on the job's own day — by then the text to send is the expiry one", () => {
    expect(warningDue("2026-07-22", today, 2)).toBe(false);
    expect(warningDue("2026-07-22", today, 1)).toBe(false);
  });
  it("an explicit zero catch-up is still the exact boundary (the old behavior, on request)", () => {
    expect(warningDue("2026-07-24", today, 2, 0)).toBe(true);
    expect(warningDue("2026-07-23", today, 2, 0)).toBe(false);
  });
  it("null date or zero/negative dial never fires, catch-up or not", () => {
    expect(warningDue(null, today, 2)).toBe(false);
    expect(warningDue("2026-07-24", today, 0)).toBe(false);
  });
  it("the window never overlaps expiry — no warn-and-cancel on the same night", () => {
    for (let warnDays = 1; warnDays <= 14; warnDays++) {
      for (let offset = -5; offset <= 20; offset++) {
        const jobDate = new Date(Date.UTC(2026, 6, 22 + offset)).toISOString().slice(0, 10);
        expect(warningDue(jobDate, today, warnDays) && isExpired(jobDate, today)).toBe(false);
      }
    }
  });
});
