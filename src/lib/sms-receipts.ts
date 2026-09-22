import "server-only";
import { createHash } from "node:crypto";
import { siteUrl } from "@/lib/env";
import { smsErrorText } from "@/lib/sms-errors";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * THE RECORD OF EVERY TEXT WE ASKED A CARRIER TO DELIVER.
 *
 * ============================================================================
 * WHY THIS EXISTS: EIGHTY-ONE MESSAGES, ZERO ARRIVALS, NOTHING KNEW.
 * ============================================================================
 * Between 19 July and 16 August 2026 this product sent 81 texts and delivered
 * none of them. Sixty-six were rejected by the carriers with error 30034 — an
 * unregistered A2P 10DLC sender — and fifteen with 21268. Booking
 * confirmations, crew dispatch, Autopilot reminders, a crew reporting pier
 * damage: every one accepted by Twilio, every one dropped, for a month.
 *
 * It hid because ACCEPTANCE AND DELIVERY ARE DIFFERENT EVENTS, SECONDS APART.
 * `sendSms` returns the moment Twilio takes the message. The carrier's verdict
 * arrives later, out of band, on a status callback — and this app had no
 * callback route, no record and no surface, so the verdict was addressed to
 * nobody. Twilio's own console held the truth the whole time; a product that
 * can only learn it by a person opening somebody else's website has not
 * learned it.
 *
 * (Verify codes were never affected — they ride Twilio's managed pool rather
 * than the 10DLC long code — which is why sign-in worked all month and why
 * nobody had a reason to look.)
 *
 * ============================================================================
 * WHAT THIS RECORDS, AND WHAT IT REFUSES TO RECORD.
 * ============================================================================
 * A row per message Twilio accepted: the SID, the destination, what kind of
 * message it was, the park or lake it belongs to, and then the carrier's
 * verdict as it arrives.
 *
 * NOT THE BODY, AND NOT A NAME. Only its LENGTH and a SHA-256 of it. The
 * question this table exists to answer is "did it arrive", which needs no
 * words; the length and the hash are enough to prove two rows are the same
 * message, or that the message a crew swears they never got was in fact the
 * one we sent. Keeping the text would make an unremarkable operations table
 * into a store of what residents were told about their homes and their rent,
 * and the reason to hold that has never been given.
 *
 * ============================================================================
 * THIS IS A RECORD OF ATTEMPTS, NOT OF INTENTIONS.
 * ============================================================================
 * A message refused by our own gates — a reserved number, a fixture account, a
 * park holding its notices — never reaches a carrier and gets NO row. That is
 * a different fact with a different fix, it is logged where it happens, and
 * counting refusals as attempts would sink the delivery rate this table exists
 * to watch. Likewise a create that throws has no SID, so there is nothing to
 * file it under; it returns an error to the caller and says so in the log.
 */

/** The one spelling of the table name, so a typo is a compile error somewhere. */
export const SMS_RECEIPTS = "sms_receipts";

/** Where Twilio is told to send its verdict. Matches the route's own path. */
export const STATUS_CALLBACK_PATH = "/api/twilio/status";

/**
 * Twilio's own terminal statuses. Past one of these the carrier has finished
 * with the message and nothing later can change what happened.
 */
const TERMINAL = new Set(["delivered", "undelivered", "failed", "canceled"]);

/** Arrived on a handset. The only status that means the person got it. */
const ARRIVED = "delivered";

/**
 * The public URL Twilio should call back, or null when there isn't one.
 *
 * NULL IS NOT A FAILURE, AND IT MUST NOT BE SENT AS ONE. Twilio validates the
 * StatusCallback when it accepts the message and refuses an unroutable one
 * (error 21609), so passing `http://localhost:3000/...` from a developer's
 * machine or a preview build would make the CREATE fail — every text stops
 * sending, and a change made to watch delivery would have caused an outage of
 * its own. So the callback is asked for only when the site origin is a real
 * https origin, and a local run simply sends as it always has, with the row
 * written and its status left at whatever Twilio said on acceptance.
 *
 * Built from `siteUrl()` — the same origin helper the booking links and the
 * auth redirects use — never a literal, so a second domain moves this too.
 */
