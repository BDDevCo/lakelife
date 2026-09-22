import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACCEPTED IS NOT DELIVERED, AND SOMEBODY HAS TO BE TOLD THE DIFFERENCE.
 *
 * `sendSms` has always returned the moment Twilio took the message. Between 19
 * July and 16 August 2026 that was true eighty-one times and delivery happened
 * none of them — sixty-six refused with 30034, an unregistered A2P 10DLC
 * sender. The product could not tell the two events apart because it never saw
 * the second one.
 *
 * Two halves are pinned here. The SEND now leaves a receipt and tells Twilio
 * where to post the verdict. The DIGEST reads those receipts and says, in one
 * line every morning, how many texts reached a handset — and shouts when the
 * answer is none.
 */

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------- the send --

const created: Array<Record<string, unknown>> = [];
let createResult: { sid: string; status: string; errorCode?: number } = { sid: "SMtest", status: "queued" };
let createThrows: string | null = null;

vi.mock("twilio", () => ({
  default: () => ({
    messages: {
      create: async (opts: Record<string, unknown>) => {
        created.push(opts);
        if (createThrows) throw new Error(createThrows);
        return createResult;
      },
    },
  }),
}));

vi.mock("@/lib/recipient-gate", () => ({ recipientIsFixture: async () => false }));
vi.mock("@/lib/notice-hold", () => ({
  recipientIsHeld: async () => ({ held: false, failed: false }),
  holdRefusal: () => "held",
}));

const attempts: Array<Record<string, unknown>> = [];
let attemptRecorded = true;

vi.mock("@/lib/sms-receipts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms-receipts")>();
  return {
    ...real,
    recordSmsAttempt: vi.fn(async (a: Record<string, unknown>) => {
      attempts.push(a);
      return { recorded: attemptRecorded };
    }),
  };
});

// A real Wolcottville exchange with an invented line: it gets past the
// reserved-number gate without ever addressing a person. Nothing in this file
// can reach Twilio — the client is a stub two blocks up.
const TO = "+12604631234";

beforeEach(() => {
  created.length = 0;
  attempts.length = 0;
  attemptRecorded = true;
  createThrows = null;
  createResult = { sid: "SMtest", status: "queued" };
  process.env.TWILIO_ACCOUNT_SID = "ACfake";
  process.env.TWILIO_AUTH_TOKEN = "fake_token_for_this_test_only";
  process.env.TWILIO_PHONE_NUMBER = "+12605550100";
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
});
afterEach(() => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("every accepted message leaves a receipt", () => {
  it("files the SID, the label and the destination", async () => {
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms(TO, "Your crew is on the way.", { kind: "crew dispatch" });

    expect(res.queued).toBe(true);
    expect(res.recorded).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sid: "SMtest",
      to: TO,
      kind: "crew dispatch",
      acceptedStatus: "queued",
    });
  });

  it("files the ones Twilio refuses on the spot as well", async () => {
    // A table holding only the hopeful half of the story would report a
    // perfect delivery rate on a night when every message was refused.
    const { sendSms } = await import("@/lib/sms");
    createResult = { sid: "SMbad", status: "undelivered", errorCode: 30034 };

    const res = await sendSms(TO, "Your pier removal is Tuesday.", { kind: "pier removal" });

    expect(res.queued).toBe(false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sid: "SMbad", acceptedStatus: "undelivered" });
  });

  it("tells the caller when the receipt itself did not save", async () => {
    const { sendSms } = await import("@/lib/sms");
    attemptRecorded = false;
    const res = await sendSms(TO, "hello", { kind: "test" });
    expect(res.queued).toBe(true);
    expect(res.recorded).toBe(false);
  });

  it("files nothing when the send threw — there is no SID to file it under", async () => {
    // A row with an invented key is a row no callback can ever answer, and it
    // would count against the delivery rate for ever.
    const { sendSms } = await import("@/lib/sms");
    createThrows = "socket hang up";
    const res = await sendSms(TO, "hello", { kind: "test" });
    expect(res.queued).toBe(false);
    expect(attempts).toHaveLength(0);
  });

  it("keeps the old return shape for the 44 call sites that read it", async () => {
    // `recorded` is added alongside, never in place of anything: nothing that
    // reads `queued`, `sid` or `status` reads differently than it did.
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms(TO, "hello");
    expect(res).toMatchObject({ queued: true, sid: "SMtest", status: "queued" });
  });

  it("still sends when the caller gives no label at all", async () => {
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms(TO, "hello");
    expect(res.queued).toBe(true);
    expect(attempts[0].kind).toBeNull();
  });
});

