import twilio from "twilio";
import { phoneRefusal } from "@/lib/contactable";
import { recipientIsFixture } from "@/lib/recipient-gate";
import { recipientIsHeld, holdRefusal } from "@/lib/notice-hold";

/**
 * Send an alert SMS via Twilio Messaging (booking confirmations, reminders,
 * "crew complete", etc.) — distinct from the Verify OTP flow.
 *
 * Best-effort: returns {ok:false} instead of throwing so a booking never fails
 * just because a text couldn't send. On a Twilio TRIAL account, messages only
 * deliver to verified numbers — upgrade the Twilio account before real beta.
 *
 * SERVER ONLY.
 */
/**
 * THIS RETURNS `queued`, NOT `ok`, AND THE NAME IS THE WHOLE POINT.
 *
 * It used to return `{ ok: true }` the moment Twilio accepted the message.
 * Acceptance is not delivery: the carrier decides seconds later, out of band,
 * and nothing in this app ever looked. On 16 Aug 2026 the Twilio log said 81
 * messages sent since July and ZERO delivered — 66 of them rejected with error
 * 30034, an unregistered A2P 10DLC sender. Booking confirmations, crew
 * dispatch, Autopilot reminders, a crew reporting pier damage. All accepted,
 * none delivered, for a month, silently.
 *
 * `ok` was the word that hid it. A caller reading `ok` reasonably believes the
 * person got the message. `queued` cannot be misread that way: it says the
 * message is with the carrier and says nothing about arrival.
 *
 * NOTHING HERE CAN TELL YOU IT ARRIVED. Delivery truth lives in Twilio's own
 * message log, which is what the ops SMS-health panel reads — see
 * src/app/ops/sms-health.ts. Do not add a "delivered" boolean to this function;
 * it would have to lie.
 */
export async function sendSms(
  to: string,
  body: string,
): Promise<{ queued: boolean; error?: string; sid?: string; status?: string }> {
  // THE RECIPIENT GATE, AND IT COMES FIRST — before the credentials check.
  //
  // "We must not contact this person" is true whether or not Twilio happens to
  // be configured, so it does not belong behind a configuration test. Putting
  // it first also means the rule is exercised by the test suite with no
  // credentials present, which is the only way to prove a refusal without
  // risking a real send to prove it.
  //
  // This door has no sandbox behind it. Email has been quietly protected by an
  // unset EMAIL_FROM; every text this app has ever attempted went straight at
  // Twilio. All five fixture accounts in production carry 555 numbers — one of
  // them directory assistance — so this is the door that could actually have
  // rung a stranger about work at a lake house they have never heard of.
  const refusal = phoneRefusal(to);
  if (refusal) {
    console.warn(`[sms] refused: ${refusal.why}`);
    return { queued: false, error: `unsendable recipient (${refusal.code})` };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  // ONCE A2P REGISTRATION CLEARS, THE SENDER IS A SERVICE, NOT A NUMBER.
  //
  // A registered campaign is attached to a Messaging Service, and carriers
  // route on THAT — sending from the bare number keeps the traffic
  // unregistered no matter how green the console looks. So the day the brand
  // is approved this becomes a one-line environment change with no deploy:
  // set TWILIO_MESSAGING_SERVICE_SID and the send switches over.
  //
  // Until it is set, nothing changes — the number is still used, and the
  // product behaves exactly as it does today.
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || (!from && !serviceSid)) return { queued: false, error: "SMS not configured" };

  // AND THE SECOND GATE: a fixture holding a plausible number (0126). Placed
  // after the configuration check on purpose — it costs a database round trip,
  // and there is nothing to protect anybody from when the transport is absent.
  if (await recipientIsFixture("phone", to)) {
    console.warn(`[sms] refused: ${to} belongs to an account marked not-a-person`);
    return { queued: false, error: "unsendable recipient (fixture)" };
  }

  // AND THE THIRD: a park that has not said it is ready. Both of this park's
  // phone columns are checked — the verified mobile AND the number the office
  // wrote down — because a hold that covered only the first would let a text
  // reach exactly the people who never asked to be texted. Fails CLOSED; see
  // notice-hold.ts.
  const hold = await recipientIsHeld("phone", to);
  if (hold.held) {
    console.warn(`[sms] held: ${to} — ${hold.failed ? "could not check" : "park is holding notices"}`);
    return { queued: false, error: holdRefusal(hold) };
  }

  try {
    const client = twilio(sid, token);
    // messagingServiceSid and from are mutually exclusive at the API: sending
    // both is an error, so the service wins when it is configured.
    const msg = await client.messages.create(
      serviceSid
        ? { messagingServiceSid: serviceSid, to, body }
        : { from: from as string, to, body },
    );

    // Some failures are known immediately — a blocked or unroutable number
    // comes back already final. Those are not queued by any honest reading, so
    // they are reported as failures rather than as hopeful silence.
    if (msg.status === "failed" || msg.status === "undelivered") {
      console.error(`[sms] ${to} rejected at once: ${msg.status} ${msg.errorCode ?? ""}`);
      return {
        queued: false,
        error: `${msg.status}${msg.errorCode ? ` (${msg.errorCode})` : ""}`,
        sid: msg.sid,
        status: msg.status,
      };
    }
    return { queued: true, sid: msg.sid, status: msg.status };
  } catch (e) {
    return { queued: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