export function statusCallbackUrl(): string | null {
  const origin = siteUrl().trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(origin)) return null;
  // A https URL can still name a machine only this laptop can reach.
  if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/i.test(origin)) return null;
  return `${origin}${STATUS_CALLBACK_PATH}`;
}

/**
 * The length and the digest of a body, which is all we keep of it.
 *
 * Hex SHA-256 over the UTF-8 bytes. `length` is the JavaScript string length
 * rather than a segment count: segments depend on the alphabet and on Twilio's
 * own encoding decision, and a number we compute differently from the invoice
 * would be a number two screens disagree about.
 */
export function fingerprintBody(body: string): { length: number; sha256: string } {
  return {
    length: body.length,
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
}

export interface SmsAttempt {
  /** Twilio's message SID. The row's identity and the callback's only key. */
  sid: string;
  /** Destination, E.164. */
  to: string;
  /**
   * What kind of message this is, in the caller's words — "booking
   * confirmation", "crew dispatch", "freeze warning". It exists so a person
   * reading a week of failures can see WHICH promises went unkept, not just
   * how many.
   */
  kind?: string | null;
  parkId?: string | null;
  lakeId?: string | null;
  /** Fingerprinted here and then dropped. Never stored. */
  body: string;
  /** The status Twilio returned when it accepted the message. */
  acceptedStatus?: string | null;
}

/**
 * File an accepted message. Best-effort, like every other step in a send:
 * a booking must not fail because its receipt row didn't save.
 *
 * IT REPORTS ITS OWN FAILURE OUT LOUD. A record that can go missing quietly is
 * the same shape of bug as the one this whole table exists to end, so a failed
 * write is an error in the log AND a false `recorded` on the send's result.
 */
export async function recordSmsAttempt(
  a: SmsAttempt,
): Promise<{ recorded: boolean; error?: string }> {
  const print = fingerprintBody(a.body);
  const accepted = (a.acceptedStatus ?? "").trim() || null;
  try {
    const admin = createServiceClient();
    const { error } = await admin.from(SMS_RECEIPTS).insert({
      message_sid: a.sid,
      to_e164: a.to,
      kind: (a.kind ?? "").trim() || "unlabelled",
      park_id: a.parkId ?? null,
      lake_id: a.lakeId ?? null,
      body_length: print.length,
      body_sha256: print.sha256,
      accepted_status: accepted,
      // The latest status starts as the only status we have. Leaving it null
      // would make every not-yet-answered message look like a message with no
      // status at all, which is what "we never looked" looked like.
      status: accepted ?? "accepted",
    });
    if (error) {
      // 23505 is the unique index on the SID. Twilio does not hand out a SID
      // twice, so this means we filed this message already — a no-op, not a
      // problem worth waking anybody for.
      if (error.code === "23505") return { recorded: true };
      console.error(`[write failed] the delivery receipt for ${a.sid}:`, error.message);
      return { recorded: false, error: error.message ?? "write failed" };
    }
    return { recorded: true };
  } catch (e) {
    const why = e instanceof Error ? e.message : "write failed";
    console.error(`[write failed] the delivery receipt for ${a.sid}:`, why);
    return { recorded: false, error: why };
  }
}

export interface SmsReceipt {
  sid: string;
  /** Twilio's `MessageStatus`. */
  status: string;
  /** Twilio's `ErrorCode`, when it sent one. */
  errorCode?: string | null;
}

/**
 * Write down what the carrier said.
 *
 * `matched` is false when no row carries that SID — a Verify code, a message
 * sent before this table existed, or a send from another environment sharing
 * the Twilio account. That is not an error and must not be answered as one:
 * a 500 back to Twilio would have it redeliver the same receipt for days
 * against a row that will never exist.
 *
 * THE ORDER RULE IS NOT HERE. "A receipt can only advance a message, never
 * walk it back" is enforced by the trigger in migration 0171, because status
 * callbacks genuinely arrive out of order and two of them can arrive at once —
 * a read-then-write in this function would let the older one win the race. One
 * copy of the rule, in the only place that sees both rows.
 */
export async function recordSmsReceipt(
  r: SmsReceipt,
): Promise<{ matched: boolean; error?: string }> {
  const code = (r.errorCode ?? "").toString().trim() || null;
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from(SMS_RECEIPTS)
      .update({
        status: r.status,
        error_code: code,
        // The number in words, stored beside it. A four-digit code on a screen
        // is a thing to go and google at the moment somebody is trying to work
        // out why nobody got their booking confirmation.
        error_text: code ? smsErrorText(code) : null,
      })
      .eq("message_sid", r.sid)
      .select("message_sid");
    if (error) {
      console.error(`[write failed] the carrier's verdict on ${r.sid}:`, error.message);
      return { matched: false, error: error.message ?? "write failed" };
    }
    return { matched: (data ?? []).length > 0 };
  } catch (e) {
    const why = e instanceof Error ? e.message : "write failed";
    console.error(`[write failed] the carrier's verdict on ${r.sid}:`, why);
    return { matched: false, error: why };
  }
}

