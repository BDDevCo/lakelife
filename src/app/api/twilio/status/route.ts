import { NextResponse } from "next/server";
import twilio from "twilio";
import { recordSmsReceipt, statusCallbackUrl } from "@/lib/sms-receipts";

/**
 * POST /api/twilio/status — WHERE THE CARRIER'S VERDICT FINALLY LANDS.
 *
 * ============================================================================
 * THE MESSAGE NOBODY WAS LISTENING FOR.
 * ============================================================================
 * Twilio has always sent this. Whenever a message changes state — queued,
 * sent, delivered, or the two that matter, undelivered and failed — it POSTs
 * the news to the URL given as `StatusCallback` when the message was created.
 * This app never gave it one and never had a route to give, so between 19 July
 * and 16 August 2026 eighty-one carrier rejections were addressed to nowhere.
 * Sixty-six of them said 30034: the sending number was not registered for A2P
 * 10DLC. Every one of those messages was recorded by this product as sent.
 *
 * This is the other half of the fix. Registration makes the texts deliverable;
 * this file makes the next failure *audible*.
 *
 * ============================================================================
 * WHY THIS PATH.
 * ============================================================================
 * `/api/twilio/status` names the sender and then the thing being reported, so
 * the inbound-message webhook this product will eventually need (a resident
 * replying STOP is a consent event we are obliged to honour) is a sibling at
 * `/api/twilio/inbound` rather than a second scheme. `/api/` is already in
 * robots.ts's disallow list, so it needs no entry of its own, and there is no
 * middleware in this app — nothing sits in front of this route to turn
 * Twilio's POST into a sign-in redirect.
 *
 * ============================================================================
 * FOUR THINGS THIS DOOR OWES.
 * ============================================================================
 * 1. IT ANSWERS ONLY TO TWILIO. Every Twilio webhook carries
 *    `X-Twilio-Signature`, an HMAC over the exact URL plus every POST
 *    parameter, keyed with the account's auth token. Unsigned, wrongly signed,
 *    or signed for a different URL: 403, logged, nothing written. Without that
 *    check this endpoint is a public write that could mark a text delivered
 *    that never was — a lie of exactly the shape this whole package exists to
 *    end. Twilio's own documentation is emphatic that the SDK's validator
 *    should be used rather than a hand-rolled one, because the parameter set
 *    is not fixed and they add to it without notice, so the SDK's
 *    `validateRequest` is what runs here.
 *      Webhooks security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *      Status callback parameters (MessageStatus, ErrorCode, and the warning
 *      that properties change): https://www.twilio.com/docs/messaging/api/message-resource
 *
 * 2. IT VALIDATES AGAINST THE URL WE ASKED FOR, NOT THE ONE IN THE REQUEST.
 *    The signature covers the URL Twilio called, and that is the URL we handed
 *    it — `statusCallbackUrl()`, built from the same site origin as every other
 *    link this app mints. Rebuilding the URL from the request's own Host and
 *    protocol headers would mean a caller behind a proxy could choose the
 *    string we hash and sign one to match. So the URL comes from our own
 *    configuration and a mismatch simply fails.
 *
 * 3. IT HEARS EACH RECEIPT ONCE, AND NEVER HEARS ONE BACKWARDS. Twilio sends
 *    several callbacks per message and redelivers any it thinks we missed, so
 *    duplicates and out-of-order arrivals are ordinary. The rule — a receipt
 *    may advance a message, never walk it back, and a terminal message is
 *    finished — is the trigger in migration 0171, not an if-statement here.
 *    Two callbacks arriving at once would both win a check written in this
 *    file; neither can beat the trigger.
 *
 * 4. IT ANSWERS 200 AND IT ANSWERS FAST. A non-200 makes Twilio retry, and a
 *    retry storm over a receipt we already hold is noise. The one exception is
 *    a write we genuinely failed to make: that answers 500 and asks to be told
 *    again, because a receipt acknowledged and dropped is the outage all over.
 *
 * WHAT IT DOES NOT DO. It sends nothing, charges nothing, cancels nothing and
 * re-sends nothing. A failed text is a fact to be reported — the nightly
 * digest does that — and deciding what to do about one is a product decision
 * nobody has made. A test scans this file to keep it that way.
 */

