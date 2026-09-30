import { describe, it, expect, vi } from "vitest";

/**
 * ACCEPTED IS NOT DELIVERED, ON THE CHANNEL THAT IS CARRYING EVERYTHING.
 *
 * `sendEmail` returns the moment Resend takes the message, exactly as
 * `sendSms` returned the moment Twilio took one. The panel exists so the gap
 * between those two events is a number on a screen instead of a discovery two
 * months later.
 *
 * Every branch is pinned in both directions. An alarm-only assertion survives
 * the condition being collapsed to `true`, which is the exact break these
 * tests exist to catch.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/email-receipts", () => ({ EMAIL_RECEIPTS: "email_receipts" }));

const { emailVerdict, WINDOW_DAYS } = await import("@/app/ops/email-health");

type Health = Parameters<typeof emailVerdict>[0];
type Window = NonNullable<Health["report"]["week"]>;

const win = (over: Partial<Window> = {}): Window => ({
  attempted: 10,
  delivered: 9,
  failed: 1,
  waiting: 0,
  ...over,
});

const health = (over: Partial<Health> = {}): Health => ({
  report: {
    day: win({ attempted: 2, delivered: 2, failed: 0, waiting: 0 }),
    week: win(),
    verdicts: 10,
    reasons: [],
    unknownStatuses: [],
  },
  nightsFinished: 7,
  opsRecipients: 1,
  ...over,
});

const withReport = (over: Partial<Health["report"]>, rest: Partial<Health> = {}): Health => {
  const base = health(rest);
  return { ...base, report: { ...base.report, ...over } };
};

describe("a failed read is not an empty one", () => {
  it("a null week says we couldn't check, names why, and says there is no second copy", () => {
    const v = emailVerdict(withReport({ day: null, week: null, verdicts: null, error: "connection reset" }));
    expect(v.state).toBe("unreadable");
    expect(v.alarm).toContain("couldn't read");
    expect(v.alarm).toContain("connection reset");
    expect(v.alarm).toContain("no second copy");
    expect(v.line).toBe("");
  });

  it("COLLAPSED THE OTHER WAY: the same call with a readable week is NOT an alarm", () => {
    const v = emailVerdict(health());
    expect(v.state).toBe("delivered");
    expect(v.alarm).toBeNull();
  });
});

describe("no receipts has two different reasons and they get different sentences", () => {
  it("nights finished and somebody to send to: mail went out and nothing filed it", () => {
    const v = emailVerdict(
      withReport({ week: win({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), verdicts: 0 }, { nightsFinished: 5, opsRecipients: 1 }),
    );
    expect(v.state).toBe("nothing-filed");
    expect(v.alarm).toContain("nothing recorded it");
    expect(v.alarm).toContain("5");
  });

  it("no night finished either: it says so, and does NOT claim a quiet week", () => {
    const v = emailVerdict(
      withReport({ week: win({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), verdicts: 0 }, { nightsFinished: 0, opsRecipients: 1 }),
    );
    expect(v.state).toBe("nothing-filed-unproven");
    expect(v.alarm).toContain("no nightly run finished");
    // It must never be silent, and it must never read as fine.
    expect(v.alarm).not.toBeNull();
    expect(v.line).toBe("");
  });

  it("A FAILED WITNESS COUNT DOES NOT EXPLAIN THE SILENCE AWAY", () => {
    const v = emailVerdict(
      withReport({ week: win({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), verdicts: 0 }, { nightsFinished: null, opsRecipients: 1 }),
    );
    expect(v.state).toBe("nothing-filed-unproven");
    expect(v.alarm).toContain("couldn't check whether the nightly run finished");
  });

  it("no ops account with an email: a finished night proves nothing, and it says that", () => {
    const v = emailVerdict(
      withReport({ week: win({ attempted: 0, delivered: 0, failed: 0, waiting: 0 }), verdicts: 0 }, { nightsFinished: 7, opsRecipients: 0 }),
    );
    expect(v.state).toBe("nothing-filed-unproven");
    expect(v.alarm).toContain("no ops account has an email");
  });
});

describe("the July shape, one layer down", () => {
  it("rows with no verdict at all is the loudest state, and it does NOT claim nothing arrived", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 12, delivered: 0, failed: 0, waiting: 12 }), verdicts: 0 }));
    expect(v.state).toBe("no-verdicts");
    expect(v.alarm).toContain("not one verdict has come back");
    // The claim is about the RECORD. Asserting nothing arrived would be a
    // sentence the data does not support — the digest itself is an email.
    expect(v.alarm).not.toContain("nothing arrived");
    expect(v.alarm).toContain("/api/resend");
  });

  it("COLLAPSED THE OTHER WAY: one verdict on one row takes it out of that state", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 12, delivered: 0, failed: 12, waiting: 0 }), verdicts: 12 }));
    expect(v.state).toBe("none-delivered");
  });

  it("verdicts arriving and none of them delivered is its own, different alarm", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 4, delivered: 0, failed: 4, waiting: 0 }), verdicts: 4, reasons: [{ text: "mailbox does not exist", count: 4 }] }));
    expect(v.state).toBe("none-delivered");
    expect(v.alarm).toContain("not one is confirmed delivered");
    expect(v.reasons[0].text).toBe("mailbox does not exist");
  });
});

describe("the comparison that would have caught July in July", () => {
  it("carries accepted and delivered as separate numbers on every state", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 20, delivered: 17, failed: 2, waiting: 1 }), verdicts: 19 }));
    expect(v.accepted).toBe(20);
    expect(v.delivered).toBe(17);
    expect(v.verdicts).toBe(19);
    expect(v.alarm).toBeNull();
    expect(v.line).toContain(`17 of 20 confirmed delivered in the last ${WINDOW_DAYS} days`);
  });

  it("counts, never a percentage", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 3, delivered: 2, failed: 1, waiting: 0 }), verdicts: 3 }));
    expect(v.line).not.toContain("%");
    expect(v.line).toContain("2 of 3");
  });

  it("a status we do not understand is carried by name and is never delivered", () => {
    const v = emailVerdict(withReport({ week: win({ attempted: 5, delivered: 4, failed: 0, waiting: 1 }), verdicts: 5, unknownStatuses: ["email.opened"] }));
    expect(v.unknownStatuses).toEqual(["email.opened"]);
    expect(v.delivered).toBe(4);
  });
});
