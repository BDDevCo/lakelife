import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { fingerprintBody } from "@/lib/sms-receipts";

/**
 * THE RECORD OF EVERY EMAIL WE ASKED RESEND TO DELIVER.
 *
 * ============================================================================
 * WHY THIS EXISTS: THE SAME SHAPE OF OUTAGE, ON THE ONLY CHANNEL LEFT.
 * ============================================================================
 * Between 19 July and 16 August 2026 this product sent 81 texts and delivered
 * none of them. It hid because ACCEPTANCE AND DELIVERY ARE DIFFERENT EVENTS:
 * `sendSms` returned the moment Twilio took the message, the carrier's verdict
 * arrived later on a callback, and there was no route, no record and no screen
 * to receive it. 0171 and lib/sms-receipts ended that for text.
 *
 * EMAIL HAS EXACTLY THE SAME HOLE AND IT IS NOW THE ONLY DOOR THAT WORKS. The
 * A2P Brand is approved but no Campaign exists, so texting stays dead for at
 * least another 10-15 business days (see lib/sms.ts). Until then every booking
 * confirmation, invite, reminder and receipt this business sends is an email,
 * and `sendEmail` has been posting to api.resend.com and writing down nothing
 * at all. A second silent month is available to us on this channel and nobody
 * would know until somebody said they never got their bill.
 *
 * ============================================================================
 * WHAT THIS RECORDS, AND WHAT IT REFUSES TO RECORD.
 * ============================================================================
 * A row per message Resend accepted: its id, the destination, what kind of
 * message it was, the park it belongs to, and then the verdict as it arrives.
 *
 * NOT THE SUBJECT, NOT THE BODY, NOT A NAME. Only lengths and SHA-256 digests.
 * "Did it arrive" needs no words, and keeping the text would turn an operations
 * table into a store of what residents were told about their homes and their
 * rent. The hash still proves two rows are the same message, or that the bill a
 * household swears they never got is the one we sent.
 *
 * A message refused by our OWN gates — a malformed or reserved address, a
 * fixture account, a park holding its notices — gets NO ROW. It never reached
 * Resend, it is a different fact with a different fix, and counting refusals as
 * attempts would sink the delivery rate this table exists to watch. Likewise a
 * send Resend REFUSED: it hands back no id, and an id is the only key a
 * delivery event can ever carry, so there is nothing to file it under. That is
 * a real blind spot and it is named out loud in sendEmail rather than papered
 * over with an invented key.
 *
 * ONE FINGERPRINT, NOT A SECOND COPY OF ONE. `fingerprintBody` is imported from
 * lib/sms-receipts rather than rewritten here. A rule copied into two doorways
 * and finished in one is this codebase's signature defect (see
 * email-bodies-are-escaped.test.ts on the six hand-rolled escapers). If the
 * import reads oddly, move the helper to a neutral module — but move it, do not
 * duplicate it.
 */

/** The one spelling of the table name, so a typo is a compile error somewhere. */
export const EMAIL_RECEIPTS = "email_receipts";

export interface EmailAttempt {
  /**
   * Resend's own id for the message. The row's identity, and — pending
   * confirmation against Resend's docs — the only key a delivery event carries.
   */
  id: string;
  /** Destination, exactly as it was handed to Resend. */
  to: string;
  /** Hashed here and then dropped. Never stored. */
  subject: string;
  /**
   * What kind of message this is, in the caller's words — "the owner that their
   * pier removal was cancelled", "park invite", "receipt". It exists so a person
   * reading a week of failures can see WHICH promises went unkept, not just how
   * many.
   */
  kind?: string | null;
  parkId?: string | null;
  lakeId?: string | null;
  /** Fingerprinted here and then dropped. Never stored. */
  body: string;
  /** Whatever Resend said on acceptance, when it says anything at all. */
  acceptedStatus?: string | null;
  /**
   * Sent from Resend's shared sandbox address, which only ever delivers to the
   * Resend account owner. The send is real and the row is true; what is NOT true
   * is that the person named in `to_email` received anything, so no count of
   * people reached may include these.
   */
  sandbox?: boolean;
}

/**
 * File an accepted message. Best-effort, like every other step in a send: a
 * booking must not fail because its receipt row didn't save.
 *
 * IT REPORTS ITS OWN FAILURE OUT LOUD. A record that can go missing quietly is
 * the same shape of bug as the one this table exists to end, so a failed write
 * is an error in the log AND a false `recorded` on the send's result.
 */
