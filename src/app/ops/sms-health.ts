import "server-only";
import twilio from "twilio";
import { hasTwilioEnv } from "@/lib/env";
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
 * READ STRAIGHT FROM TWILIO, WITH NO TABLE OF OUR OWN.
 *
 * Delivery status is decided by the carrier, arrives asynchronously, and is
 * already recorded — by Twilio, accurately, for free. Mirroring it into a
 * local table would mean a writer, a reconciler and a way to drift, to end up
 * with a worse copy of a log that already exists. The ops console is low
 * traffic and this is the one screen where the truth matters more than the
 * round trip.
 */

export interface SmsHealth {
  configured: boolean;
  /** Null when we could not ask — never zero, which would read as "all fine". */
  window: { sent: number; delivered: number; failed: number } | null;
  /** Worst first: [plain english, count]. */
  reasons: { text: string; count: number; code: string }[];
  oldest: string | null;
  newest: string | null;
  error?: string;
}

export async function getSmsHealth(): Promise<SmsHealth> {
  if (!hasTwilioEnv()) {
    return { configured: false, window: null, reasons: [], oldest: null, newest: null };
  }

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const msgs = await client.messages.list({ limit: 200 });

    let delivered = 0;
    let failed = 0;
    const byCode = new Map<string, number>();
    let oldest: string | null = null;
    let newest: string | null = null;

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
    };
  } catch (e) {
    // NOT SILENTLY HEALTHY. A failed lookup returns a null window, which the
    // panel renders as "we couldn't check" — the one thing it must never do is
    // look like a clean bill of health.
    const error = e instanceof Error ? e.message : "could not reach Twilio";
    console.error("[ops] sms health lookup failed", error);
    return { configured: true, window: null, reasons: [], oldest: null, newest: null, error };
  }
}
