import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

/**
 * A TEXT THAT LEAVES NO RECEIPT IS A TEXT NOBODY CAN MISS.
 *
 * Eighty-one messages went out between 19 July and 16 August 2026 and not one
 * arrived; sixty-six were refused with error 30034, an unregistered A2P 10DLC
 * sender. The product recorded every one of them as sent, because acceptance
 * was the only event it ever saw.
 *
 * These hold down the record that ends that: the row carries the fingerprint
 * of a message and never the message, a verdict that matches nothing is not an
 * error, and a read that FAILED is never reported as a week with no texts in
 * it — the sentence that would put the outage straight back.
 */

vi.mock("server-only", () => ({}));

interface Row { [k: string]: unknown }

let rows: Row[] = [];
let insertError: { code?: string; message: string } | null = null;
let updateError: { message: string } | null = null;
let selectError: { message: string } | null = null;
let throwOnClient = false;

/**
 * A Supabase stand-in with just enough of the shape: insert honours the unique
 * index on message_sid, update returns the rows it matched (which is how the
 * route learns a SID is unknown), and select filters on created_at.
 */
const admin = {
  from: (table: string) => ({
    insert: (row: Row) => {
      if (table !== "sms_receipts") {
        return Promise.resolve({ data: null, error: { code: "42P01", message: `no table ${table}` } });
      }
      if (insertError) return Promise.resolve({ data: null, error: insertError });
      if (rows.some((r) => r.message_sid === row.message_sid)) {
        return Promise.resolve({
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "sms_receipts_message_sid_key"' },
        });
      }
      rows.push({ created_at: new Date().toISOString(), ...row });
      return Promise.resolve({ data: null, error: null });
    },
    update: (patch: Row) => ({
      eq: (col: string, val: unknown) => ({
        select: () => {
          if (updateError) return Promise.resolve({ data: null, error: updateError });
          const hit = rows.filter((r) => r[col] === val);
          for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit.map((r) => ({ message_sid: r.message_sid })), error: null });
        },
      }),
    }),
    select: (_cols: string) => {
      const q = {
        gte: (col: string, val: string) => {
          q._rows = q._rows.filter((r) => String(r[col]) >= val);
          return q;
        },
        order: () => q,
        limit: () => Promise.resolve(
          selectError ? { data: null, error: selectError } : { data: q._rows, error: null },
        ),
        _rows: [...rows],
      };
      return q;
    },
  }),
};

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    if (throwOnClient) throw new Error("no supabase url");
    return admin;
  },
}));

const load = () => import("@/lib/sms-receipts");

