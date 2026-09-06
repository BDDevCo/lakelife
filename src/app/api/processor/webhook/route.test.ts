import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A REAL PROCESSOR HAS NOBODY TO TELL.
 *
 * Until this route existed, `src/app/api/` held cron, ics, ops and verify —
 * and every event a live processor emits (a capture, a refund, a dispute, and
 * above all an ACH RETURN three to five business days after the money looked
 * final) would have arrived at a 404. The processor would retry, give up, and
 * the ledger would go on believing a returned payment had cleared.
 *
 * These tests hold down the four things the door itself must get right —
 * refuse an unsigned caller, refuse an UNSET secret, store a signed event
 * verbatim, and treat a replay as a no-op — plus one source scan proving the
 * door has not quietly grown a state machine that nobody has designed yet.
 */

vi.mock("server-only", () => ({}));

// The fake Supabase: one table, and the partial unique index on event_id that
// migration 0157 creates, because the replay guard IS that index.
interface Row { [k: string]: unknown }
let stored: Row[] = [];
let insertFails: string | null = null;

const admin = {
  from: (tableName: string) => ({
    insert: (row: Row) => {
      if (insertFails) return Promise.resolve({ data: null, error: { code: "XX000", message: insertFails } });
      if (tableName !== "processor_events") {
        return Promise.resolve({ data: null, error: { code: "42P01", message: `no table ${tableName}` } });
      }
      const eventId = row.event_id;
      if (stored.some((r) => r.event_id === eventId)) {
        // Postgres 23505 — the unique index refusing the second row. This is
        // the shape the route has to read as "already heard", not as a failure.
        return Promise.resolve({
          data: null,
          error: { code: "23505", message: "duplicate key value violates unique constraint \"processor_events_event_id_key\"" },
        });
      }
      stored.push(row);
      return Promise.resolve({ data: null, error: null });
    },
  }),
};

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => admin }));

const SECRET = "whsec_the_processor_gave_us_this";
const ENV = "PROCESSOR_WEBHOOK_SECRET";

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

const post = async (body: string, headers: Record<string, string>) => {
  const { POST } = await import("./route");
  return POST(new Request("https://lakelife.test/api/processor/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }));
};

const EVENT = JSON.stringify({
  id: "evt_9f2c1a",
  type: "ach.return",
  data: { payment: "py_44", reason: "R01", amount_cents: 54253 },
});

beforeEach(() => {
  stored = [];
  insertFails = null;
  process.env[ENV] = SECRET;
});
afterEach(() => {
  delete process.env[ENV];
  delete process.env.PROCESSOR_NAME;
  delete process.env.PROCESSOR_WEBHOOK_SIGNATURE_HEADER;
});

describe("a signed event is written down and acknowledged", () => {
  it("stores the event verbatim and returns 200", async () => {
    process.env.PROCESSOR_NAME = "acmepay";
    const res = await post(EVENT, { "x-processor-signature": sign(EVENT) });

    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].provider).toBe("acmepay");
    expect(stored[0].event_id).toBe("evt_9f2c1a");
    expect(stored[0].event_type).toBe("ach.return");
    // Verbatim: every field the processor sent, not a chosen few.
    expect(stored[0].payload).toEqual(JSON.parse(EVENT));
    // Nothing has looked at it yet — that is the state machine's job, and it
    // does not exist. A row that arrived already processed would be a lie.
    expect(stored[0].processed_at ?? null).toBeNull();
  });

  it("acknowledges with 200 so the processor stops retrying", async () => {
    const res = await post(EVENT, { "x-processor-signature": sign(EVENT) });
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("accepts the sha256= prefix processors commonly send", async () => {
    const res = await post(EVENT, { "x-processor-signature": `sha256=${sign(EVENT)}` });
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
  });

  it("records an event whose id and type it does not recognise, rather than dropping it", async () => {
    // The one thing worse than an unhandled event is an unrecorded one.
    const odd = JSON.stringify({ notes: "a shape nobody predicted" });
    const res = await post(odd, { "x-processor-signature": sign(odd) });
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toEqual({ notes: "a shape nobody predicted" });
    expect(stored[0].event_type ?? null).toBeNull();
    // Still idempotent: with no id of its own, the body itself is the id.
    expect(String(stored[0].event_id)).toMatch(/^body:[0-9a-f]{64}$/);
  });

  it("asks the processor to retry when the row could not be written", async () => {
    // A 200 here would tell the processor the event is safe with us when it is
    // nowhere at all. An ACH return we acknowledged and lost is unrecoverable.
    insertFails = "connection reset";
    const res = await post(EVENT, { "x-processor-signature": sign(EVENT) });
    expect(res.status).toBe(500);
    expect(stored).toHaveLength(0);
  });
});

describe("a replayed event is a no-op, not a second row", () => {
  it("writes one row for two identical deliveries", async () => {
    const sig = sign(EVENT);
    const first = await post(EVENT, { "x-processor-signature": sig });
    const second = await post(EVENT, { "x-processor-signature": sig });

    expect(first.status).toBe(200);
    // The processor is told "heard you" — a 500 here starts a retry storm over
    // an event we already hold.
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ ok: true, duplicate: true });
    expect(stored).toHaveLength(1);
  });
});

