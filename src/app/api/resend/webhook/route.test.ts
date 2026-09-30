import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SAME OUTAGE, ON THE ONLY CHANNEL LEFT.
 *
 * Texting delivered 0 of 81 for a month because acceptance and delivery are
 * different events and nothing was listening for the second one. Email has the
 * identical shape and is currently carrying every alarm this product raises.
 *
 * These tests hold the door itself: it refuses anything it cannot verify, it
 * writes nothing when it refuses, it does not pretend to know Resend's
 * vocabulary, and it never acknowledges a verdict it failed to record.
 *
 * A NOTE ON THE EVENT NAMES BELOW. "email.delivered" and "email.bounced" are
 * what this door will be CONFIGURED to read, not facts confirmed with Resend —
 * nothing in this repository records their vocabulary. The test that matters
 * for that is "an unfamiliar name is passed through": the door must not depend
 * on knowing the words.
 */

vi.mock("server-only", () => ({}));

interface Call {
  messageId: string;
  status: string;
  errorCode?: string | null;
  errorText?: string | null;
}

let calls: Call[] = [];
let result: { matched: boolean; error?: string } = { matched: true };

// The send path's half of this table is a different file; the door's contract
// with it is exactly this shape, and this mock is where that contract is
// pinned. Referenced lazily inside the function, so vi.mock's hoisting is fine.
vi.mock("@/lib/email-receipts", () => ({
  EMAIL_RECEIPTS: "email_receipts",
  recordEmailReceipt: (r: Call) => {
    calls.push(r);
    return Promise.resolve(result);
  },
}));

const SECRET = "whsec_resend_would_give_us_this";
const HEADER = "x-resend-signature";

/** Signs the way the route says it verifies: whsec_ stripped, key used raw. */
const sign = (payload: string, secret = SECRET) =>
  createHmac("sha256", secret.replace(/^whsec_/, "")).update(payload, "utf8").digest("hex");

const signB64 = (payload: string, secret = SECRET) =>
  createHmac("sha256", secret.replace(/^whsec_/, "")).update(payload, "utf8").digest("base64");

