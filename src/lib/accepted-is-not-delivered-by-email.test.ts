import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ACCEPTED IS NOT DELIVERED — AND NOW IT IS EMAIL'S TURN.
 *
 * 0 of 81 texts arrived between 19 July and 16 August 2026 and nothing noticed,
 * because `sendSms` returned the moment Twilio took the message and the
 * carrier's verdict was addressed to nobody. `sendEmail` has been in exactly
 * that state the whole time — POST to api.resend.com, `{ok:true}`, no record —
 * and with no A2P campaign it is the ONLY channel that reaches anybody.
 *
 * This pins the SEND half: what gets a receipt, what deliberately does not, and
 * what is said out loud when a send cannot be tracked.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/recipient-gate", () => ({ recipientIsFixture: async () => false }));
vi.mock("@/lib/notice-hold", () => ({
  recipientIsHeld: async () => held,
  holdRefusal: () => "Notices are on hold for this park.",
}));

let held: { held: boolean; reason: string | null; failed: boolean } =
  { held: false, reason: null, failed: false };

const attempts: Array<Record<string, unknown>> = [];
let attemptRecorded = true;
vi.mock("@/lib/email-receipts", () => ({
  EMAIL_RECEIPTS: "email_receipts",
  recordEmailAttempt: vi.fn(async (a: Record<string, unknown>) => {
    attempts.push(a);
    return { recorded: attemptRecorded };
  }),
}));

/** The stubbed transport. Nothing in this file can reach Resend. */
let reply: { ok: boolean; status: number; body: string } =
  { ok: true, status: 200, body: JSON.stringify({ id: "re_test_1" }) };
let fetchThrows: string | null = null;
const posted: Array<Record<string, unknown>> = [];

// A real domain we own, so the reserved-domain gate (example.com, resend.dev,
// .test and friends) lets it through without addressing a stranger.
const TO = "crew@lakelife.ai";

beforeEach(() => {
  attempts.length = 0;
  posted.length = 0;
  attemptRecorded = true;
  fetchThrows = null;
  held = { held: false, reason: null, failed: false };
  reply = { ok: true, status: 200, body: JSON.stringify({ id: "re_test_1" }) };
  process.env.RESEND_API_KEY = "re_fake_key_for_this_test_only";
  delete process.env.EMAIL_FROM;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body));
    if (fetchThrows) throw new Error(fetchThrows);
    return {
      ok: reply.ok,
      status: reply.status,
      text: async () => reply.body,
    } as unknown as Response;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe("every accepted email leaves a receipt", () => {
  it("files the id, the label and the destination", async () => {
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({
      to: TO,
      subject: "Your crew is on the way",
      html: "<p>Tuesday, 9am.</p>",
      about: { kind: "crew dispatch", parkId: "park-1" },
    });

    expect(res.ok).toBe(true);
    expect(res.id).toBe("re_test_1");
    expect(res.recorded).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: "re_test_1",
      to: TO,
      kind: "crew dispatch",
      parkId: "park-1",
    });
  });

  it("marks a sandbox send, because it only ever reaches the account owner", async () => {
    // EMAIL_FROM unset: Resend's shared onboarding address. The row is true —
    // Resend took it and will report on it — but nothing downstream may count it
    // as a person reached.
    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(attempts[0].sandbox).toBe(true);
  });

  it("and does not mark one sent from the branded domain", async () => {
    process.env.EMAIL_FROM = "LakeLife <noreply@lakelife.ai>";
    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(attempts[0].sandbox).toBe(false);
  });

  it("tells the caller when the receipt itself did not save", async () => {
    const { sendEmail } = await import("@/lib/email");
    attemptRecorded = false;
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(false);
  });

  it("still sends when the caller gives no label at all", async () => {
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(true);
    expect(attempts[0].kind).toBeNull();
  });

  it("keeps the old return shape for the thirty-one call sites that read it", async () => {
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res).toMatchObject({ ok: true });
  });
});

