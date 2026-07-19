import "server-only";

/**
 * Send a transactional email via Resend (welcome recap, booking confirmations,
 * etc.). Mirrors the shape of sendSms in ./sms.ts.
 *
 * SERVER ONLY.
 *
 * Best-effort: returns {ok:false} instead of throwing so a booking or wizard
 * never fails just because an email couldn't send. No-ops gracefully when
 * Resend isn't configured (missing RESEND_API_KEY) or there's no recipient.
 *
 * Note: until the sending domain (lakelife.ai) is verified in Resend, this
 * sends from Resend's shared onboarding@resend.dev address, which only delivers
 * to the Resend account owner's own email in test mode. Verify the domain
 * before real beta.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !opts.to) return { ok: false, error: "email not configured" };

  const from = opts.from ?? "LakeLife <onboarding@resend.dev>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.text ? { text: opts.text } : {}),
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