describe("an unsigned or wrongly-signed caller is refused", () => {
  it("refuses when the signature header is missing", async () => {
    const res = await post(EVENT, {});
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("refuses a signature computed with the wrong secret", async () => {
    const res = await post(EVENT, { "x-processor-signature": sign(EVENT, "not_our_secret") });
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("refuses a signature over a different body", async () => {
    // The tamper case: a real event's signature replayed over an edited body.
    const tampered = EVENT.replace("54253", "1");
    const res = await post(tampered, { "x-processor-signature": sign(EVENT) });
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("refuses when the secret is UNSET — never fails open", async () => {
    // The day this route ships, PROCESSOR_WEBHOOK_SECRET is unset everywhere.
    // If an unset secret accepted anything, the endpoint would be a public
    // write into a table holding raw processor payloads.
    delete process.env[ENV];

    // Signed with the real secret: refused, because we hold no secret to check
    // it against.
    expect((await post(EVENT, { "x-processor-signature": sign(EVENT) })).status).toBe(401);

    // And signed the way an EMPTY secret would sign — the exact request a
    // fail-open door would wave through.
    const emptyKeyed = createHmac("sha256", "").update(EVENT).digest("hex");
    expect((await post(EVENT, { "x-processor-signature": emptyKeyed })).status).toBe(401);

    expect(stored).toHaveLength(0);
  });

  it("refuses when the secret is set to an empty string", async () => {
    process.env[ENV] = "";
    const res = await post(EVENT, { "x-processor-signature": createHmac("sha256", "").update(EVENT).digest("hex") });
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });
});

describe("GET is not a door", () => {
  it("returns 405, the way payout-export already does", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe("the door is still only a door", () => {
  // WIDEN THE GUARD. The temptation the moment a real processor connects is to
  // bolt "if event is ach.return, mark the payment failed" straight onto this
  // handler. That state machine is a product decision Brendon has not made
  // yet, and 0142 already says the database will refuse to reverse a card or
  // ACH payment. This scan fails the day somebody adds it here instead.
  const SRC = readFileSync(join(process.cwd(), "src/app/api/processor/webhook/route.ts"), "utf8");
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("names no money table but its own", () => {
    for (const t of ["payments", "invoices", "park_payments", "payouts", "park_charges", "payout_batches"]) {
      expect(code, `${t} must not be touched by the webhook door`).not.toMatch(
        new RegExp(`["'\`]${t}["'\`]`),
      );
    }
    expect(code).toMatch(/["']processor_events["']/);
  });

  it("moves no money and marks nothing paid", () => {
    for (const call of ["takePayment", "giveRefund", "LakeLifePayments", "recompute_charge_paid"]) {
      expect(code, `${call} has no business in the webhook door`).not.toContain(call);
    }
  });

  it("proves the scan can fail", () => {
    // A scanner that finds nothing in a file that says nothing proves nothing.
    const planted = `${code}\n await admin.from("payments").update({ status: "failed" });`;
    expect(planted).toMatch(/["']payments["']/);
  });
});

describe("the replay guard lives in the database, not in this test's fake", () => {
  // The route's idempotency is one line — reading 23505 as "already heard" —
  // and it is worth nothing without the index that raises it. That index is in
  // a different file, so this asserts on the migration itself.
  const SQL = readFileSync(
    join(process.cwd(), "supabase/migrations/0157_somebody_has_to_hear_the_processor.sql"),
    "utf8",
  ).replace(/--[^\n]*/g, "");

  it("makes event_id unique", () => {
    expect(SQL).toMatch(/event_id\s+text\s+not null\s+unique/i);
  });

  it("lets no client role near a table of raw processor payloads", () => {
    expect(SQL).toMatch(/revoke all on public\.processor_events from anon, authenticated/i);
    expect(SQL).toMatch(/alter table public\.processor_events enable row level security/i);
  });

  it("starts every event unprocessed", () => {
    // processed_at with a default would claim the state machine had run.
    expect(SQL).toMatch(/processed_at\s+timestamptz\s*(?:,|\n)/i);
    expect(SQL).not.toMatch(/processed_at[^,\n]*default/i);
  });
});
