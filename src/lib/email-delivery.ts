import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { EMAIL_RECEIPTS } from "@/lib/email-receipts";

/**
 * DID ANY OF THE EMAIL ARRIVE?
 *
 * ============================================================================
 * THE SAME QUESTION, ON THE CHANNEL THAT IS ACTUALLY CARRYING EVERYTHING.
 * ============================================================================
 * Between 19 July and 16 August 2026 this product sent 81 texts and delivered
 * none of them, and nothing knew, because acceptance and delivery are
 * different events and only the first one had a reader. `sendEmail` has the
 * identical shape: it POSTs to Resend, Resend answers 200 with an id, and that
 * 200 means a queue accepted the message. Whether a mailbox did is decided
 * later, somewhere else, by somebody else.
 *
 * Email is not a second copy of that bug. It is a worse one, because email is
 * currently the only door every ops alarm goes out through — the nightly
 * digest, the crew-not-paid alert, the charged-but-not-recorded alert — so a
 * blind spot here is a blind spot over the alarms themselves.
 *
 * ============================================================================
 * WHY THERE IS NO SECOND SOURCE TO CHECK AGAINST, AND WHAT REPLACES ONE.
 * ============================================================================
 * The SMS panel (app/ops/sms-health.ts) deliberately reads TWILIO'S log rather
 * than our receipts, so a bug in our own writer cannot make the screen agree
 * with itself. Nothing in this repository reads anything back from Resend, so
 * email has no equivalent: our table is the only copy we hold.
 *
 * What stands in for it is that the table has TWO WRITERS and they are
 * independent. `accepted_status` is written by sendEmail the instant Resend
 * takes the message; `status` and `status_at` are advanced only when the
 * webhook door posts the verdict. Comparing the two is therefore still
 * comparing two independent statements, and the comparison that matters —
 * ACCEPTED VERSUS CONFIRMED DELIVERED — is the one this module exists to
 * publish.
 *
 * `verdicts` is the sharpest form of it. `status_at` is null until the trigger
 * stamps it on an UPDATE, so a week of rows with not one non-null `status_at`
 * means no verdict has EVER reached us. That is a different and louder fact
 * than "nothing was delivered": it says the webhook half of the pair is not
 * running, and every clean-looking row is clean only because nobody checked.
 *
 * ============================================================================
 * THE STATUS WORDS ARE OURS, NOT RESEND'S.
 * ============================================================================
 * 0171 could hardcode Twilio's statuses because Twilio's documentation is
 * quoted in that migration. Resend's event names are written down nowhere in
 * this tree and are NOT asserted here. The webhook door normalises whatever
 * Resend sends onto the vocabulary below; this module reads that vocabulary
 * and nothing else.
 *
 * A word we do not recognise is counted as WAITING — never as delivered and
 * never as failed — which is the same posture sms_status_rank() takes when it
 * returns null for an unknown status: the honest answer is "no idea where this
 * sits", and no idea must never be filed as good news. It is also returned BY
 * NAME in `unknownStatuses`, so the screen prints the word instead of quietly
 * miscounting it, and the vocabulary gets corrected from evidence rather than
 * from a guess.
 */

/** Reached a mailbox. The only word that means a person can read it. */
export const DELIVERED = "delivered";

/**
 * The provider has finished with it and it did not arrive. OUR words, written
 * by the webhook door. `complained` is here on purpose: a spam complaint means
 * it arrived, but it is a terminal verdict and it is never good news, so it is
 * counted with the failures and named in the reasons rather than buried.
 */
const FAILED_STATUSES = new Set([
  "bounced",
  "complained",
  "rejected",
  "failed",
  "canceled",
  "suppressed",
]);

/** In flight. Not yet an answer, and must never be read as one either way. */
const WAITING_STATUSES = new Set([
  "accepted",
  "queued",
  "scheduled",
  "sent",
  "delayed",
  "delivery_delayed",
]);

export type EmailOutcome = "delivered" | "failed" | "waiting";

/**
 * Which of the three buckets a stored status falls in. ONE copy of this rule,
 * imported by the panel and by the digest, so the two surfaces cannot count
 * the same week differently.
 */
export function emailOutcome(status: string | null | undefined): EmailOutcome {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === DELIVERED) return "delivered";
  if (FAILED_STATUSES.has(s)) return "failed";
  return "waiting";
}

/** True when the word is one we actually understand. See unknownStatuses. */
export function isKnownEmailStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === DELIVERED || FAILED_STATUSES.has(s) || WAITING_STATUSES.has(s);
}

