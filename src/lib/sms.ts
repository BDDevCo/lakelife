import twilio from "twilio";
import { phoneRefusal } from "@/lib/contactable";
import { recipientIsFixture } from "@/lib/recipient-gate";
import { recipientIsHeld, holdRefusal } from "@/lib/notice-hold";
import { recordSmsAttempt, statusCallbackUrl } from "@/lib/sms-receipts";

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
 * NOTHING HERE CAN TELL YOU IT ARRIVED, AND THAT IS NOT A GAP ANY RETURN VALUE
 * CAN FILL. Arrival is decided by the carrier seconds later, after this
 * function has returned; a "delivered" boolean here would have to lie. What
 * this function now does instead is make the answer FINDABLE: it files a
 * receipt row (0171, lib/sms-receipts) and tells Twilio where to post the
 * verdict (/api/twilio/status), so the carrier's answer lands somewhere and
 * the nightly digest can say out loud how many texts reached a handset. The
 * ops SMS-health panel still reads Twilio's own log directly — two sources for
 * the same fact, deliberately, since one of them is ours to get wrong.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE RETURN IS UNCHANGED, ONLY WIDENED.
 *
 * Forty-seven call sites take `{ queued, error?, sid?, status? }` and 44 of
 * them discard it entirely. `recorded` is added alongside — true when the
 * attempt was filed, false when the row could not be written — so a caller
 * that never looks is untouched, and nothing that reads `queued` reads
 * differently than it did yesterday.
 */
export async function sendSms(
  to: string,
  body: string,
  /**
   * What this message is and who it is about, for the receipt row. Optional so
   * every existing call site still compiles: a send with no label is filed as
   * "unlabelled", which is worse to read in a week of failures than "freeze
   * warning" but is not a reason to hold up the record.
   */
  about?: { kind?: string; parkId?: string | null; lakeId?: string | null },
): Promise<{ queued: boolean; error?: string; sid?: string; status?: string; recorded?: boolean }> {
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
  // THE CAMPAIGN IS APPROVED. THIS LINE IS STILL WAITING ON THE ENV VAR.
  //
  // A2P 10DLC cleared on 22 Sep 2026, and by itself it delivered nothing. A
  // registered campaign is attached to a Messaging Service, and carriers route
  // on THAT — sending from the bare number keeps the traffic unregistered no
  // matter how green the console looks. So the approval turned this into a
  // one-line environment change with no deploy, and that change has not been
  // made: set TWILIO_MESSAGING_SERVICE_SID in Vercel and the send switches
  // over. See docs/a2p-registration.md.
  //
  // Until it is set, nothing changes — the number is still used, the traffic
  // is still unregistered, and the product behaves exactly as it does today.
  // No copy anywhere may promise a text until one has actually been
  // delivered and a receipt row (0171) can prove it.
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
    // WHERE TO SEND THE VERDICT. Null on a developer's machine and on any
    // environment without a real https origin, and then it is simply left off:
    // Twilio validates this URL as it accepts the message and refuses an
    // unroutable one (21609), so passing a localhost callback would stop the
    // message sending altogether — a change made to watch delivery causing an
    // outage of its own. See statusCallbackUrl in lib/sms-receipts.
    const statusCallback = statusCallbackUrl();
    // messagingServiceSid and from are mutually exclusive at the API: sending
    // both is an error, so the service wins when it is configured.
    const msg = await client.messages.create({
      ...(serviceSid ? { messagingServiceSid: serviceSid } : { from: from as string }),
      to,
      body,
      ...(statusCallback ? { statusCallback } : {}),
    });

    // THE RECEIPT IS FILED FOR WHAT FAILED AS WELL AS FOR WHAT FLEW. A table
    // holding only the hopeful half of the story would report a perfect
    // delivery rate on a night when every message was refused at the door.
    //
    // Awaited, not fired and forgotten: a `void` here is the exact habit that
    // let 44 call sites lose the result of the send itself. It is one insert
    // against a table with a single index, and the send has already happened —
    // nothing the caller does depends on how fast this returns.
    const { recorded } = await recordSmsAttempt({
      sid: msg.sid,
      to,
      kind: about?.kind ?? null,
      parkId: about?.parkId ?? null,
      lakeId: about?.lakeId ?? null,
      body,
      acceptedStatus: msg.status,
    });

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
        recorded,
      };
    }
    return { queued: true, sid: msg.sid, status: msg.status, recorded };
  } catch (e) {
    // NO SID, SO NOTHING TO FILE IT UNDER. A create that threw never got an
    // id from Twilio and may never have reached them at all; inventing a key
    // for it would put a row in the receipts table that no callback can ever
    // answer, and that row would count against the delivery rate for ever.
    return { queued: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