describe("a message that never reached Resend gets no row", () => {
  it("files nothing for a refused recipient, and never opens the socket", async () => {
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: "nobody@example.com", subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(false);
    expect(posted).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  it("files nothing when the park is holding its notices", async () => {
    held = { held: true, reason: "leases aren't signed", failed: false };
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(false);
    expect(posted).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  it("files nothing when there is no API key", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(false);
    expect(attempts).toHaveLength(0);
  });

  it("files nothing when Resend refuses — there is no id to file it under", async () => {
    reply = { ok: false, status: 422, body: '{"message":"domain not verified"}' };
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Resend 422");
    expect(attempts).toHaveLength(0);
  });

  it("files nothing when the send threw", async () => {
    fetchThrows = "socket hang up";
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(false);
    expect(attempts).toHaveLength(0);
  });
});

describe("an accepted message with no id is an alarm, not a clean sheet", () => {
  it("reports the send as sent, the receipt as unwritten, and shouts", async () => {
    // The mail has gone: saying otherwise would put "it didn't send" on a screen
    // about a message sitting in somebody's inbox. But nothing can ever tell us
    // whether it arrived, and that must not pass quietly.
    reply = { ok: true, status: 200, body: "{}" };
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(false);
    expect(attempts).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("says the same about a 2xx whose body is not JSON at all", async () => {
    reply = { ok: true, status: 200, body: "<html>gateway</html>" };
    const { sendEmail } = await import("@/lib/email");
    const res = await sendEmail({ to: TO, subject: "s", html: "<p>b</p>" });
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(false);
    expect(attempts).toHaveLength(0);
  });
});

describe("the label is a column with a writer", () => {
  const notify = readFileSync(join(process.cwd(), "src/lib/notify.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("hands sendEmail the words it already had", () => {
    // Seventy-odd sends come through this helper. Without this they all file as
    // "unlabelled" on the one channel that currently reaches anybody.
    expect(notify).toMatch(/about:\s*\{\s*kind:\s*what\s*\}/);
  });

  it("proves this scan can fail", () => {
    expect(notify.replace(/about:\s*\{\s*kind:\s*what\s*\},?/g, ""))
      .not.toMatch(/about:\s*\{\s*kind:\s*what\s*\}/);
  });
});

// ---------------------------------------------------- what reaches the row --

describe("the receipt keeps no words", () => {
  const inserted: Array<Record<string, unknown>> = [];
  let insertError: { code?: string; message: string } | null = null;

  beforeEach(() => {
    inserted.length = 0;
    insertError = null;
    vi.resetModules();
    // THE REAL MODULE, DELIBERATELY. Line 30 mocks @/lib/email-receipts for the
    // describes above, which test that email.ts CALLS it. This block tests the
    // module itself, so the hoisted mock has to be lifted first — without this
    // the dynamic import below returns the stub, nothing is ever inserted, and
    // the assertions read `inserted[0]` of an empty array.
    vi.doUnmock("@/lib/email-receipts");
    vi.doMock("@/lib/supabase/server", () => ({
      createServiceClient: () => ({
        from: () => ({
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: insertError };
          },
        }),
      }),
    }));
  });

  const SUBJECT = "$542.53 due on lot 26";
  const BODY = "<p>Hi Dana — your rent for January 2027 is due.</p>";

  it("stores a length and two digests, and neither the subject nor the body", async () => {
    const { recordEmailAttempt } = await import("@/lib/email-receipts");
    const res = await recordEmailAttempt({
      id: "re_1", to: TO, subject: SUBJECT, body: BODY, kind: "rent reminder",
      parkId: "park-1", acceptedStatus: null,
    });

    expect(res.recorded).toBe(true);
    const row = inserted[0];
    expect(row.message_id).toBe("re_1");
    expect(row.body_length).toBe(BODY.length);
    expect(String(row.body_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row.subject_sha256)).toMatch(/^[0-9a-f]{64}$/);
    // The words themselves are nowhere in what we wrote down.
    const written = JSON.stringify(row);
    expect(written).not.toContain("Dana");
    expect(written).not.toContain("lot 26");
    expect(written).not.toContain(BODY);
  });

  it("files an unlabelled send rather than skipping it", async () => {
    const { recordEmailAttempt } = await import("@/lib/email-receipts");
    await recordEmailAttempt({ id: "re_2", to: TO, subject: "s", body: "b" });
    expect(inserted[0].kind).toBe("unlabelled");
    // A message awaiting its verdict must not look like one nobody asked about.
    expect(inserted[0].status).toBe("accepted");
    expect(inserted[0].accepted_status).toBeNull();
  });

  it("treats a second copy of the same message as filed, not as a failure", async () => {
    insertError = { code: "23505", message: "duplicate key" };
    const { recordEmailAttempt } = await import("@/lib/email-receipts");
    const res = await recordEmailAttempt({ id: "re_1", to: TO, subject: "s", body: "b" });
    expect(res.recorded).toBe(true);
  });

  it("says out loud when the row would not write", async () => {
    insertError = { message: "permission denied" };
    const { recordEmailAttempt } = await import("@/lib/email-receipts");
    const res = await recordEmailAttempt({ id: "re_3", to: TO, subject: "s", body: "b" });
    expect(res.recorded).toBe(false);
    expect(res.error).toContain("permission denied");
  });
});
