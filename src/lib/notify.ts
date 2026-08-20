import "server-only";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

/**
 * ONE MESSAGE, EVERY DOOR THAT IS OPEN.
 *
 * ============================================================================
 * WHY THIS EXISTS: THE CHANNEL THAT DECIDES MONEY HAS DELIVERED NOTHING.
 * ============================================================================
 * A2P 10DLC registration is incomplete. Twilio's own log: 81 messages sent
 * since 19 July, 0 delivered, 66 rejected as an unregistered sender. Verify
 * codes arrive — they ride Twilio's managed pool, not the 10DLC long code —
 * which is why sign-in works and why this stayed invisible for a month.
 *
 * Meanwhile SMS is the ONLY channel for things that cost people money:
 *
 *   a customer thumbs-down holds the crew's pay and starts a 24-hour clock,
 *   and the crew is told by text alone;
 *   the nightly CANCELS a fall pier removal and lift pull — a pier left in
 *   the ice — and tells the homeowner by text alone;
 *   a late-cancellation fee is charged to a card and announced by text alone.
 *
 * Every one of those call sites is `void sendSms(...)`, so the result is
 * discarded and nothing anywhere knows the message did not go. 44 of the 47
 * call sites in this app are written that way.
 *
 * ============================================================================
 * BOTH DOORS, NOT A FALLBACK — and that is a decision, not laziness.
 * ============================================================================
 * `invite-channels.ts` already settled this for park invites: "Email and text
 * go out together where both are allowed, so the link is waiting in two places
 * and either one works." A fallback would need to know that SMS failed, and
 * Twilio accepting a message tells us nothing about a carrier delivering it —
 * all 81 of those were accepted. So a message that matters goes to every door
 * that is open, and the day A2P clears, the same code sends both.
 *
 * IT LOGS ITS OWN FAILURE. Most callers discard the result, which is how this
 * became invisible in the first place, so a message that reached NOBODY says so
 * here rather than relying on somebody having remembered to check.
 *
 * WHAT IT DOES NOT DO: decide whether a person may be messaged. `sendSms`
 * refuses reserved and unroutable numbers and `sendEmail` refuses fixture
 * addresses, both before this is reached. This routes; it does not consent.
 */

export interface Recipient {
  /** E.164. Null when we hold none we may use. */
  phone?: string | null;
  email?: string | null;
}

export interface NotifyResult {
  /** True when at least one door actually took the message. */
  reached: boolean;
  bySms: boolean;
  byEmail: boolean;
  /** Set when nothing got through, in words, for a digest or a log. */
  note?: string;
}

/** Plain text into a mail body, escaped, newlines kept. */
function asHtml(body: string): string {
  const esc = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc}</div>`;
}

/**
 * Send one message to whichever of a person's doors are open.
 *
 * @param what   what this message IS, in words — "the crew that their pay is
 *               held", "the owner that their pier removal was cancelled". It
 *               goes in the log line, so a failure names the consequence rather
 *               than a template id.
 * @param to     the person. Either field may be missing.
 * @param msg    `sms` is the text body. `subject` titles the email; `body`
 *               defaults to the SMS sentence, because the same fact told twice
 *               should not become two different facts.
 */
export async function notify(
  what: string,
  to: Recipient,
  msg: { sms: string; subject: string; body?: string },
): Promise<NotifyResult> {
  const phone = (to.phone ?? "").trim() || null;
  const email = (to.email ?? "").trim() || null;

  if (!phone && !email) {
    // Not a failure to send — a person we hold no way of reaching. Different
    // fact, different fix (get an address), so it reads differently.
    const note = `No way to reach them about ${what} — no mobile and no email on file.`;
    console.warn(`[notify] ${note}`);
    return { reached: false, bySms: false, byEmail: false, note };
  }

  const body = msg.body ?? msg.sms;

  // Both at once. Neither waits on the other, and neither can throw out of
  // here — a notification must never be the thing that breaks the action that
  // triggered it.
  const [smsRes, emailRes] = await Promise.allSettled([
    phone ? sendSms(phone, msg.sms) : Promise.resolve({ queued: false }),
    email ? sendEmail({ to: email, subject: msg.subject, text: body, html: asHtml(body) })
          : Promise.resolve({ ok: false }),
  ]);

  // `queued` is the honest word: Twilio accepting it is all we know. Every one
  // of the 81 undelivered messages was accepted.
  const bySms = smsRes.status === "fulfilled" && smsRes.value?.queued === true;
  const byEmail = emailRes.status === "fulfilled" && emailRes.value?.ok !== false;

  if (!bySms && !byEmail) {
    const note =
      `Couldn't tell them about ${what} — ` +
      `${phone ? "the text didn't queue" : "no mobile on file"} and ` +
      `${email ? "the email didn't send" : "no email on file"}.`;
    console.error(`[notify] ${note}`);
    return { reached: false, bySms, byEmail, note };
  }

  // Worth a line while SMS is dead: it is the only way to watch the day it
  // starts working again without reading Twilio's console.
  if (!bySms && phone) {
    console.warn(`[notify] text didn't queue for ${what}; the email carried it.`);
  }
  return { reached: true, bySms, byEmail };
}
