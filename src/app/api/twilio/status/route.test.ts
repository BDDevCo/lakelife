import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE VERDICT THAT WAS ADDRESSED TO NOBODY.
 *
 * Twilio has always posted the carrier's answer — delivered, undelivered,
 * failed, and the error code with it — to whatever URL the message named as
 * its StatusCallback. This app never named one and had no route to name, so
 * between 19 July and 16 August 2026 eighty-one rejections, sixty-six of them
 * error 30034, arrived nowhere. Every one of those messages was recorded by
 * this product as sent.
 *
 * These tests hold down what the door owes: it answers only to Twilio, it
 * validates against the URL WE published rather than one a caller can choose,
 * it hears the same receipt twice without effect, it distinguishes a verdict
 * it could not store (tell us again) from a SID it does not know (fine), and
 * it still sends nothing and charges nothing.
 *
 * THE SIGNATURE IS COMPUTED HERE FROM THE PUBLISHED ALGORITHM, over a fake
 * token that exists only in this file. No real credential appears anywhere in
 * this suite, and the check is proven in BOTH directions — a valid signature
 * is accepted, and five different ways of getting it wrong are refused.
 */

vi.mock("server-only", () => ({}));

const TOKEN = "fake_auth_token_for_this_test_only";
const URL_WE_PUBLISHED = "https://www.lakelife.ai/api/twilio/status";

/**
 * Twilio's documented scheme, written out rather than imported so that this
 * file pins the algorithm independently of the SDK the route calls:
 * take the full request URL, append every POST parameter sorted by name as
 * name immediately followed by value, HMAC-SHA1 the result with the auth
 * token, and base64 the digest.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function twilioSignature(url: string, params: Record<string, string>, token = TOKEN): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

const post = async (params: Record<string, string>, signature: string | null) => {
  const { POST } = await import("./route");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signature !== null) headers["x-twilio-signature"] = signature;
  return POST(new Request(URL_WE_PUBLISHED, { method: "POST", headers, body: form(params) }));
};

/** What Twilio actually posts when a carrier refuses an unregistered sender. */
const REJECTED = {
  MessageSid: "SM0be9a5f2c4d34f0ea1b7",
  MessageStatus: "undelivered",
  ErrorCode: "30034",
  AccountSid: "ACfake",
  To: "+12604631234",
  From: "+12605550100",
};

const DELIVERED = {
  MessageSid: "SM0be9a5f2c4d34f0ea1b7",
  MessageStatus: "delivered",
  AccountSid: "ACfake",
  To: "+12604631234",
};

let recorded: Array<{ sid: string; status: string; errorCode?: string | null }> = [];
let matched = true;
let recordError: string | undefined;

vi.mock("@/lib/sms-receipts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms-receipts")>();
  return {
    ...real,
    recordSmsReceipt: vi.fn(async (r: { sid: string; status: string; errorCode?: string | null }) => {
      recorded.push(r);
      return recordError ? { matched: false, error: recordError } : { matched };
    }),
  };
});

beforeEach(() => {
  recorded = [];
  matched = true;
  recordError = undefined;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
});
afterEach(() => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("a genuine receipt is written down and acknowledged", () => {
  it("records the carrier's refusal, error code and all", async () => {
    const res = await post(REJECTED, twilioSignature(URL_WE_PUBLISHED, REJECTED));

    expect(res.status).toBe(200);
    expect(recorded).toEqual([
      { sid: REJECTED.MessageSid, status: "undelivered", errorCode: "30034" },
    ]);
  });

  it("records an arrival with no error code", async () => {
    const res = await post(DELIVERED, twilioSignature(URL_WE_PUBLISHED, DELIVERED));
    expect(res.status).toBe(200);
    expect(recorded[0]).toMatchObject({ status: "delivered" });
    expect(recorded[0].errorCode ?? null).toBeNull();
  });

  it("hears the same receipt twice without a second effect", async () => {
    // Twilio redelivers whenever it thinks we missed one. The row's own rule —
    // a receipt may advance a message, never walk it back — is the trigger in
    // 0171, so a replay reaching the helper twice is harmless by construction.
    const sig = twilioSignature(URL_WE_PUBLISHED, DELIVERED);
    const first = await post(DELIVERED, sig);
    const second = await post(DELIVERED, sig);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(recorded[0]).toEqual(recorded[1]);
  });

  it("asks to be told again when the verdict could not be stored", async () => {
    // A 200 here says the verdict is safe with us when it is nowhere at all,
    // and the verdict most likely to be lost is the one saying nothing is
    // arriving.
    recordError = "connection reset";
    const res = await post(REJECTED, twilioSignature(URL_WE_PUBLISHED, REJECTED));
    expect(res.status).toBe(500);
  });

  it("accepts a SID it holds no receipt for, rather than making Twilio retry for days", async () => {
    // A Verify code, or a send from another environment on the same account.
    matched = false;
    const res = await post(DELIVERED, twilioSignature(URL_WE_PUBLISHED, DELIVERED));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, unknown: true });
  });

  it("acknowledges an authentic request it cannot read, and writes nothing", async () => {
    const odd = { AccountSid: "ACfake", SomethingNew: "1" };
    const res = await post(odd, twilioSignature(URL_WE_PUBLISHED, odd));
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(0);
  });
});

