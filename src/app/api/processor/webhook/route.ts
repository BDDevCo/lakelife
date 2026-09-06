import { NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/processor/webhook — SOMEBODY HAS TO HEAR THE PROCESSOR.
 *
 * The day `LAKELIFE_PAYMENTS_LIVE` stops declining, a real processor starts
 * talking back: a capture settled, a refund completed, a dispute opened, and
 * the one that matters most — an ACH debit that succeeded on Monday and is
 * RETURNED on Thursday. Before this file, `src/app/api/` held cron, ics, ops
 * and verify and nothing else, so every one of those messages would have hit a
 * 404, been retried a handful of times, and been dropped. The ledger would go
 * on showing rent PAID for money the bank had already taken back.
 *
 * ============ THIS IS THE DOOR, NOT THE POLICY ============
 *
 * It records the event and says thank you. It does not touch payments,
 * invoices, park_payments or payouts, and a test scans this file to keep it
 * that way. The pending → cleared → returned state machine is ours to build,
 * but the owner's own brief (docs/processor-questions.md) says it "cannot be
 * designed until we know what they send us", and inventing it here would be
 * inventing policy — on top of a ledger where 0142 already makes the database
 * REFUSE to reverse a card or ACH payment. So: every event lands in
 * `processor_events` with `processed_at` null, and the handler that drains
 * that table is written after the processor call, against real event names.
 *
 * ============ THREE THINGS THIS DOOR OWES ============
 *
 * 1. IT NEVER FAILS OPEN. No secret configured means refuse, not accept.
 *    Today the secret is unset in every environment, and a route that trusted
 *    an unset secret would be an unauthenticated write into a table holding
 *    raw processor payloads.
 * 2. IT ACKNOWLEDGES ONLY WHAT IT WROTE. A 200 tells the processor to stop
 *    retrying. Returning one for an event we failed to store loses it forever,
 *    so a write failure answers 500 and asks to be told again.
 * 3. IT HEARS EACH EVENT ONCE. Processors redeliver freely — that is normal,
 *    not an error — so a replay is a no-op, enforced by the unique index on
 *    `event_id` in 0157 rather than by a read-then-write that two concurrent
 *    deliveries would both win.
 *
 * ============ THE DIALS ============
 *
 * PROCESSOR_WEBHOOK_SECRET            the shared secret. Unset ⇒ refuse all.
 * PROCESSOR_WEBHOOK_SIGNATURE_HEADER  which header carries the signature.
 *                                     Every processor names it differently;
 *                                     defaults to x-processor-signature.
 * PROCESSOR_NAME                      what to file the events under, so a
 *                                     second processor never looks like the
 *                                     first. Defaults to "unknown".
 */

export const dynamic = "force-dynamic";

const DEFAULT_SIGNATURE_HEADER = "x-processor-signature";

/** A processor payload is a few kilobytes. Anything past this is not one. */
const MAX_BODY_BYTES = 1_000_000;

export async function GET() {
  // A webhook is a POST. GET exists only to say so plainly, rather than
  // letting a browser or a link prefetch look like a delivery.
  return NextResponse.json(
    { error: "Processor events are delivered by POST." },
    { status: 405 },
  );
}

export async function POST(req: Request) {
  const secret = process.env.PROCESSOR_WEBHOOK_SECRET ?? "";
  const headerName = (process.env.PROCESSOR_WEBHOOK_SIGNATURE_HEADER || DEFAULT_SIGNATURE_HEADER)
    .toLowerCase();
  const provided = req.headers.get(headerName) ?? "";

  // FAIL CLOSED, IN THIS ORDER. An unset secret is refused before the body is
  // read: with no secret there is no caller we can recognise, and "we have no
  // lock" must never mean "come in". Same 401 as a wrong signature, because
  // the difference is our configuration problem and not the caller's business.
  if (!secret || !provided) {
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }
  if (!signatureMatches(raw, provided, secret)) {
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  // Past this line the delivery is authentic, so it gets written down whatever
  // shape it is in. An event we cannot parse is still an event that happened,
  // and the one thing worse than an unhandled event is an unrecorded one.
  const payload = parseOrKeep(raw);
  const eventId = readEventId(payload) ?? `body:${createHash("sha256").update(raw, "utf8").digest("hex")}`;

  const admin = createServiceClient();
  const { error } = await admin.from("processor_events").insert({
    provider: process.env.PROCESSOR_NAME || "unknown",
    event_id: eventId,
    event_type: readEventType(payload),
    payload,
  });

  if (error) {
    // 23505 is the unique index doing its job: we already hold this event.
    // Read as a generic failure it would be a 500, and the processor would
    // redeliver the same event forever against a row that is already there.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("processor webhook: event not recorded", error.message);
    return NextResponse.json({ error: "Could not record the event." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * HMAC-SHA256 over the exact bytes we were sent, compared in constant time.
 *
 * Hex and base64 are both accepted because they are two spellings of the same
 * digest and processors disagree about which to send; a `sha256=` prefix is
 * stripped for the same reason. If the eventual processor signs something
 * other than the bare body — a timestamped string, say — this is the one
 * function that changes.
 */
function signatureMatches(body: string, provided: string, secret: string): boolean {
  const mac = createHmac("sha256", secret).update(body, "utf8").digest();
  const offered = provided.trim().replace(/^sha256=/i, "");
  return (
    constantTimeEquals(offered.toLowerCase(), mac.toString("hex")) ||
    constantTimeEquals(offered, mac.toString("base64"))
  );
}

/**
 * Length is compared first because `timingSafeEqual` throws on a mismatch, not
 * because length is secret — both candidates are fixed-width digests.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

type Json = Record<string, unknown>;

/** Valid JSON becomes the payload; anything else is kept whole under a key. */
function parseOrKeep(raw: string): Json {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return { unparsed_body: raw };
  } catch {
    return { unparsed_body: raw };
  }
}

const firstString = (payload: Json, keys: string[]): string | null => {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
};

/**
 * The processor's own id for this delivery — the replay guard. We do not know
 * yet what they call it, so the three common spellings are tried and the
 * caller falls back to a hash of the body: an event with no id of its own is
 * still delivered twice, and a byte-identical redelivery must still be one row.
 */
const readEventId = (payload: Json): string | null =>
  firstString(payload, ["id", "event_id", "eventId"]);

/** Null when the shape is unfamiliar — an invented type would be a lie. */
const readEventType = (payload: Json): string | null =>
  firstString(payload, ["type", "event_type", "eventType"]);
