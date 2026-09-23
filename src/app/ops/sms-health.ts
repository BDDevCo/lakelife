import "server-only";
import twilio from "twilio";
import { hasTwilioAccount } from "@/lib/env";
import { smsErrorText } from "@/lib/sms-errors";

/**
 * DID ANY OF IT ARRIVE?
 *
 * On 16 Aug 2026 the answer was no, and had been no since 19 July: 81 messages
 * sent, ZERO delivered. Booking confirmations, crew dispatch, Autopilot
 * reminders, a crew reporting pier damage — every one accepted by Twilio,
 * every one dropped by the carrier, and nothing in this product knew.
 *
 * It stayed invisible because 44 of the 47 `sendSms` call sites are
 * fire-and-forget. Nobody was going to notice by reading a return value, so
 * the fix is not a better return value: it is a place where the question gets
 * asked out loud.
 *
 * ---------------------------------------------------------------------------
 * READ STRAIGHT FROM TWILIO, ALONGSIDE OUR OWN RECORD.
 *
 * Since 0171 every accepted message leaves a receipt row (`sms_receipts`) and
 * /api/twilio/status writes the carrier's verdict onto it, which is what the
 * nightly digest counts. This panel deliberately does NOT read that table: it
 * asks Twilio, so the two answers are independent and a bug in our own writer
 * cannot make this screen agree with itself. Delivery status is decided by the
 * carrier and already recorded by Twilio, accurately, for free; the ops console
 * is low traffic and this is the one screen where the truth matters more than
 * the round trip.
 */

/** How far back the window reaches: the newest 200 messages in Twilio's log. */
export const LOG_WINDOW = 200;

/** The most recent attempt, and what came back on it. */
export interface LastAttempt {
  /** ISO, or null when Twilio gave no timestamp. */
  at: string | null;
  /** Twilio's own word: queued, sent, delivered, undelivered, failed. */
  status: string;
  /** The rejection code, when there is one. */
  errorCode: string | null;
  /** That code in plain English, from lib/sms-errors — the one copy. */
  errorText: string | null;
}

export interface SmsHealth {
  configured: boolean;
  /** Null when we could not ask — never zero, which would read as "all fine". */
  window: { sent: number; delivered: number; failed: number } | null;
  /** Worst first: [plain english, count]. */
  reasons: { text: string; count: number; code: string }[];
  oldest: string | null;
  newest: string | null;
  /**
   * The newest message in the window. Null when the log is empty OR when we
   * could not ask — `window` is what tells those two apart, and every screen
   * that renders this must consult it.
   */
  lastAttempt: LastAttempt | null;
  error?: string;
}

/**
 * WHICH OF THE FIVE WORLDS THIS LOG IS DESCRIBING.
 *
 * "Has a text reached a handset?" has five answers and only one of them is no.
 * The delivery panel knew that and branched on all of them, in words. The
 * go-live checklist at the foot of the SAME PAGE collapsed them to a boolean —
 * `Boolean(log.window && log.window.delivered > 0)` — and its false arm then
 * asserted "Twilio's log shows nothing delivered in the window above", which
 * is a statement about a log we may never have read. It bites on exactly the
 * occasion the page exists for: the reload right after the Messaging Service
 * SID is set, when Twilio happening to be unreachable would send him back to
 * Vercel to fix a setting that was never wrong.
 *
 * So the branch lives here, once, and both halves of the page read it. Each
 * renderer keeps its own prose — this decides only WHICH world they are in, so
 * they cannot disagree about that again.
 */
export type DeliveryVerdict =
  /** No credentials on this server, so nobody looked. Not a no. */
  | { state: "unasked" }
  /** We asked and the lookup failed. Also not a no. */
  | { state: "unreadable" }
  /** We read the log and it holds no messages at all. "Nothing was sent." */
  | { state: "nothing-sent" }
  /** Messages went to the carriers and not one came back delivered. */
  | { state: "none-delivered"; sent: number; delivered: number }
  /** At least one message reached a handset. The only yes. */
  | { state: "delivered"; sent: number; delivered: number };

export function deliveryVerdict(log: SmsHealth): DeliveryVerdict {
  if (!log.configured) return { state: "unasked" };
  // Null window is "we could not ask" by this module's own contract — never
  // zero, which is why it can never be read as a clean sheet.
  if (!log.window) return { state: "unreadable" };
  const { sent, delivered } = log.window;
  if (sent === 0) return { state: "nothing-sent" };
  return { state: delivered > 0 ? "delivered" : "none-delivered", sent, delivered };
}

export async function getSmsHealth(): Promise<SmsHealth> {
  // THE ACCOUNT, NOT THE VERIFY SERVICE. This gate used to be `hasTwilioEnv()`,
  // which answered on the VERIFY service SID — so a delivery panel about the
  // MESSAGING channel was switched on and off by a credential belonging to a
  // different transport. That conflation is the one that hid the outage; see
  // lib/env.ts. Reading the message log needs the account and nothing else.
  if (!hasTwilioAccount()) {
    return { configured: false, window: null, reasons: [], oldest: null, newest: null, lastAttempt: null };
  }

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const msgs = await client.messages.list({ limit: LOG_WINDOW });

    let delivered = 0;
    let failed = 0;
    const byCode = new Map<string, number>();
    let oldest: string | null = null;
    let newest: string | null = null;
    // THE LAST ONE WE TRIED, kept as we go rather than taken from msgs[0].
    // Twilio returns newest-first today; relying on that would make "when did
    // we last text anybody, and what came back" quietly wrong the day the list
    // order changes. The timestamp already being computed decides it instead.
    let lastAttempt: LastAttempt | null = null;
    // A message with no timestamp at all must still be able to be the last
    // one, when it is the only one — hence the separate flag.
    let haveAttempt = false;

    for (const m of msgs) {
      const status = String(m.status ?? "");
      if (status === "delivered") delivered++;
      else if (status === "failed" || status === "undelivered") {
        failed++;
        const code = String(m.errorCode ?? "unknown");
        byCode.set(code, (byCode.get(code) ?? 0) + 1);
      }
      const when = (m.dateSent ?? m.dateCreated)?.toISOString?.() ?? null;
      if (when) {
        if (!oldest || when < oldest) oldest = when;
        if (!newest || when > newest) newest = when;
      }
      if (!haveAttempt || (when && (!lastAttempt?.at || when > lastAttempt.at))) {
        const code = m.errorCode == null ? null : String(m.errorCode);
        lastAttempt = {
          at: when,
          // Never blank: a status Twilio did not give us is still a fact about
          // the attempt, and "" on an ops screen reads as nothing happened.
          status: status || "unknown",
          errorCode: code,
          errorText: code === null ? null : smsErrorText(code),
        };
        haveAttempt = true;
      }
    }

    return {
      configured: true,
      window: { sent: msgs.length, delivered, failed },
      reasons: [...byCode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([code, count]) => ({ code, count, text: smsErrorText(code) })),
      oldest,
      newest,
      lastAttempt,
    };
  } catch (e) {
    // NOT SILENTLY HEALTHY. A failed lookup returns a null window, which the
    // panel renders as "we couldn't check" — the one thing it must never do is
    // look like a clean bill of health.
    const error = e instanceof Error ? e.message : "could not reach Twilio";
    console.error("[ops] sms health lookup failed", error);
    return { configured: true, window: null, reasons: [], oldest: null, newest: null, lastAttempt: null, error };
  }
}
