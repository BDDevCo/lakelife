import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { softRead } from "@/lib/must-read";
import {
  hasSupabaseEnv,
  hasTwilioMessagingEnv,
  hasTwilioVerifyEnv,
  missingTwilioVars,
} from "@/lib/env";
import { getSmsHealth, type SmsHealth } from "@/app/ops/sms-health";
import { statusCallbackUrl } from "@/lib/sms-receipts";

/**
 * IS TEXTING SWITCHED ON, AND HOW WOULD I KNOW?
 *
 * The ops console already has a panel that answers "did the texts arrive"
 * (sms-health.ts). It could not answer the question the owner actually has on
 * the day the A2P campaign clears, which is a different one: *is the thing
 * switched on at all, and if nothing is arriving, which of the four reasons is
 * it?* Four, because they look identical from the dashboard:
 *
 *   1. the Messaging channel is not configured — no Messaging Service SID;
 *   2. it is configured and the carrier is rejecting;
 *   3. it is configured, nothing has been sent, so there is nothing to judge;
 *   4. it is configured and working, and a PARK IS HOLDING NOTICES, so the
 *      product is refusing to send on purpose.
 *
 * The fourth is the dangerous one. A held park is a deliberate refusal the
 * owner asked for, and it produces exactly the symptom of a broken transport —
 * nobody gets a text. Reading that as a fault is how somebody "fixes" it by
 * lifting a hold that twenty households have not been warned about yet.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD HERE IS A FACT THIS FUNCTION READ, AND NAMES.
 *
 * Nothing on this page is a hardcoded status, a remembered number or a
 * hopeful default. Environment answers come from `process.env` by NAME ONLY —
 * no value of a credential is ever returned from this module, so no value can
 * reach a screen, a log or a screenshot. Delivery answers come from Twilio's
 * own message log. The hold answers come from `parks.notices_held_at`.
 *
 * AND A READ THAT FAILED SAYS SO. `holds.failed` is not cosmetic: an empty
 * `parks` list and a refused query are the same `null` in supabase-js, and
 * "no park is holding notices" is the single most misleading sentence this
 * page could print while a park is in fact holding them.
 */

export interface HeldPark {
  name: string;
  /** ISO, when the hold was put on. */
  heldAt: string | null;
  /** The owner's own words, when he gave them. */
  reason: string | null;
}

export interface ChannelState {
  ready: boolean;
  /** The variables that are not set, BY NAME. Never a value. */
  missing: string[];
}

export interface TextingSetup {
  /** Codes — sign-in and the resident opt-in. Twilio's managed sender pool. */
  verify: ChannelState;
  /** Notifications — confirmations, dispatch, reminders, invites. */
  messaging: ChannelState;
  /**
   * True when the only sender configured is the bare number. Post-registration
   * that is NOT enough — carriers route on the Messaging Service — and it is
   * the exact state this product sat in for the whole outage, so it gets its
   * own sentence rather than being folded into "not configured".
   */
  bareNumberOnly: boolean;
  /**
   * CAN A CARRIER'S VERDICT REACH US AT ALL?
   *
   * A fifth way for nothing to arrive, and the quietest of the lot. Every send
   * files a receipt row (0171), but the row only ever learns whether the
   * message was DELIVERED when Twilio calls /api/twilio/status back — and that
   * callback is attached to the send only when `statusCallbackUrl()` can build
   * a real https origin out of NEXT_PUBLIC_SITE_URL. When it cannot, it is
   * omitted deliberately (Twilio refuses an unroutable callback outright,
   * 21609), every receipt sits at `queued` for ever, and a clean sheet of
   * zero failures is indistinguishable from a channel nobody is watching.
   *
   * That is the exact shape of the original outage — a green console over a
   * dead channel — so it is named on the screen rather than left to be
   * inferred. The URL is a public origin, not a credential.
   */
  deliveryVerdicts: { wired: boolean; url: string | null };
  /** Twilio's own delivery log. Null `window` means we could not ask. */
  log: SmsHealth;
  holds: {
    parks: HeldPark[];
    /** True when the parks read FAILED — never rendered as "none". */
    failed: boolean;
    /** True when there is no database configured to ask at all. */
    unavailable: boolean;
  };
}

export async function getTextingSetup(): Promise<TextingSetup> {
  // Both Twilio answers and the database answer are independent, so they go
  // out together. Neither can throw: the log call catches its own failure and
  // the holds read is soft, so there is no allSettled to write here.
  const [log, holds] = await Promise.all([getSmsHealth(), getHeldParks()]);

  return {
    verify: { ready: hasTwilioVerifyEnv(), missing: missingTwilioVars("verify") },
    messaging: { ready: hasTwilioMessagingEnv(), missing: missingTwilioVars("messaging") },
    // Named from the two variables directly, not from `messaging.ready`: the
    // sentence this drives is "you have a number but not a service", which is
    // only true when the number IS set and the service is NOT.
    bareNumberOnly:
      Boolean(process.env.TWILIO_PHONE_NUMBER) && !process.env.TWILIO_MESSAGING_SERVICE_SID,
    // Asked of the same helper the sender uses, never a second reading of the
    // rule: if this says null, sendSms is omitting the callback too.
    deliveryVerdicts: (() => {
      const url = statusCallbackUrl();
      return { wired: url !== null, url };
    })(),
    log,
    holds,
  };
}

async function getHeldParks(): Promise<TextingSetup["holds"]> {
  // No database, nothing to ask. Said out loud rather than returned as an
  // empty list, because "no park is holding notices" would be an answer this
  // function did not earn.
  if (!hasSupabaseEnv() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { parks: [], failed: false, unavailable: true };
  }

  const admin = createServiceClient();
  const [rows, failed] = softRead(
    "which parks are holding notices",
    await admin
      .from("parks")
      .select("name, notices_held_at, notices_held_reason")
      .not("notices_held_at", "is", null)
      .order("name"),
    null,
  );

  return {
    parks: (rows ?? []).map((r) => ({
      name: (r.name as string) ?? "an unnamed park",
      heldAt: (r.notices_held_at as string) ?? null,
      reason: (r.notices_held_reason as string) ?? null,
    })),
    failed,
    unavailable: false,
  };
}
