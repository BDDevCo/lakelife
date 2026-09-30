import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A STATUS WE DO NOT RECOGNISE IS NOT PROGRESS.
 *
 * 0171's sms_status_rank() returns null for an unknown status and the trigger
 * treats that as "no idea where this sits" rather than as news to throw away.
 * This is the same posture on the read side, and it matters more here: Resend's
 * event names are not written down anywhere in this project, so the list in
 * lib/email-delivery.ts is OUR vocabulary and it is certainly incomplete. The
 * one thing it may never do is count a word it has never seen as an arrival.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email-receipts", () => ({ EMAIL_RECEIPTS: "email_receipts" }));

let rows: Array<Record<string, unknown>> = [];
let readError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        // .eq("sandbox", false) sits between select and gte in the real query:
        // a sandbox send only reaches our own inbox and must never count as
        // having reached a person. Threaded through here rather than dropped,
        // so this harness keeps the same shape as the call it stands in for.
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: async () => ({ data: readError ? null : rows, error: readError }),
            }),
          }),
        }),
        gte: () => ({
          order: () => ({
            limit: async () => ({ data: readError ? null : rows, error: readError }),
          }),
        }),
      }),
    }),
  }),
}));

const { emailDeliveryReport, emailOutcome, isKnownEmailStatus } = await import("@/lib/email-delivery");

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

beforeEach(() => {
  rows = [];
  readError = null;
});

describe("the vocabulary is ours, and an unknown word is not good news", () => {
  it("delivered is delivered", () => {
    expect(emailOutcome("delivered")).toBe("delivered");
    expect(emailOutcome("DELIVERED")).toBe("delivered");
  });

  it("a terminal refusal is a failure", () => {
    expect(emailOutcome("bounced")).toBe("failed");
    expect(emailOutcome("complained")).toBe("failed");
  });

  it("a word nobody wrote down is WAITING — never delivered, never failed", () => {
    expect(emailOutcome("email.opened")).toBe("waiting");
    expect(emailOutcome("")).toBe("waiting");
    expect(emailOutcome(null)).toBe("waiting");
    expect(isKnownEmailStatus("email.opened")).toBe(false);
    expect(isKnownEmailStatus("delivered")).toBe(true);
  });
});

describe("two windows, and a verdict counted only when one actually landed", () => {
  it("tallies the day inside the week and counts stamped rows as verdicts", async () => {
    rows = [
      { created_at: hoursAgo(2), status: "delivered", status_at: hoursAgo(2), error_code: null, error_text: null },
      { created_at: hoursAgo(5), status: "bounced", status_at: hoursAgo(5), error_code: "550", error_text: "mailbox does not exist" },
      { created_at: hoursAgo(72), status: "delivered", status_at: hoursAgo(72), error_code: null, error_text: null },
      { created_at: hoursAgo(100), status: "accepted", status_at: null, error_code: null, error_text: null },
    ];
    const r = await emailDeliveryReport(NOW);
    expect(r.day).toEqual({ attempted: 2, delivered: 1, failed: 1, waiting: 0 });
    expect(r.week).toEqual({ attempted: 4, delivered: 2, failed: 1, waiting: 1 });
    expect(r.verdicts).toBe(3);
    expect(r.reasons).toEqual([{ text: "mailbox does not exist", count: 1 }]);
  });

  it("a row nothing ever came back for is not a verdict, however it is worded", async () => {
    rows = [
      { created_at: hoursAgo(1), status: "accepted", status_at: null, error_code: null, error_text: null },
      { created_at: hoursAgo(1), status: "accepted", status_at: null, error_code: null, error_text: null },
    ];
    const r = await emailDeliveryReport(NOW);
    expect(r.week?.attempted).toBe(2);
    expect(r.verdicts).toBe(0);
  });

  it("COLLAPSED THE OTHER WAY: one stamped row makes verdicts non-zero", async () => {
    rows = [
      { created_at: hoursAgo(1), status: "accepted", status_at: null, error_code: null, error_text: null },
      { created_at: hoursAgo(1), status: "delivered", status_at: hoursAgo(1), error_code: null, error_text: null },
    ];
    const r = await emailDeliveryReport(NOW);
    expect(r.verdicts).toBe(1);
  });

  it("names an unrecognised status instead of miscounting it", async () => {
    rows = [{ created_at: hoursAgo(1), status: "email.opened", status_at: hoursAgo(1), error_code: null, error_text: null }];
    const r = await emailDeliveryReport(NOW);
    expect(r.unknownStatuses).toEqual(["email.opened"]);
    expect(r.week).toEqual({ attempted: 1, delivered: 0, failed: 0, waiting: 1 });
  });

  it("a failure with no reason still gets a sentence rather than a blank", async () => {
    rows = [{ created_at: hoursAgo(1), status: "bounced", status_at: hoursAgo(1), error_code: null, error_text: null }];
    const r = await emailDeliveryReport(NOW);
    expect(r.reasons[0].text).toContain("no reason was recorded");
  });
});

describe("a failed read is null, never zero", () => {
  it("returns null windows and a null verdict count, and says why", async () => {
    readError = { message: "permission denied" };
    const r = await emailDeliveryReport(NOW);
    expect(r.day).toBeNull();
    expect(r.week).toBeNull();
    expect(r.verdicts).toBeNull();
    expect(r.error).toBe("permission denied");
  });

  it("COLLAPSED THE OTHER WAY: a successful empty read IS a zero, not a null", async () => {
    rows = [];
    const r = await emailDeliveryReport(NOW);
    expect(r.week).toEqual({ attempted: 0, delivered: 0, failed: 0, waiting: 0 });
    expect(r.verdicts).toBe(0);
    expect(r.error).toBeUndefined();
  });
});