/** One window's tally. Every message is in exactly one of the three buckets. */
export interface SmsWindow {
  /** Messages a carrier took responsibility for. The denominator. */
  attempted: number;
  /** Reached a handset. */
  delivered: number;
  /** The carrier finished with it and it did not arrive. */
  failed: number;
  /** Still in flight — no verdict yet. Never counted as either of the above. */
  waiting: number;
}

export interface SmsDeliveryReport {
  /**
   * NULL MEANS WE COULD NOT LOOK, AND IT IS NOT A ZERO. A failed read rendered
   * as zeroes is a clean bill of health for a channel nobody checked, which is
   * the exact sentence this package was built to make impossible.
   */
  day: SmsWindow | null;
  week: SmsWindow | null;
  /** Worst first, in plain English: why the week's failures failed. */
  reasons: Array<{ code: string; text: string; count: number }>;
  error?: string;
}

const emptyWindow = (): SmsWindow => ({ attempted: 0, delivered: 0, failed: 0, waiting: 0 });

/**
 * A failure's reason in words. `smsErrorText` is the one home for the codes;
 * this adds the case it has no code for — a carrier that rejected the message
 * and sent no number at all, which reads worse than any of the known ones
 * because there is nothing to go and look up.
 */
function reasonText(code: string): string {
  if (code === "unknown") return "it did not arrive and the carrier gave no reason code";
  return smsErrorText(code);
}

/**
 * Did any of it arrive — over the last day, and over the last week.
 *
 * ONE READ, TALLIED HERE. The week's rows are counted in this process rather
 * than asked for as six head-counts: at the volume a lake business texts, the
 * rows are dozens, and six counts that can each fail separately is six ways
 * for the answer to be half-true.
 *
 * TWO WINDOWS ON PURPOSE. A day is what the nightly digest is about. A week is
 * what tells you whether tonight's silence is a quiet Tuesday or a channel
 * that died on Saturday — the distinction nobody could draw for a month.
 */
export async function smsDeliveryReport(nowMs: number = Date.now()): Promise<SmsDeliveryReport> {
  const weekAgo = new Date(nowMs - 7 * 24 * 3_600_000).toISOString();
  const dayAgo = new Date(nowMs - 24 * 3_600_000).toISOString();

  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from(SMS_RECEIPTS)
      .select("created_at, status, error_code")
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) {
      console.error("[read failed] the week's text delivery receipts:", error.message);
      return { day: null, week: null, reasons: [], error: error.message ?? "read failed" };
    }

    const day = emptyWindow();
    const week = emptyWindow();
    const byCode = new Map<string, number>();

    for (const row of data ?? []) {
      const status = String((row as { status?: unknown }).status ?? "").toLowerCase();
      const createdAt = String((row as { created_at?: unknown }).created_at ?? "");
      const windows = createdAt >= dayAgo ? [week, day] : [week];
      for (const w of windows) {
        w.attempted++;
        if (status === ARRIVED) w.delivered++;
        else if (TERMINAL.has(status)) w.failed++;
        else w.waiting++;
      }
      if (TERMINAL.has(status) && status !== ARRIVED) {
        const code = String((row as { error_code?: unknown }).error_code ?? "").trim() || "unknown";
        byCode.set(code, (byCode.get(code) ?? 0) + 1);
      }
    }

    return {
      day,
      week,
      reasons: [...byCode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([code, count]) => ({ code, count, text: reasonText(code) })),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : "read failed";
    console.error("[read failed] the week's text delivery receipts:", why);
    return { day: null, week: null, reasons: [], error: why };
  }
}
