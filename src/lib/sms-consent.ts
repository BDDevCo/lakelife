/**
 * WHAT WE ASK, AND WHAT WE RECORD — THE SAME STRING.
 *
 * `SMS_CONSENT_TEXT` is rendered on the resident's screen AND written into
 * `park_renters.sms_consent_text` at the moment they tap. One constant, used
 * twice, so the sentence in the record is by construction the sentence they
 * read. The alternative — copy in a component and a paraphrase in an action —
 * is how a consent record ends up describing something nobody was shown.
 *
 * Change this wording and every household consented from that moment carries
 * the new text; the ones before keep the old one. That is the entire point of
 * snapshotting it rather than looking it up.
 */
export const SMS_CONSENT_TEXT =
  "Yes — text this number about my lot and my rent at " +
  "{park}. Message and data rates may apply. I can stop them any time by " +
  "replying STOP or turning this off here.";

/** The sentence with the park's name in it, for both the screen and the record. */
export function smsConsentText(parkName: string): string {
  return SMS_CONSENT_TEXT.replace("{park}", parkName);
}

/**
 * WHAT TURNING IT ON DOES AND DOES NOT DO.
 *
 * Said on the screen, because "we'll text you" is vague enough that somebody
 * agreeing to it has not really agreed to anything. Rent reminders and their
 * own lot — not marketing, and not a change to how they pay.
 */
export const SMS_OPT_IN_BLURB =
  "We'll use it for things about your own lot — a note when rent is due, a " +
  "receipt when it's paid, and the link to see your rent on your phone. " +
  "Nothing about how you pay changes, and we won't use it for anything else.";

export type OptInStep = "idle" | "code_sent" | "done";

export interface OptInResult {
  ok: boolean;
  message: string;
  step?: OptInStep;
}

const SAYS: Record<string, string> = {
  not_signed_in: "Sign in again — your session expired.",
  no_file: "We couldn't find your lot. Have a word with the office.",
  bad_phone: "That doesn't look like a US mobile number.",
  not_configured: "Texts aren't switched on yet. Nothing's wrong at your end.",
  send_failed: "We couldn't send the code just now. Try again in a minute.",
  code_wrong: "That code didn't match. Check it and try again, or send a new one.",
  code_expired: "That code has expired — send a new one.",
  // A LANDLINE IS NOT A FAILURE ON HER PART. It is the single most likely
  // reason this goes wrong for the exact person we are trying to help.
  landline: "That looks like a landline — texts need a mobile number.",
  saved: "Done — we'll text that number.",
  off: "Turned off. We won't text you.",
};

export function optInSays(code: string): string {
  return SAYS[code] ?? "That didn't work. Try again in a minute.";
}
