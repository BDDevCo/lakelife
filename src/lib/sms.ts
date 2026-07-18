import twilio from "twilio";

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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from || !to) return { ok: false, error: "SMS not configured" };

  try {
    const client = twilio(sid, token);
    await client.messages.create({ from, to, body });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
