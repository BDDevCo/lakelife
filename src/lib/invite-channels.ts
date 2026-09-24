/**
 * WHICH DOORS ARE OPEN TO ONE HOUSEHOLD.
 *
 * The invite is one token. How many ways it travels is a separate question,
 * answered per household from what we hold about them and what they have
 * agreed to. Email and text go out together where both are allowed, so the
 * link is waiting in two places and either one works.
 *
 * ---------------------------------------------------------------------------
 * THE TEXT DOOR IS BUILT AND HELD SHUT, DELIBERATELY.
 *
 * Twilio is configured and this app already texts crews and customers, so the
 * transport is not the obstacle. The obstacle is WHICH NUMBER.
 *
 * A household imported from a roll has exactly one number on file:
 * `phone_on_file_with_park`, copied from whatever records came with the park.
 * That column exists so the software CANNOT text it — a number somebody else
 * wrote down is not that person agreeing to be messaged, mobile numbers get
 * reassigned, and texting carries per-message statutory damages that email
 * does not. Nineteen texts to a stale roll is nineteen separate exposures.
 *
 * So the rule here is narrow: we text only a number the RESIDENT gave us and
 * verified, with operational consent recorded. Today nothing writes
 * `mobile_verified_at` or `sms_consent_operational_at`, so in practice no
 * imported household qualifies and every invite goes by email alone.
 *
 * THAT IS THE POINT, AND IT IS WHY THIS RETURNS A REASON RATHER THAN A BOOLEAN.
 * A gate that silently never opens is indistinguishable from a gate that is
 * broken. Naming which of the four conditions failed means the screen can say
 * "no mobile on file" versus "they haven't confirmed that number", and means
 * the day A2P clears and the consent columns get a writer, the change is one
 * predicate rather than an archaeology expedition.
 */

export type SmsHold =
  | "no_number"        // nothing on file at all
  | "park_file_only"   // only the number off the old roll — never a send target
  | "unverified"       // they gave it, but it has not been confirmed
  | "no_consent";      // confirmed, but they have not agreed to operational texts

export interface RenterChannels {
  email: string | null;
  /** The number a resident gave us themselves, once confirmed. */
  mobileE164: string | null;
  mobileVerifiedAt: string | null;
  smsConsentAt: string | null;
  /** The number off the previous records. Readable, never sendable. */
  phoneOnFile: string | null;
}

export interface ChannelPlan {
  /** Where the email goes, or null. */
  email: string | null;
  /** Where the text goes, or null when held. */
  sms: string | null;
  /** Why there is no text. Null exactly when `sms` is set. */
  smsHold: SmsHold | null;
}

export function planChannels(r: RenterChannels): ChannelPlan {
  const email = (r.email ?? "").trim() || null;

  const mobile = (r.mobileE164 ?? "").trim();
  let smsHold: SmsHold | null = null;

  if (!mobile) {
    // Distinguish "we know of no number" from "we hold one we may not use",
    // because they need different things from the office.
    smsHold = (r.phoneOnFile ?? "").trim() ? "park_file_only" : "no_number";
  } else if (!r.mobileVerifiedAt) {
    smsHold = "unverified";
  } else if (!r.smsConsentAt) {
    smsHold = "no_consent";
  }

  return {
    email,
    sms: smsHold === null ? mobile : null,
    smsHold,
  };
}

const HOLD_SAYS: Record<SmsHold, string> = {
  no_number: "no mobile on file",
  // Said in full, because it is the one an owner will otherwise read as a bug:
  // the number is right there on the household's row.
  park_file_only: "the number came off the old records — we can't text it until they give it to us themselves",
  unverified: "that mobile hasn't been confirmed by them yet",
  no_consent: "they haven't agreed to texts",
};

export function smsHoldSays(hold: SmsHold): string {
  return HOLD_SAYS[hold];
}

/**
 * THE TEXT. One line, the park's name first, and a link.
 *
 * Short on purpose — it is read on a lock screen. It carries no code, for the
 * same reason the email doesn't: the printed slip promises we will never text
 * asking for one, and that promise dies the moment a code travels by message.
 *
 * ============ IT SAYS STOP, BECAUSE THIS IS THE FIRST MESSAGE ============
 *
 * CTIA's guidance is that the message following an opt-in carries the opt-out
 * instruction, and the A2P campaign filing DESCRIBES a flow in which replying
 * STOP works. It does work — Twilio's Advanced Opt-Out handles STOP before the
 * message ever reaches us — but a campaign whose samples do not say so is being
 * reviewed against a claim its own evidence does not support, and that is a
 * documented rejection reason. "Ignore this if you'd rather not" is a courtesy,
 * not an opt-out.
 *
 * ============ AND IT IS GSM-7, WHICH IS WORTH REAL MONEY ============
 *
 * This body used to contain an em-dash. A single character outside the GSM-7
 * alphabet forces the WHOLE message into UCS-2, and a UCS-2 segment holds 70
 * characters instead of 160 — so a 218-character invitation billed as FOUR
 * segments where it should have been two, on every household, forever. Plain
 * hyphens read identically on a lock screen.
 *
 * KEEP THIS FUNCTION GSM-7. No em-dashes, no curly quotes, no emoji. The test
 * beside this one asserts it character by character, so a well-meant typographic
 * "improvement" fails the build rather than doubling the bill.
 */
export function inviteSmsBody(input: { parkName: string; lotNumber: string; url: string }): string {
  return (
    `${input.parkName}: you can see lot ${input.lotNumber} - your rent and receipts - here: ` +
    `${input.url}\n\nNothing about how you pay changes. We'll never text asking for a code ` +
    `or card details. Reply STOP to stop.`
  );
}

/**
 * The GSM-7 alphabet, for the test that keeps a message in it.
 *
 * Exported rather than duplicated in the test file because the point is that
 * the RULE and the CHECK are the same thing: a body is cheap to send only if
 * every character is in here.
 */
export const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
  "^{}\\[~]|€",
);

/** True when every character survives GSM-7, i.e. 160 chars a segment not 70. */
export function isGsm7(body: string): boolean {
  for (const ch of body) if (!GSM7.has(ch)) return false;
  return true;
}
