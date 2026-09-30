import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { recordEmailReceipt } from "@/lib/email-receipts";

/**
 * POST /api/resend/webhook — WHERE THE MAILBOX'S VERDICT FINALLY LANDS.
 *
 * ============================================================================
 * THE SECOND TIME THIS EXACT OUTAGE.
 * ============================================================================
 * Between 19 July and 16 August 2026 this product sent 81 texts and delivered
 * none. It hid for a month because acceptance and delivery are different
 * events: Twilio took the message, the carrier rejected it seconds later, and
 * there was no route to hear the rejection. 0171 and /api/twilio/status fixed
 * that channel.
 *
 * EMAIL HAS THE SAME SHAPE AND IS CURRENTLY THE ONLY CHANNEL THAT REACHES
 * ANYBODY. `sendEmail` POSTs to api.resend.com, reads the HTTP status, and
 * records nothing whatever. A 200 from Resend means a queue accepted the
 * message. A mailbox refusing it half a minute later — a dead address, a full
 * one, a domain that greylists us — was, until this file, addressed to nobody.
 * Every ops alarm, every booking confirmation and every notice rides this door.
 *
 * ============================================================================
 * THE SIGNATURE SCHEME IS THE OPEN QUESTION, AND THIS FILE DOES NOT GUESS IT.
 * ============================================================================
 * NOTHING IN THIS REPOSITORY WRITES DOWN HOW RESEND SIGNS A WEBHOOK — not a
 * header name, not a secret format, not an event name. So this door is built
 * the way /api/processor/webhook is built, and for the same reason: the
 * processor reads its header name and secret from the environment precisely
 * because the processor was unknown when the door was written.
 *
 * A DELIVERY WE CANNOT VERIFY IS REFUSED, NOT RECORDED. An unverified webhook
 * writing into a delivery ledger is worse than having no ledger: it is a
 * stranger's power to mark a notice delivered that never was, which is a lie of
 * exactly the shape this whole package exists to end. So every unset dial, every
 * missing header and every mismatched digest is a 401 with a named log line and
 * no write at all.
 *
 * ============================================================================
 * THE DIALS. ALL OF THEM MUST BE CONFIRMED AGAINST RESEND BEFORE GO-LIVE.
 * ============================================================================
 * RESEND_WEBHOOK_SECRET            the signing secret. Unset ⇒ refuse all.
 * RESEND_WEBHOOK_SIGNATURE_HEADER  which header carries the signature. NO
 *                                  DEFAULT, on purpose: a default would be a
 *                                  guess at the scheme, and a guess that
 *                                  happened to be wrong would leave a door
 *                                  that looks configured and refuses
 *                                  everything. Unset ⇒ refuse all, and say so.
 * RESEND_WEBHOOK_SIGNED_PAYLOAD    what the digest is taken over. Defaults to
 *                                  "{body}" — the bare request body. Providers
 *                                  that sign a timestamped string set this to
 *                                  something like "{id}.{timestamp}.{body}".
 * RESEND_WEBHOOK_ID_HEADER         the header holding {id}, when used.
 * RESEND_WEBHOOK_TIMESTAMP_HEADER  the header holding {timestamp}, when used.
 *                                  Setting it also switches on the replay
 *                                  window below.
 * RESEND_WEBHOOK_SECRET_ENCODING   "raw" (default) or "base64", for schemes
 *                                  whose secret is a base64 key rather than a
 *                                  string. A leading "whsec_" is stripped
 *                                  either way.
 * RESEND_WEBHOOK_TOLERANCE_SECONDS how old a signed timestamp may be. 300.
 *
 * Hex and base64 digests are both accepted, a "sha256=" or "v1=" prefix is
 * stripped, and a header carrying SEVERAL signatures separated by spaces or
 * commas is tried candidate by candidate, because that is how providers hand
 * over a rotated key. Every comparison is constant time.
 *
 * ============================================================================
 * WHAT THIS DOOR OWES.
 * ============================================================================
 * 1. IT NEVER FAILS OPEN. No secret, no header name, no signature, a digest
 *    that does not match, or a timestamp outside the window: 401, logged,
 *    nothing written.
 * 2. IT HEARS EACH VERDICT ONCE AND NEVER HEARS ONE BACKWARDS. The rule — a
 *    receipt may advance a message, never walk it back, and a terminal message
 *    is finished — is the trigger in migration 0187, not an if-statement here.
 *    Two deliveries arriving at once would both win a check written in this
 *    file; neither can beat the trigger. A redelivered event is therefore a
 *    true no-op, not even moving the stamp.
 * 3. IT ACKNOWLEDGES ONLY WHAT IT WROTE. A 200 tells the provider to stop
 *    retrying. A write we genuinely failed to make answers 500 and asks to be
 *    told again, because a verdict acknowledged and dropped is the outage all
 *    over again.
 * 4. IT DOES NOT PRETEND TO KNOW THE VOCABULARY. The event name is normalised
 *    (lower-cased, an "email." prefix stripped) and then passed through
 *    VERBATIM as the status. An unfamiliar name lands on the row where a person
 *    can read it; 0187's rank function returns NULL for it, and the trigger
 *    treats NULL as news rather than as progress.
 * 5. IT RECORDS ARRIVAL, NOT READING. Opens and clicks are dropped without a
 *    write. This product is a courier, not a witness: whether somebody opened
 *    their mail is surveillance we have no reason to hold, and the ledger's
 *    question is whether it arrived.
 *
 * WHAT IT DOES NOT DO. It sends nothing, re-sends nothing, suppresses nothing
 * and unsubscribes nobody. A bounce is a fact to be reported; deciding what it
 * obliges us to do is a product decision nobody has made. A test scans this
 * file to keep it that way.
 */