export async function recordEmailAttempt(
  a: EmailAttempt,
): Promise<{ recorded: boolean; error?: string }> {
  const print = fingerprintBody(a.body);
  const accepted = (a.acceptedStatus ?? "").trim() || null;
  try {
    const admin = createServiceClient();
    const { error } = await admin.from(EMAIL_RECEIPTS).insert({
      message_id: a.id,
      to_email: a.to,
      kind: (a.kind ?? "").trim() || "unlabelled",
      park_id: a.parkId ?? null,
      lake_id: a.lakeId ?? null,
      subject_sha256: fingerprintBody(a.subject).sha256,
      body_length: print.length,
      body_sha256: print.sha256,
      accepted_status: accepted,
      // The latest status starts as the only status we have. Leaving it null
      // would make every not-yet-answered message look like a message nobody
      // ever asked about — which is what "we never looked" looked like.
      status: accepted ?? "accepted",
      sandbox: a.sandbox === true,
    });
    if (error) {
      // 23505 is the unique index on the id. Resend does not hand out an id
      // twice, so this means we filed this message already — a no-op, not a
      // problem worth waking anybody for.
      if (error.code === "23505") return { recorded: true };
      console.error(`[write failed] the delivery receipt for ${a.id}:`, error.message);
      return { recorded: false, error: error.message ?? "write failed" };
    }
    return { recorded: true };
  } catch (e) {
    const why = e instanceof Error ? e.message : "write failed";
    console.error(`[write failed] the delivery receipt for ${a.id}:`, why);
    return { recorded: false, error: why };
  }
}

/**
 * THE OTHER HALF: THE MAILBOX'S VERDICT.
 *
 * `recordEmailAttempt` above files the row the moment Resend takes the
 * message. This one is what the webhook calls when a mailbox finally answers,
 * and the split matters: `accepted_status` and `status` have DIFFERENT
 * WRITERS, so the two disagreeing is a fact the table can state. That
 * disagreement — accepted, then never delivered — is precisely the shape that
 * hid the texting outage from 19 July to 16 August.
 *
 * IT UPDATES, NEVER INSERTS. A row exists only for a message we actually
 * handed to Resend, so a verdict that matches nothing is not ours: a message
 * from another app on the same account, a replay from before this table
 * existed, or a forgery that got past the signature. `matched: false` is the
 * honest answer and the caller reports it rather than manufacturing a row.
 *
 * NO ERROR-CODE LOOKUP, unlike the SMS side. `smsErrorText()` exists because
 * Twilio's four-digit codes are meaningless on a screen; Resend sends prose,
 * so the provider's own words are stored as they arrive rather than
 * translated through a table we would have to invent and maintain.
 *
 * REPLAYS ARE SAFE WITHOUT AN IDEMPOTENCY KEY. The forward-only trigger makes
 * a repeated verdict a true no-op that does not even move `status_at`, and a
 * verdict that would move the row BACKWARDS is refused there rather than here.
 * This function does not need to know the vocabulary, which is the point —
 * Resend's event names are not confirmed yet.
 */
export async function recordEmailReceipt(r: {
  messageId: string;
  status: string;
  errorCode?: string | null;
  errorText?: string | null;
}): Promise<{ matched: boolean; error?: string }> {
  const code = (r.errorCode ?? "").toString().trim() || null;
  const text = (r.errorText ?? "").toString().trim() || null;
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from(EMAIL_RECEIPTS)
      .update({
        status: r.status,
        error_code: code,
        error_text: text,
      })
      .eq("message_id", r.messageId)
      .select("message_id");
    if (error) {
      console.error(`[write failed] the mailbox's verdict on ${r.messageId}:`, error.message);
      return { matched: false, error: error.message ?? "write failed" };
    }
    // Zero rows is not an error. It means this verdict was about a message
    // that is not in our ledger, and the caller says so out loud.
    return { matched: (data ?? []).length > 0 };
  } catch (e) {
    const why = e instanceof Error ? e.message : "write failed";
    console.error(`[write failed] the mailbox's verdict on ${r.messageId}:`, why);
    return { matched: false, error: why };
  }
}