beforeEach(() => {
  rows = [];
  insertError = null;
  updateError = null;
  selectError = null;
  throwOnClient = false;
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.lakelife.ai";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("the body is fingerprinted, never kept", () => {
  it("stores a length and a SHA-256 and nothing a person said", async () => {
    const { recordSmsAttempt } = await load();
    const body = "Your pier removal at 9085 E 500 S is Tuesday. Reply STOP to opt out.";

    await recordSmsAttempt({ sid: "SM1", to: "+12604631234", kind: "pier removal", body, acceptedStatus: "queued" });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.body_length).toBe(body.length);
    expect(row.body_sha256).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    // Not one word of it, under any column name. A table of what residents
    // were told about their homes is not what this is for.
    for (const [key, value] of Object.entries(row)) {
      expect(String(value), `${key} carried the message body`).not.toContain("pier removal at");
      expect(String(value), `${key} carried the message body`).not.toContain("9085");
    }
  });

  it("gives the same fingerprint to the same words and a different one to different words", async () => {
    const { fingerprintBody } = await load();
    expect(fingerprintBody("crew on the way").sha256).toBe(fingerprintBody("crew on the way").sha256);
    expect(fingerprintBody("crew on the way").sha256).not.toBe(fingerprintBody("crew on the wav").sha256);
  });

  it("files an unlabelled send rather than refusing to file it", async () => {
    const { recordSmsAttempt } = await load();
    await recordSmsAttempt({ sid: "SM2", to: "+12604631234", body: "hello" });
    expect(rows[0].kind).toBe("unlabelled");
  });

  it("does not leave the status null while a message waits for its verdict", async () => {
    // A null status is indistinguishable from a message nobody ever asked
    // about, which is what the whole of August looked like from in here.
    const { recordSmsAttempt } = await load();
    await recordSmsAttempt({ sid: "SM3", to: "+12604631234", body: "hello", acceptedStatus: "queued" });
    expect(rows[0].status).toBe("queued");
    expect(rows[0].accepted_status).toBe("queued");
  });

  it("reports a write it could not make instead of swallowing it", async () => {
    const { recordSmsAttempt } = await load();
    insertError = { code: "XX000", message: "connection reset" };
    const res = await recordSmsAttempt({ sid: "SM4", to: "+12604631234", body: "hello" });
    expect(res.recorded).toBe(false);
    expect(res.error).toContain("connection reset");
  });

  it("treats a SID it has already filed as filed, not as a failure", async () => {
    const { recordSmsAttempt } = await load();
    await recordSmsAttempt({ sid: "SM5", to: "+12604631234", body: "hello" });
    const again = await recordSmsAttempt({ sid: "SM5", to: "+12604631234", body: "hello" });
    expect(again.recorded).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("survives a database it cannot even reach", async () => {
    const { recordSmsAttempt } = await load();
    throwOnClient = true;
    const res = await recordSmsAttempt({ sid: "SM6", to: "+12604631234", body: "hello" });
    // A booking must not fail because its receipt row did not save.
    expect(res.recorded).toBe(false);
  });
});

describe("the carrier's verdict lands on the row", () => {
  it("writes the status, the code and the code in English", async () => {
    const { recordSmsAttempt, recordSmsReceipt } = await load();
    await recordSmsAttempt({ sid: "SM7", to: "+12604631234", body: "hello", acceptedStatus: "queued" });

    const res = await recordSmsReceipt({ sid: "SM7", status: "undelivered", errorCode: "30034" });

    expect(res.matched).toBe(true);
    expect(rows[0].status).toBe("undelivered");
    expect(rows[0].error_code).toBe("30034");
    // The number in words, beside it — 30034 is the one that cost us August,
    // and a four-digit code is a thing to go and google at the worst moment.
    expect(String(rows[0].error_text)).toContain("A2P 10DLC");
  });

  it("clears the error fields on a verdict that carries no code", async () => {
    const { recordSmsAttempt, recordSmsReceipt } = await load();
    await recordSmsAttempt({ sid: "SM8", to: "+12604631234", body: "hello", acceptedStatus: "queued" });
    await recordSmsReceipt({ sid: "SM8", status: "delivered" });
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].error_code).toBeNull();
    expect(rows[0].error_text).toBeNull();
  });

  it("says a SID it holds no receipt for is UNMATCHED, not broken", async () => {
    // Verify codes ride a different service and are never filed here. A 500
    // for one of those would have Twilio redeliver for days against a row that
    // will never exist.
    const { recordSmsReceipt } = await load();
    const res = await recordSmsReceipt({ sid: "SM_never_seen", status: "delivered" });
    expect(res.matched).toBe(false);
    expect(res.error).toBeUndefined();
  });

  it("distinguishes a write that FAILED from a SID that is simply unknown", async () => {
    // The route answers 500 to one and 200 to the other, so they cannot be the
    // same return value.
    const { recordSmsReceipt } = await load();
    updateError = { message: "connection reset" };
    const res = await recordSmsReceipt({ sid: "SM9", status: "delivered" });
    expect(res.matched).toBe(false);
    expect(res.error).toContain("connection reset");
  });
});