/** One window's tally. Every row is in exactly one of the three buckets. */
export interface EmailWindow {
  /** Messages Resend took responsibility for. The denominator. */
  attempted: number;
  /** Confirmed delivered by a verdict we actually received. */
  delivered: number;
  /** A terminal verdict that was not an arrival. */
  failed: number;
  /** No verdict yet, or a verdict in a word we do not recognise. */
  waiting: number;
}

export interface EmailDeliveryReport {
  /**
   * NULL MEANS WE COULD NOT LOOK, AND IT IS NOT A ZERO. A failed read rendered
   * as zeroes is a clean bill of health for a channel nobody checked.
   */
  day: EmailWindow | null;
  week: EmailWindow | null;
  /**
   * How many of the week's rows a verdict has EVER landed on — `status_at` is
   * null until the trigger stamps it, so this counts webhook arrivals, not
   * deliveries. Zero against a positive `attempted` is the loudest thing this
   * module can say. Null means the read failed, never "none".
   */
  verdicts: number | null;
  /** Worst first, in the provider's own words: why the week's failures failed. */
  reasons: Array<{ text: string; count: number }>;
  /** Stored statuses we do not classify, by name. Counted as waiting. */
  unknownStatuses: string[];
  error?: string;
}

const emptyWindow = (): EmailWindow => ({ attempted: 0, delivered: 0, failed: 0, waiting: 0 });

/**
 * Was any of it delivered — over the last day, and over the last week.
 *
 * ONE READ, TALLIED HERE, for the reason smsDeliveryReport gives: at the
 * volume a lake business emails, the rows are dozens, and six counts that can
 * each fail separately are six ways for the answer to be half-true.
 */
export async function emailDeliveryReport(
  nowMs: number = Date.now(),
): Promise<EmailDeliveryReport> {
  const weekAgo = new Date(nowMs - 7 * 24 * 3_600_000).toISOString();
  const dayAgo = new Date(nowMs - 24 * 3_600_000).toISOString();

  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from(EMAIL_RECEIPTS)
      // ONE LITERAL. A select built from concatenated pieces comes back as
      // GenericStringError on every column.
      .select("created_at, status, status_at, error_code, error_text")
      // THE SANDBOX IS NOT A PERSON. Mail sent from Resend's shared sandbox
      // address only ever arrives in our own inbox, so a sandbox row counted
      // as "delivered" is precisely the false comfort this module exists to
      // remove — it would read as a healthy channel on a day nothing reached
      // anybody. recordEmailAttempt stamps the flag; this is the reader that
      // honours it, and the partial index in 0187 is built for this filter.
      .eq("sandbox", false)
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) {
      console.error("[read failed] the week's email delivery receipts:", error.message);
      return {
        day: null,
        week: null,
        verdicts: null,
        reasons: [],
        unknownStatuses: [],
        error: error.message ?? "read failed",
      };
    }

    const day = emptyWindow();
    const week = emptyWindow();
    const byReason = new Map<string, number>();
    const unknown = new Set<string>();
    let verdicts = 0;

    for (const row of data ?? []) {
      const status = String((row as { status?: unknown }).status ?? "");
      const createdAt = String((row as { created_at?: unknown }).created_at ?? "");
      const stampedAt = (row as { status_at?: unknown }).status_at ?? null;
      const outcome = emailOutcome(status);

      const windows = createdAt >= dayAgo ? [week, day] : [week];
      for (const w of windows) {
        w.attempted++;
        if (outcome === "delivered") w.delivered++;
        else if (outcome === "failed") w.failed++;
        else w.waiting++;
      }

      // A WEBHOOK TOUCHED THIS ROW. Not "it arrived" — only that the verdict
      // had a door to come back through at all.
      if (stampedAt != null) verdicts++;

      if (outcome === "failed") {
        const text =
          String((row as { error_text?: unknown }).error_text ?? "").trim() ||
          String((row as { error_code?: unknown }).error_code ?? "").trim() ||
          "it did not arrive and no reason was recorded";
        byReason.set(text, (byReason.get(text) ?? 0) + 1);
      }

      if (status.trim() && !isKnownEmailStatus(status)) unknown.add(status.trim().toLowerCase());
    }

    return {
      day,
      week,
      verdicts,
      reasons: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([text, count]) => ({ text, count })),
      unknownStatuses: [...unknown].sort(),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : "read failed";
    console.error("[read failed] the week's email delivery receipts:", why);
    return { day: null, week: null, verdicts: null, reasons: [], unknownStatuses: [], error: why };
  }
}