describe("Twilio is told where to post the verdict", () => {
  it("passes a statusCallback built from the site origin", async () => {
    const { sendSms } = await import("@/lib/sms");
    await sendSms(TO, "hello");
    expect(created[0].statusCallback).toBe("https://www.lakelife.ai/api/twilio/status");
  });

  it("passes NONE from a local origin, rather than breaking the send", async () => {
    // Twilio validates the StatusCallback as it accepts the message and
    // refuses an unroutable one (21609): a localhost callback would stop every
    // text going out. Both halves of this branch are pinned, because a version
    // that always omitted it would pass the test above's opposite.
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms(TO, "hello");
    expect(res.queued).toBe(true);
    expect(created[0].statusCallback).toBeUndefined();
    // And the message still goes, with its receipt filed.
    expect(attempts).toHaveLength(1);
  });

  it("still prefers the Messaging Service over the bare number", async () => {
    // A registered A2P campaign is attached to a Messaging Service and the
    // carriers route on that. Adding the callback must not have disturbed it —
    // messagingServiceSid and from are mutually exclusive at the API.
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGfake";
    const { sendSms } = await import("@/lib/sms");
    await sendSms(TO, "hello");
    expect(created[0].messagingServiceSid).toBe("MGfake");
    expect(created[0].from).toBeUndefined();
  });

  it("falls back to the bare number when no service is configured", async () => {
    const { sendSms } = await import("@/lib/sms");
    await sendSms(TO, "hello");
    expect(created[0].from).toBe("+12605550100");
    expect(created[0].messagingServiceSid).toBeUndefined();
  });
});

// -------------------------------------------------------------- the digest --