export const dynamic = "force-dynamic";

/** An event payload is a few kilobytes. Anything past this is not one. */
const MAX_BODY_BYTES = 1_000_000;

/** How old a signed timestamp may be, when the scheme signs one at all. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/** A provider's own words for a failure, kept but not allowed to run away. */
const MAX_ERROR_TEXT = 500;

/**
 * Read, not arrived. Dropped without a write — see (5) above. Several
 * spellings because the vocabulary is unconfirmed, and the failure direction
 * matters: a spelling missing from this set lands as an ordinary status on a
 * row that is almost always already terminal, where the forward-only rule
 * refuses it anyway.
 */
const ENGAGEMENT = new Set(["opened", "open", "clicked", "click"]);

export async function GET() {
  // A webhook is a POST. GET exists only to say so plainly, rather than letting
  // a browser or a link prefetch look like a delivery.
  return NextResponse.json(
    { error: "Resend events are delivered by POST." },
    { status: 405 },
  );
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const headerName = (process.env.RESEND_WEBHOOK_SIGNATURE_HEADER ?? "").trim().toLowerCase();

  // FAIL CLOSED, BEFORE THE BODY IS READ. An unset dial means there is no
  // caller we can recognise, and "we have no lock" must never mean "come in".
  // Named in the log, because a door that silently refuses everything looks
  // exactly like a provider that never calls — the failure this package exists
  // to stop happening twice.
  if (!secret || !headerName) {
    console.warn(
      `[resend webhook] refused every delivery: ${
        !secret ? "RESEND_WEBHOOK_SECRET" : "RESEND_WEBHOOK_SIGNATURE_HEADER"
      } is not set on this server, so no caller can be verified`,
    );
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  const provided = req.headers.get(headerName) ?? "";
  if (!provided) {
    console.warn(`[resend webhook] refused a delivery carrying no ${headerName}`);
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const idHeader = (process.env.RESEND_WEBHOOK_ID_HEADER ?? "").trim().toLowerCase();
  const tsHeader = (process.env.RESEND_WEBHOOK_TIMESTAMP_HEADER ?? "").trim().toLowerCase();
  const deliveryId = idHeader ? (req.headers.get(idHeader) ?? "") : "";
  const timestamp = tsHeader ? (req.headers.get(tsHeader) ?? "") : "";

  // THE REPLAY WINDOW EXISTS ONLY WHERE THE SCHEME SIGNS A TIMESTAMP. Checking
  // a timestamp that is not part of the signed string would be theatre: anybody
  // could set it. So it is switched on by configuring the header, and off
  // otherwise.
  if (tsHeader && !withinTolerance(timestamp)) {
    console.warn(
      "[resend webhook] refused a delivery whose timestamp is missing or outside the replay window",
    );
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  if (!signatureMatches(signedPayload(raw, deliveryId, timestamp), provided, secret)) {
    // Named out loud. A door quietly discarding what fails its signature check
    // is indistinguishable from a provider that never calls.
    console.warn(`[resend webhook] refused a delivery whose ${headerName} did not match`);
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 401 });
  }

  // Past this line the delivery is authentic.
  const payload = parseObject(raw);
  if (!payload) {
    console.warn("[resend webhook] a verified delivery did not carry a JSON object");
    return NextResponse.json({ ok: true, ignored: true });
  }

  const status = normaliseStatus(readEventType(payload));
  const messageId = readMessageId(payload);

  if (!status || !messageId) {
    // Authentic, and unusable. It happened, so it is logged; a 4xx would have
    // the provider redeliver a request we will never be able to read
    // differently. A SUDDEN run of these means the payload shape moved.
    console.warn(
      `[resend webhook] a verified delivery carried no ${!status ? "event type" : "message id"}`,
    );
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (ENGAGEMENT.has(status)) {
    // Courier, not witness. No row is touched and nothing is logged about who
    // read what.
    return NextResponse.json({ ok: true, ignored: "engagement" });
  }

  // ================= THIS RESEND ACCOUNT IS NOT ONLY OURS ===================
  //
  // It is shared with BD DevCo's investor portal, and a Resend webhook is
  // ACCOUNT-WIDE: every data-room notice, NDA and K-1 fires this endpoint too.
  // On a sample of the send log, 24 of 25 messages were theirs.
  //
  // Without this branch every one of those would fall through to the
  // "we hold no receipt for" warning below — and that warning is load-bearing.
  // Its own comment says a SUDDEN RUN of them means sendEmail has stopped
  // filing its attempts, which is this outage starting again. Drowning it in
  // another company's ordinary traffic would destroy the one signal this door
  // exists to raise.
  //
  // So a verdict about somebody else's message is answered and dropped,
  // quietly. A verdict about OURS that matches no row stays loud.
  //
  // FAILING TOWARDS NOISE, deliberately: if the payload carries no sender we
  // cannot tell whose it is, so it is treated as ours and takes the noisy
  // path. A missed warning is the expensive direction here; a spurious one is
  // merely annoying.
  const sender = readSender(payload);
  if (sender && !isOurSender(sender)) {
    return NextResponse.json({ ok: true, ignored: "not ours" });
  }

  const failure = readFailure(payload);

  const receipt = await recordEmailReceipt({
    messageId,
    status,
    errorCode: failure.code,
    errorText: failure.text,
  });

  if (receipt.error) {
    // ASK TO BE TOLD AGAIN. A 200 here says the verdict is safe with us when it
    // is nowhere at all — and the verdict we would most likely lose is the one
    // saying nothing is being delivered.
    console.error(`[resend webhook] could not record the verdict on ${messageId}:`, receipt.error);
    return NextResponse.json({ error: "Could not record the receipt." }, { status: 500 });
  }

  if (!receipt.matched) {
    // No row with that id: a message sent before this table existed, a send
    // from another environment sharing the Resend account, or a verdict that
    // beat our own insert. Not an error — answering 500 would have the provider
    // redeliver for days against a row that may never exist. Worth one line,
    // because a SUDDEN run of these means sendEmail has stopped filing its
    // attempts, which is this outage starting again.
    console.warn(`[resend webhook] ${status} for ${messageId}, which we hold no receipt for`);
    return NextResponse.json({ ok: true, unknown: true });
  }

  return NextResponse.json({ ok: true });
}

/* -- verifying the caller --------------------------------------------------- */

/**
 * What the digest is taken over. Placeholders are filled by a REPLACER
 * FUNCTION, never by a replacement string: the body is attacker-influenced and
 * `String.replace` reads `$&` and friends inside a replacement string, which
 * would let a crafted body change the string we verify.
 */
function signedPayload(body: string, id: string, timestamp: string): string {
  const template = process.env.RESEND_WEBHOOK_SIGNED_PAYLOAD || "{body}";
  return template.replace(/\{(id|timestamp|body)\}/g, (_match, key: string) =>
    key === "body" ? body : key === "id" ? id : timestamp,
  );
}

/**
 * The HMAC key. A leading `whsec_` is stripped because that prefix is a label
 * on the secret rather than part of it, and the encoding dial decides whether
 * what remains is the key itself or a base64 spelling of it. Both spellings
 * exist in the wild and WHICH ONE RESEND USES IS NOT KNOWN HERE.
 */
function hmacKey(secret: string): Buffer {
  const bare = secret.trim().replace(/^whsec_/i, "");
  const encoding = (process.env.RESEND_WEBHOOK_SECRET_ENCODING || "raw").trim().toLowerCase();
  return encoding === "base64" ? Buffer.from(bare, "base64") : Buffer.from(bare, "utf8");
}

/**
 * HMAC-SHA256 over the signed payload, compared in constant time.
 *
 * Hex and base64 are both accepted because they are two spellings of one
 * digest. The header is split on whitespace and commas so a scheme that sends
 * `v1,<sig> v1,<older sig>` during a key rotation is read candidate by
 * candidate rather than failing whole.
 */
function signatureMatches(signed: string, provided: string, secret: string): boolean {
  const mac = createHmac("sha256", hmacKey(secret)).update(signed, "utf8").digest();
  const hex = mac.toString("hex");
  const b64 = mac.toString("base64");

  for (const candidate of provided.trim().split(/[\s,]+/)) {
    const offered = candidate.replace(/^(?:sha256=|v1=)/i, "");
    if (!offered) continue;
    if (constantTimeEquals(offered.toLowerCase(), hex)) return true;
    if (constantTimeEquals(offered, b64)) return true;
  }
  return false;
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

/**
 * Seconds since the epoch, or milliseconds — both are accepted, because which
 * one a scheme sends is not knowable from here and reading milliseconds as
 * seconds would refuse every genuine delivery. Missing, unparseable or outside
 * the window is false, and false means refused.
 */
function withinTolerance(value: string): boolean {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n <= 0) return false;
  const seconds = n > 1e11 ? n / 1000 : n;
  const tolerance =
    Number(process.env.RESEND_WEBHOOK_TOLERANCE_SECONDS ?? "") || DEFAULT_TOLERANCE_SECONDS;
  return Math.abs(Date.now() / 1000 - seconds) <= tolerance;
}

/* -- reading the event ------------------------------------------------------ */

type Json = Record<string, unknown>;

function parseObject(raw: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return null;
  } catch {
    return null;
  }
}

function object(source: Json, key: string): Json {
  const v = source[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function firstString(source: Json, keys: string[]): string | null {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** The event's name, from the envelope or from its data. */
const readEventType = (p: Json): string | null =>
  firstString(p, ["type", "event_type", "event"]) ??
  firstString(object(p, "data"), ["type", "event_type", "event"]);

/**
 * Lower-cased, an "email." prefix stripped, spaces and dashes folded to
 * underscores — and then PASSED THROUGH WHOLE. Nothing here maps a name onto a
 * vocabulary of our own: 0187 ranks what it recognises and treats the rest as
 * news, which is the honest handling of names we have not confirmed.
 */
function normaliseStatus(t: string | null): string | null {
  if (!t) return null;
  const s = t.trim().toLowerCase().replace(/^email[._-]/, "").replace(/[\s-]+/g, "_");
  return s || null;
}

/**
 * THE MESSAGE'S ID, NEVER THE DELIVERY'S. The envelope's own top-level `id` is
 * deliberately NOT read: on a wrapped payload that key names this delivery
 * rather than the message, and filing a verdict under it would update no row
 * while looking, from the outside, like it had worked. Missing is better than
 * wrong — a missing id is logged, and a wrong one is silence.
 */
/**
 * WHO SENT IT. Resend puts the sender on the event's data object.
 *
 * Only used to tell our traffic from the other company's on a shared account —
 * never stored, never logged. The receipt table keeps who we mailed, not who
 * anybody else did.
 */
const readSender = (p: Json): string | null =>
  firstString(object(p, "data"), ["from", "sender"]) ??
  firstString(p, ["from", "sender"]);

/**
 * OUR DOMAINS, and the sandbox we fall back to when EMAIL_FROM is unset.
 * A sandbox send is genuinely ours — it files a row with sandbox = true — so
 * it must not be mistaken for another account's traffic.
 */
const OUR_SENDERS = ["lakelife.ai", "resend.dev"];

function isOurSender(from: string): boolean {
  // "LakeLife <ops@lakelife.ai>" and a bare address both have to work.
  const at = from.lastIndexOf("@");
  if (at < 0) return false;
  const domain = from.slice(at + 1).replace(/[>\s]+$/, "").toLowerCase();
  return OUR_SENDERS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const readMessageId = (p: Json): string | null =>
  firstString(object(p, "data"), ["email_id", "message_id", "id"]) ??
  firstString(p, ["email_id", "message_id"]);

/**
 * The reason, in the provider's own words and codes. Several shapes are tried
 * because the payload is unconfirmed; all of them may come back null, and a
 * failure with no reason is still recorded as a failure — that is worse to read
 * than any known code, and it should read worse.
 */
function readFailure(p: Json): { code: string | null; text: string | null } {
  const data = object(p, "data");
  const bounce = object(data, "bounce");
  const error = object(data, "error");

  const code =
    firstString(bounce, ["subType", "sub_type", "type", "code"]) ??
    firstString(error, ["code", "name", "type"]) ??
    firstString(data, ["error_code", "code"]);

  const text =
    firstString(bounce, ["message", "description", "reason"]) ??
    firstString(error, ["message", "description"]) ??
    firstString(data, ["error_message", "reason"]);

  return { code, text: text ? text.slice(0, MAX_ERROR_TEXT) : null };
}