describe("anything that is not Twilio is refused with a 403", () => {
  it("refuses a request with no signature at all", async () => {
    const res = await post(REJECTED, null);
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a signature computed with a different token", async () => {
    const res = await post(REJECTED, twilioSignature(URL_WE_PUBLISHED, REJECTED, "some_other_token"));
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a real signature replayed over edited parameters", async () => {
    // The attack this check exists for: take a genuine `undelivered` receipt
    // and change it to `delivered`, so a dead channel looks alive.
    const tampered = { ...REJECTED, MessageStatus: "delivered" };
    const res = await post(tampered, twilioSignature(URL_WE_PUBLISHED, REJECTED));
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a signature computed over a DIFFERENT url", async () => {
    // The URL is ours, from `statusCallbackUrl()`, not rebuilt from the
    // request's own Host header — otherwise a caller behind a proxy could
    // choose the string we hash and sign one that matches it.
    const res = await post(REJECTED, twilioSignature("https://evil.example/api/twilio/status", REJECTED));
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses everything when the auth token is unset — never fails open", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    expect((await post(REJECTED, twilioSignature(URL_WE_PUBLISHED, REJECTED))).status).toBe(403);
    // And signed the way an EMPTY token would sign it — the exact request a
    // fail-open door would wave through.
    expect((await post(REJECTED, twilioSignature(URL_WE_PUBLISHED, REJECTED, ""))).status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses when there is no published callback URL to check against", async () => {
    // On a local origin `sendSms` asks for no callbacks at all, so nothing
    // arriving here is a receipt for anything we sent.
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
    const res = await post(REJECTED, twilioSignature("http://localhost:3000/api/twilio/status", REJECTED));
    expect(res.status).toBe(403);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a body sent as something other than form parameters", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request(URL_WE_PUBLISHED, {
      method: "POST",
      headers: { "content-type": "application/json", "x-twilio-signature": "anything" },
      body: JSON.stringify(REJECTED),
    }));
    expect(res.status).toBe(415);
    expect(recorded).toHaveLength(0);
  });
});

describe("GET is not a door", () => {
  it("returns 405, the way the processor webhook already does", async () => {
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(405);
  });
});

describe("the door is still only a door", () => {
  // WIDEN THE GUARD. The temptation the first time a 30034 lands here is to
  // bolt "so re-send it by email" onto the handler. What to do about a failed
  // text is a product decision nobody has made, and a webhook that starts
  // sending is a webhook that can be made to send by anybody who works out the
  // signature. Reporting is the digest's job.
  const SRC = readFileSync(join(process.cwd(), "src/app/api/twilio/status/route.ts"), "utf8");
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("sends nothing and charges nothing", () => {
    for (const call of ["sendSms", "sendEmail", "notify(", "takePayment", "giveRefund"]) {
      expect(code, `${call} has no business in the status callback door`).not.toContain(call);
    }
  });

  it("touches no table but the receipts, and only through the helper", () => {
    for (const t of ["payments", "invoices", "jobs", "park_payments", "users"]) {
      expect(code, `${t} must not be touched by the status callback`).not.toMatch(
        new RegExp(`["'\`]${t}["'\`]`),
      );
    }
    expect(code).toContain("recordSmsReceipt");
  });

  it("validates with the SDK rather than a hand-rolled digest", () => {
    // Twilio's own documentation is explicit that the parameter set changes
    // without notice and that the SDK validator should be used.
    expect(code).toContain("twilio.validateRequest");
    expect(code).not.toContain("createHmac");
  });

  it("proves the scan can fail", () => {
    // A scanner that finds nothing in a file that says nothing proves nothing.
    const planted = `${code}\n await sendEmail({ to: "ops@lakelife.ai" });`;
    expect(planted).toContain("sendEmail");
  });
});

describe("the rules this door leans on live in the database", () => {
  // The route is an UPDATE and nothing more. Everything that makes that safe —
  // one row per SID, and a receipt that can only move a message forward — is
  // in the migration, so it is asserted against the migration.
  const SQL = readFileSync(
    join(process.cwd(), "supabase/migrations/0171_accepted_is_not_delivered.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");

  it("makes the message SID unique", () => {
    expect(SQL).toMatch(/message_sid\s+text\s+not null\s+unique/i);
  });

  it("keeps a receipt from walking a message backwards", () => {
    expect(SQL).toMatch(/create trigger sms_receipts_only_advances/i);
    expect(SQL).toMatch(/before update on public\.sms_receipts/i);
    for (const terminal of ["delivered", "undelivered", "failed", "canceled"]) {
      expect(SQL).toContain(`'${terminal}'`);
    }
  });

  it("lets no client role near a record of who we texted", () => {
    expect(SQL).toMatch(/revoke all on public\.sms_receipts from anon, authenticated/i);
    expect(SQL).toMatch(/alter table public\.sms_receipts enable row level security/i);
  });

  it("keeps the body out of the table", () => {
    // Length and digest only. A column holding the text would make an
    // operations table into a store of what residents were told.
    expect(SQL).toMatch(/body_length\s+integer/i);
    expect(SQL).toMatch(/body_sha256\s+text/i);
    expect(SQL).not.toMatch(/^\s*body\s+text/im);
  });

  it("proves this scan can fail too", () => {
    expect(`${SQL}\n  body text not null,`).toMatch(/^\s*body\s+text/im);
  });
});

describe("the path needs no robots entry of its own", () => {
  it("is already covered by the blanket /api/ disallow", () => {
    // If that line ever goes, this route needs naming explicitly — a status
    // callback URL in an index is a URL somebody will POST to.
    const robots = readFileSync(join(process.cwd(), "src/app/robots.ts"), "utf8");
    expect(robots).toContain('"/api/"');
  });
});
