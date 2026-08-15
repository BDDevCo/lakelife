import twilio from "twilio";
import { phoneRefusal } from "@/lib/contactable";

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
export async function sendSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
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
    return { ok: false, error: `unsendable recipient (${refusal.code})` };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) return { ok: false, error: "SMS not configured" };

  try {
    const client = twilio(sid, token);
    await client.messages.create({ from, to, body });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