const post = async (body: string, headers: Record<string, string>) => {
  const { POST } = await import("./route");
  return POST(
    new Request("https://lakelife.test/api/resend/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
};

const event = (type: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type, created_at: "2026-09-30T02:11:04.000Z", data: { email_id: "re_a1b2c3", ...data } });

const DELIVERED = event("email.delivered", { to: ["mike@example.com"] });

beforeEach(() => {
  calls = [];
  result = { matched: true };
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_WEBHOOK_SIGNATURE_HEADER = HEADER;
});

afterEach(() => {
  for (const k of [
    "RESEND_WEBHOOK_SECRET",
    "RESEND_WEBHOOK_SIGNATURE_HEADER",
    "RESEND_WEBHOOK_SIGNED_PAYLOAD",
    "RESEND_WEBHOOK_ID_HEADER",
    "RESEND_WEBHOOK_TIMESTAMP_HEADER",
    "RESEND_WEBHOOK_SECRET_ENCODING",
    "RESEND_WEBHOOK_TOLERANCE_SECONDS",
  ]) {
    delete process.env[k];
  }
});

describe("a delivery we cannot verify is refused, not recorded", () => {
  it("refuses everything when no secret is configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED) });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses everything when the header name has not been confirmed", async () => {
    // No default header: a default would be a guess at a scheme nothing in this
    // repository records, and a wrong guess would look configured.
    delete process.env.RESEND_WEBHOOK_SIGNATURE_HEADER;
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED) });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a delivery carrying no signature", async () => {
    const res = await post(DELIVERED, {});
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a signature made with the wrong secret", async () => {
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED, "whsec_not_ours") });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a signature over a different body", async () => {
    const res = await post(DELIVERED, { [HEADER]: sign(event("email.bounced")) });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body larger than the cap before verifying anything", async () => {
    const huge = JSON.stringify({ type: "email.delivered", pad: "x".repeat(1_000_001) });
    const res = await post(huge, { [HEADER]: sign(huge) });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("refuses a replayed delivery whose signed timestamp is old", async () => {
    process.env.RESEND_WEBHOOK_TIMESTAMP_HEADER = "x-resend-timestamp";
    process.env.RESEND_WEBHOOK_SIGNED_PAYLOAD = "{timestamp}.{body}";
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await post(DELIVERED, {
      "x-resend-timestamp": stale,
      [HEADER]: sign(`${stale}.${DELIVERED}`),
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers 405 to a GET, so a prefetch never looks like a delivery", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe("a verified delivery advances exactly one row", () => {
  it("records a hex-signed delivery", async () => {
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED) });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { messageId: "re_a1b2c3", status: "delivered", errorCode: null, errorText: null },
    ]);
  });

  it("records a base64-signed delivery — two spellings of one digest", async () => {
    const res = await post(DELIVERED, { [HEADER]: signB64(DELIVERED) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("verifies a templated payload and a rotated multi-signature header", async () => {
    process.env.RESEND_WEBHOOK_ID_HEADER = "x-resend-id";
    process.env.RESEND_WEBHOOK_TIMESTAMP_HEADER = "x-resend-timestamp";
    process.env.RESEND_WEBHOOK_SIGNED_PAYLOAD = "{id}.{timestamp}.{body}";
    const ts = String(Math.floor(Date.now() / 1000));
    const good = sign(`msg_77.${ts}.${DELIVERED}`);

    const res = await post(DELIVERED, {
      "x-resend-id": "msg_77",
      "x-resend-timestamp": ts,
      [HEADER]: `v1,${sign(DELIVERED, "whsec_the_old_key")} v1,${good}`,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("accepts a base64-encoded secret when the dial says so", async () => {
    const keyB64 = Buffer.from("a real key of bytes", "utf8").toString("base64");
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${keyB64}`;
    process.env.RESEND_WEBHOOK_SECRET_ENCODING = "base64";
    const sig = createHmac("sha256", Buffer.from(keyB64, "base64"))
      .update(DELIVERED, "utf8")
      .digest("hex");

    const res = await post(DELIVERED, { [HEADER]: sig });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("passes an unfamiliar event name through instead of dropping it", async () => {
    // THE POINT OF THIS ONE. Resend's vocabulary is not written down anywhere
    // in this repository. A door that only understood a list it had guessed
    // would silently discard the verdict that mattered.
    const odd = event("email.quarantined_by_the_receiving_server");
    const res = await post(odd, { [HEADER]: sign(odd) });
    expect(res.status).toBe(200);
    expect(calls[0].status).toBe("quarantined_by_the_receiving_server");
  });

  it("carries a bounce's code and the provider's own words", async () => {
    const bounced = event("email.bounced", {
      bounce: { type: "Permanent", subType: "NoEmail", message: "the mailbox does not exist" },
    });
    const res = await post(bounced, { [HEADER]: sign(bounced) });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      messageId: "re_a1b2c3",
      status: "bounced",
      errorCode: "NoEmail",
      errorText: "the mailbox does not exist",
    });
  });

  it("records a failure with no reason rather than discarding it", async () => {
    const failed = event("email.failed");
    const res = await post(failed, { [HEADER]: sign(failed) });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ status: "failed", errorCode: null, errorText: null });
  });

  it("writes nothing at all for an open or a click", async () => {
    for (const name of ["email.opened", "email.clicked"]) {
      const e = event(name);
      const res = await post(e, { [HEADER]: sign(e) });
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(0);
  });

  it("ignores a verified delivery that names no message", async () => {
    const nameless = JSON.stringify({ type: "email.delivered", data: {} });
    const res = await post(nameless, { [HEADER]: sign(nameless) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(calls).toHaveLength(0);
  });

  it("never reads the envelope's own id as the message's", async () => {
    // A wrong key updates no row while looking like it worked. Missing beats
    // wrong: this must be ignored and logged, not filed under evt_1.
    const wrapped = JSON.stringify({ id: "evt_1", type: "email.delivered", data: {} });
    const res = await post(wrapped, { [HEADER]: sign(wrapped) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("answers 200 for a verdict we hold no receipt for, not 500", async () => {
    result = { matched: false };
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unknown: true });
  });

  it("asks to be told again when the write itself failed", async () => {
    result = { matched: false, error: "connection reset" };
    const res = await post(DELIVERED, { [HEADER]: sign(DELIVERED) });
    expect(res.status).toBe(500);
  });
});

describe("the door is still only a door", () => {
  const SRC = readFileSync(join(process.cwd(), "src/app/api/resend/webhook/route.ts"), "utf8");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("sends nothing and re-sends nothing", () => {
    for (const call of ["sendEmail", "sendSms", "api.resend.com", "notify("]) {
      expect(code, `${call} has no business in the webhook door`).not.toContain(call);
    }
  });

  it("suppresses nobody and unsubscribes nobody", () => {
    // The temptation the day a bounce arrives is to bolt "mark this address
    // dead" straight onto the handler. What a bounce obliges us to do is a
    // product decision nobody has made. This scan fails the day somebody
    // decides it here instead.
    for (const t of ["users", "households", "parks", "suppressions", "contact"]) {
      expect(code, `${t} must not be touched by the webhook door`).not.toMatch(
        new RegExp(`from\\(["'\`]${t}["'\`]`),
      );
    }
    expect(code).not.toContain("createServiceClient");
  });

  it("proves the scan can fail", () => {
    const planted = `${code}\n await admin.from("users").update({ email_ok: false });`;
    expect(planted).toMatch(/from\(["'`]users["'`]/);
  });
});

describe("the ledger's rules live in migration 0187, not in this route", () => {
  const SQL = readFileSync(
    join(process.cwd(), "supabase/migrations/0187_a_bounce_addressed_to_nobody.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");

  it("makes message_id unique", () => {
    expect(SQL).toMatch(/message_id\s+text\s+not null\s+unique/i);
  });

  it("lets no client role near a table of who we wrote to", () => {
    expect(SQL).toMatch(/alter table public\.email_receipts enable row level security/i);
    expect(SQL).toMatch(/revoke all on public\.email_receipts from anon, authenticated/i);
  });

  it("puts the forward-only rule in a trigger, where a race cannot beat it", () => {
    expect(SQL).toMatch(/create or replace function public\.email_receipt_only_advances/i);
    expect(SQL).toMatch(/before update on public\.email_receipts/i);
  });

  it("treats a status it has never heard of as news, not as progress", () => {
    expect(SQL).toMatch(/create or replace function public\.email_status_rank/i);
    expect(SQL).toMatch(/else null/i);
  });

  it("stores digests of the subject and body, never the subject or the body", () => {
    expect(SQL).toMatch(/subject_sha256\s+text\s+not null/i);
    expect(SQL).toMatch(/body_sha256\s+text\s+not null/i);
    expect(SQL).not.toMatch(/^\s*subject\s+text/im);
    expect(SQL).not.toMatch(/^\s*body\s+text/im);
  });
});

/**
 * A SHARED RESEND ACCOUNT, AND THE SIGNAL IT WOULD HAVE DESTROYED.
 *
 * This account also sends BD DevCo's investor portal — data rooms, NDAs,
 * K-1s — and a Resend webhook is ACCOUNT-WIDE. On a sample of the live send
 * log, 24 of 25 messages were theirs, so without a sender check every one of
 * them would land on the "we hold no receipt for" warning.
 *
 * That warning is the one this door exists to raise: a sudden run of it means
 * sendEmail has stopped filing attempts, which is the outage starting again.
 * Buried under another company's ordinary traffic it would mean nothing.
 */
describe("a verdict about somebody else's message", () => {
  const send = async (data: Record<string, unknown>) => {
    const body = event("email.delivered", data);
    return post(body, { [HEADER]: sign(body) });
  };

  beforeEach(() => {
    calls = [];
    result = { matched: true };
  });

  it("is dropped quietly, and never reaches the receipt writer", async () => {
    const res = await send({ from: "BD DevCo <info@bddev.co>" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "not ours" });
    expect(calls, "another company's delivery was written to our ledger").toHaveLength(0);
  });

  it("but OURS that matches no row still shouts — the alarm survives", async () => {
    // Collapse it the other way. If the sender check were too broad this would
    // go quiet too, and the outage signal would be gone with it.
    result = { matched: false };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send({ from: "LakeLife <ops@lakelife.ai>" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unknown: true });
    expect(warn.mock.calls.flat().join(" ")).toContain("no receipt for");
    warn.mockRestore();
  });

  it("a display-name wrapper and a bare address are both read", async () => {
    for (const from of ["ops@lakelife.ai", "LakeLife <ops@lakelife.ai>"]) {
      calls = [];
      await send({ from });
      expect(calls, `${from} was not recognised as ours`).toHaveLength(1);
    }
  });

  it("no sender at all is treated as OURS — it fails towards noise, not silence", async () => {
    // A missed warning is the expensive direction; a spurious one is annoying.
    await send({});
    expect(calls).toHaveLength(1);
  });

  it("the sandbox sender is ours, because a sandbox send files a real row", async () => {
    await send({ from: "LakeLife <onboarding@resend.dev>" });
    expect(calls).toHaveLength(1);
  });
});
