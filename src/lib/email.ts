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
 * Sender resolution: explicit opts.from wins, else EMAIL_FROM env (set this to
 * "LakeLife <noreply@lakelife.ai>" once the domain is verified in Resend), else
 * Resend's shared onboarding@resend.dev (test mode — only delivers to the Resend
 * account owner). So flipping every app email to the branded domain is a single
 * env var, no code change.
 */
/**
 * Resend's shared sandbox sender. It only ever delivers to the Resend account
 * owner, which has quietly been doing a job nobody assigned it: every email
 * this app has sent to a scratch address bounced off it harmlessly.
 *
 * THAT SAFETY IS AN ACCIDENT AND IT ENDS WITHOUT A DEPLOY. `EMAIL_FROM` is
 * absent from .env.local and sitting ready in .env.local.example. Setting that
 * one variable in Vercel is a legitimate, expected step — and the moment it
 * lands, every send in the codebase starts reaching real inboxes, with no code
 * change, no migration and nothing on screen to mark the transition.
 *
 * So the fallback says so. Not an error — using the sandbox is correct today,
 * and refusing to send would break the app for a configuration that is right.
 * Just no longer INVISIBLE: whoever reads the logs before flipping it can see
 * which state they are in, and the log line names the switch.
 *
 * The real protection for the other side of that switch is a recipient gate —
 * something that knows a scratch address from a customer's. That is its own
 * piece of work with its own question ("what proves a recipient is real?") and
 * this comment is not a substitute for it.
 */
const SANDBOX_FROM = "LakeLife <onboarding@resend.dev>";

let warnedSandbox = false;
function warnSandboxSender() {
  if (warnedSandbox) return; // once per process, not once per email
  warnedSandbox = true;
  console.warn(
    "[email] EMAIL_FROM is unset — sending as Resend's sandbox address, which " +
    "only delivers to the Resend account owner. Set EMAIL_FROM (see " +
    ".env.local.example) to send from lakelife.ai. Doing so makes every send " +
    "in this app reach its real recipient.",
  );
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !opts.to) return { ok: false, error: "email not configured" };

  const from = opts.from ?? process.env.EMAIL_FROM ?? SANDBOX_FROM;
  if (from === SANDBOX_FROM) warnSandboxSender();

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