describe("where Twilio is told to post the verdict", () => {
  it("is built from the site origin, not written out by hand", async () => {
    const { statusCallbackUrl, STATUS_CALLBACK_PATH } = await load();
    process.env.NEXT_PUBLIC_SITE_URL = "https://beta.lakelife.ai/";
    expect(statusCallbackUrl()).toBe(`https://beta.lakelife.ai${STATUS_CALLBACK_PATH}`);
  });

  it("asks for NO callback from a local or plain-http origin", async () => {
    // Twilio validates the StatusCallback as it accepts the message and
    // refuses an unroutable one (21609). Sending localhost would stop every
    // text going out — a change made to watch delivery causing its own outage.
    const { statusCallbackUrl } = await load();
    for (const origin of [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://127.0.0.1:3000",
      "http://www.lakelife.ai",
    ]) {
      process.env.NEXT_PUBLIC_SITE_URL = origin;
      expect(statusCallbackUrl(), `${origin} must not be handed to Twilio`).toBeNull();
    }
  });

  it("falls back to null when no origin is set at all", async () => {
    const { statusCallbackUrl } = await load();
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(statusCallbackUrl()).toBeNull();
  });
});

describe("did any of it arrive", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  const at = (hoursAgo: number, status: string, code?: string): Row => ({
    created_at: new Date(now - hoursAgo * HOUR).toISOString(),
    status,
    error_code: code ?? null,
  });

  it("counts today and the week separately, and the week contains today", async () => {
    const { smsDeliveryReport } = await load();
    rows = [
      at(1, "delivered"),
      at(2, "undelivered", "30034"),
      at(3, "queued"),
      at(50, "delivered"),
      at(60, "failed", "30007"),
    ];

    const r = await smsDeliveryReport(now);

    expect(r.day).toEqual({ attempted: 3, delivered: 1, failed: 1, waiting: 1 });
    expect(r.week).toEqual({ attempted: 5, delivered: 2, failed: 2, waiting: 1 });
    // Every message is in exactly one bucket, so the three always tie back.
    expect(r.week!.delivered + r.week!.failed + r.week!.waiting).toBe(r.week!.attempted);
  });

  it("names the reasons worst first, in English", async () => {
    const { smsDeliveryReport } = await load();
    rows = [at(1, "undelivered", "30034"), at(2, "undelivered", "30034"), at(3, "failed", "21610")];
    const r = await smsDeliveryReport(now);
    expect(r.reasons[0].code).toBe("30034");
    expect(r.reasons[0].count).toBe(2);
    expect(r.reasons[0].text).toContain("A2P 10DLC");
    expect(r.reasons[1].text).toContain("STOP");
  });

  it("says something even when the carrier sent no reason at all", async () => {
    const { smsDeliveryReport } = await load();
    rows = [at(1, "failed")];
    const r = await smsDeliveryReport(now);
    expect(r.reasons[0].code).toBe("unknown");
    expect(r.reasons[0].text).toContain("no reason code");
  });

  it("A FAILED READ IS NULL, NEVER ZERO", async () => {
    // Zeroes here render as "no texts went out", which is a clean bill of
    // health for a channel nobody managed to look at. That is the exact
    // sentence this package exists to make impossible.
    const { smsDeliveryReport } = await load();
    selectError = { message: "statement timeout" };
    const r = await smsDeliveryReport(now);
    expect(r.day).toBeNull();
    expect(r.week).toBeNull();
    expect(r.error).toContain("statement timeout");
  });

  it("and a genuinely empty week IS zero, not null", async () => {
    // The other half of the branch: absence of texts and absence of an answer
    // must not be the same value, or the null above proves nothing.
    const { smsDeliveryReport } = await load();
    rows = [];
    const r = await smsDeliveryReport(now);
    expect(r.day).toEqual({ attempted: 0, delivered: 0, failed: 0, waiting: 0 });
    expect(r.week).toEqual({ attempted: 0, delivered: 0, failed: 0, waiting: 0 });
    expect(r.error).toBeUndefined();
  });

  it("reads a database it cannot reach as 'could not check'", async () => {
    const { smsDeliveryReport } = await load();
    throwOnClient = true;
    const r = await smsDeliveryReport(now);
    expect(r.day).toBeNull();
    expect(r.week).toBeNull();
  });
});