export const dynamic = "force-dynamic";

/** Twilio's header. Lower-cased because `Headers.get` is case-insensitive. */
const SIGNATURE_HEADER = "x-twilio-signature";

/** A status callback is a few hundred bytes of form data. Nothing near this. */
const MAX_BODY_BYTES = 100_000;

export async function GET() {
  // A status callback is a POST. GET exists to say so plainly rather than let
  // a browser or a link prefetch look like a delivery.
  return NextResponse.json(
    { error: "Twilio status callbacks are delivered by POST." },
    { status: 405 },
  );
}

export async function POST(req: Request) {
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const url = statusCallbackUrl();
  const signature = req.headers.get(SIGNATURE_HEADER) ?? "";

  // FAIL CLOSED, BEFORE THE BODY IS READ.
  //
  // No auth token means no lock, and "we have no lock" must never mean "come
  // in". No callback URL means we never asked anyone to call — `sendSms` only
  // passes `statusCallback` when the site has a real https origin — so a POST
  // arriving here is not a receipt for anything we sent. Both are our own
  // configuration problem and neither is the caller's business, so both get
  // the same flat refusal.
  if (!token || !url || !signature) {
    console.warn(
      `[twilio status] refused an unsigned or unexpected callback (${
        !signature ? "no signature header" : !token ? "no auth token configured" : "no callback URL configured"
      })`,
    );
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 403 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  // Twilio posts status callbacks as form data. Anything else is a shape we
  // never asked for and cannot validate the same way (a JSON webhook is signed
  // over a `bodySHA256` query parameter instead), so it is refused rather than
  // guessed at.
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    console.warn(`[twilio status] refused a callback sent as ${contentType || "no content type"}`);
    return NextResponse.json({ error: "Expected form-encoded parameters." }, { status: 415 });
  }

  // EVERY PARAMETER, NOT A CHOSEN FEW. The signature covers all of them and
  // Twilio adds new ones without notice; validating a hand-picked subset would
  // start failing on a Tuesday for no reason anybody could see.
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) params[key] = value;

  if (!twilio.validateRequest(token, signature, url, params)) {
    // Named out loud. An endpoint quietly discarding requests that fail their
    // signature check is how a misconfigured callback URL looks exactly like a
    // carrier that never answers.
    console.warn(`[twilio status] refused a callback whose signature did not match ${url}`);
    return NextResponse.json({ error: "Unrecognised caller." }, { status: 403 });
  }

  const sid = (params.MessageSid ?? params.SmsSid ?? "").trim();
  const status = (params.MessageStatus ?? params.SmsStatus ?? "").trim();
  if (!sid || !status) {
    // Authentic, and unusable. It happened, so it is logged; a 4xx would have
    // Twilio redeliver a request we will never be able to read differently.
    console.warn(
      `[twilio status] a signed callback carried no ${!sid ? "MessageSid" : "MessageStatus"}`,
    );
    return NextResponse.json({ ok: true, ignored: true });
  }

  const receipt = await recordSmsReceipt({
    sid,
    status,
    errorCode: params.ErrorCode ?? null,
  });

  if (receipt.error) {
    // ASK TO BE TOLD AGAIN. A 200 here says the verdict is safe with us when it
    // is nowhere at all — and the verdict we would most likely lose is the one
    // that says nothing is being delivered.
    console.error(`[twilio status] could not record the verdict on ${sid}:`, receipt.error);
    return NextResponse.json({ error: "Could not record the receipt." }, { status: 500 });
  }

  if (!receipt.matched) {
    // No row with that SID. A Verify code (those ride a different service and
    // are never filed here), a message sent before this table existed, or
    // another environment sharing the Twilio account. Not an error: answering
    // 500 would have Twilio redeliver for days against a row that will never
    // exist. Worth one line, because a SUDDEN run of these means sendSms has
    // stopped filing its attempts.
    console.warn(`[twilio status] ${status} for ${sid}, which we hold no receipt for`);
    return NextResponse.json({ ok: true, unknown: true });
  }

  return NextResponse.json({ ok: true });
}