describe("the nightly says whether the texts arrived", () => {
  const load = () => import("@/lib/digest-render");
  const quiet = {
    learning: { changes: [] },
    autoPricing: { changes: [] },
    disputeSweep: { fired: 0, escalated: 0 },
    escalatedDisputes: [],
    lakesBorn: [],
    routes: {},
    aiAutoReplies: 0,
    aiReplyTexts: [],
    gapSla: { alerted: 0 },
  };

  it("SHOUTS when texts went out and none arrived", async () => {
    // The sentence the whole receipts table was built to be able to say. In
    // August this was the true state of the world for a month and no screen,
    // email or log anywhere in the product said it.
    const { composeNightlyDigest } = await load();
    const html = composeNightlyDigest({
      ...quiet,
      textDelivery: {
        day: { attempted: 12, delivered: 0, failed: 12, waiting: 0 },
        week: { attempted: 81, delivered: 0, failed: 81, waiting: 0 },
        reasons: [{ code: "30034", text: "the sending number isn't registered for business texting (A2P 10DLC)", count: 66 }],
      },
    });

    expect(html).toContain("NO TEXTS ARE ARRIVING");
    expect(html).toContain("81");
    expect(html).toContain("A2P 10DLC");
    expect(html).not.toContain("Quiet night");
  });

  it("says the plain count on a healthy night, and does not shout", async () => {
    const { composeNightlyDigest } = await load();
    const html = composeNightlyDigest({
      ...quiet,
      textDelivery: {
        day: { attempted: 9, delivered: 8, failed: 0, waiting: 1 },
        week: { attempted: 40, delivered: 38, failed: 1, waiting: 1 },
        reasons: [{ code: "21610", text: "they replied STOP", count: 1 }],
      },
    });

    expect(html).toContain("Texts delivered");
    expect(html).toContain("8 of 9");
    expect(html).toContain("38 of 40");
    expect(html).not.toContain("NO TEXTS ARE ARRIVING");
  });

  it("says we couldn't check, rather than nothing, when the record wouldn't read", async () => {
    // A FAILED READ IS NOT AN EMPTY ONE. Silence here is the same silence that
    // hid the outage.
    const { composeNightlyDigest } = await load();
    const html = composeNightlyDigest({ ...quiet, textDelivery: { day: null, week: null } });
    expect(html).toContain("couldn't check");
    expect(html).not.toContain("Quiet night");
  });

  it("stays silent on a week with no texts in it at all", async () => {
    // Zero is silence, like every other section — the park notice hold is on
    // and a night with nothing to send is a normal night. This is the branch
    // that keeps the loud line meaningful.
    const { composeNightlyDigest } = await load();
    const html = composeNightlyDigest({
      ...quiet,
      textDelivery: {
        day: { attempted: 0, delivered: 0, failed: 0, waiting: 0 },
        week: { attempted: 0, delivered: 0, failed: 0, waiting: 0 },
      },
    });
    expect(html).toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });

  it("stays silent when no caller passed the section at all", async () => {
    const { composeNightlyDigest } = await load();
    expect(composeNightlyDigest(quiet)).toBe("<p>Quiet night — nothing needed a human. 🌊</p>");
  });

  it("shouts on a week where everything is still waiting, too", async () => {
    // Nothing delivered and nothing refused either: the messages are simply
    // vanishing. Reading that as "no failures yet" is how a week goes by.
    const { composeNightlyDigest } = await load();
    const html = composeNightlyDigest({
      ...quiet,
      textDelivery: {
        day: { attempted: 3, delivered: 0, failed: 0, waiting: 3 },
        week: { attempted: 20, delivered: 0, failed: 0, waiting: 20 },
      },
    });
    expect(html).toContain("NO TEXTS ARE ARRIVING");
    expect(html).toContain("still without a verdict");
  });
});

describe("the nightly actually asks the question", () => {
  // A section nothing fills is a column with no writer. The renderer above
  // could be perfect and the digest would still never mention texts.
  const code = readFileSync(join(process.cwd(), "src/lib/automation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("reads the receipts and hands them to the digest", () => {
    expect(code).toMatch(/smsDeliveryReport\(\)/);
    expect(code).toMatch(/textDelivery:\s*\{/);
  });

  it("names a read it could not make as something that needs a look", () => {
    expect(code).toMatch(/noteRead\(\s*"whether today's texts reached anybody"/);
  });

  it("proves this scan can fail", () => {
    const stripped = code.replace(/smsDeliveryReport\(\)/g, "nothingAtAll()");
    expect(stripped).not.toMatch(/smsDeliveryReport\(\)/);
  });
});

describe("the label is a column with a writer", () => {
  // A `kind` nobody ever passes files every row as "unlabelled", and a week of
  // failures then counts anonymous rows instead of naming which promises went
  // unkept. `notify` is the door most sends go through and it already holds
  // the consequence in words, so it is the one that has to pass it.
  const notify = readFileSync(join(process.cwd(), "src/lib/notify.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("hands sendSms the words it already had", () => {
    expect(notify).toMatch(/sendSms\(phone,\s*msg\.sms,\s*\{\s*kind:\s*what\s*\}\)/);
  });

  it("proves this scan can fail", () => {
    expect(notify.replace(/,\s*\{\s*kind:\s*what\s*\}/, "")).not.toMatch(
      /sendSms\(phone,\s*msg\.sms,\s*\{\s*kind:\s*what\s*\}\)/,
    );
  });
});
