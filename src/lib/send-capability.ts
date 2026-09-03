import "server-only";

/**
 * CAN A NOTICE ACTUALLY REACH A HOUSEHOLD FROM THIS DEPLOYMENT?
 *
 * Not "may we write to this person" — `contactable.ts` answers that, about the
 * recipient. This is the other half, about US: is there a working channel at
 * all, or would every send land nowhere?
 *
 * It exists because of one sentence. Lifting the notice hold answered:
 *
 *     "Lifted. Notices can now reach your households."
 *
 * That is a promise about the world, and today it is false in both channels at
 * once. It is the last thing the park owner reads before he believes twenty
 * households are being told about their rent.
 *
 * ============ WHY CONFIGURATION IS ENOUGH TO KNOW THIS ============
 *
 * EMAIL. `sendEmail` falls back to Resend's sandbox sender when `EMAIL_FROM`
 * is unset, and the sandbox only ever delivers to the Resend account owner. So
 * an unset EMAIL_FROM is not a warning about a risk — it is a statement that
 * nothing reaches anybody but him. `email.ts` says so in its own header and
 * logs it once per process, which is a line in a server log he will never read.
 *
 * SMS. Carriers route registered A2P traffic on a MESSAGING SERVICE, not on a
 * bare number — `sms.ts` puts it plainly: "sending from the bare number keeps
 * the traffic unregistered no matter how green the console looks." So an unset
 * `TWILIO_MESSAGING_SERVICE_SID` means unregistered traffic, and unregistered
 * traffic is dropped. That is the whole explanation for 0 of 81 texts
 * delivered since July.
 *
 * ============ WHAT THIS DELIBERATELY DOES NOT CLAIM ============
 *
 * The inverse is weaker than the forward direction and the wording respects
 * that. A Messaging Service SID being SET does not prove a campaign was
 * approved, and an EMAIL_FROM being set does not prove the domain is verified.
 * Absence proves a channel is dead; presence only means the obvious blocker is
 * gone. So this reports "no channel can reach anyone" with confidence and says
 * nothing stronger than "configured" the other way.
 *
 * It also refuses nothing. Holding and lifting notices is the owner's call and
 * may well be right before either channel works. The only job here is that the
 * sentence he reads is true.
 */

export interface SendCapability {
  /** EMAIL_FROM and a Resend key are both present. */
  email: boolean;
  /** Twilio creds and a Messaging Service — registered traffic's only route. */
  sms: boolean;
  /** True when neither channel could reach a stranger. */
  none: boolean;
  /** Plain sentences naming what is missing, in the owner's terms. */
  reasons: string[];
}

export function sendCapability(): SendCapability {
  const reasons: string[] = [];

  const hasResendKey = Boolean(process.env.RESEND_API_KEY);
  const hasFrom = Boolean(process.env.EMAIL_FROM);
  if (!hasResendKey) {
    reasons.push("Email isn't connected at all — no mail can go out.");
  } else if (!hasFrom) {
    reasons.push(
      "Email still sends from our test address, which only ever arrives in our own inbox — " +
      "nothing reaches a household until EMAIL_FROM is set.",
    );
  }

  const hasTwilio = Boolean(process.env.TWILIO_ACCOUNT_SID) && Boolean(process.env.TWILIO_AUTH_TOKEN);
  const hasService = Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID);
  if (!hasTwilio) {
    reasons.push("Texting isn't connected at all.");
  } else if (!hasService) {
    reasons.push(
      "Texts aren't registered with the carriers yet, so they're dropped rather than delivered.",
    );
  }

  const email = hasResendKey && hasFrom;
  const sms = hasTwilio && hasService;
  return { email, sms, none: !email && !sms, reasons };
}

/**
 * What to tell the owner when he lifts the hold.
 *
 * The old sentence was "Lifted. Notices can now reach your households." — true
 * only when a channel exists. This says which it is, and never claims more
 * than the configuration supports.
 */
export function liftedNoticesSignal(cap: SendCapability = sendCapability()): string {
  if (cap.none) {
    return `Lifted — but nothing can actually go out yet. ${cap.reasons.join(" ")}`;
  }
  if (cap.email && !cap.sms) {
    return "Lifted. Notices will reach your households by email. Texts still aren't registered with the carriers, so nothing goes out that way.";
  }
  if (cap.sms && !cap.email) {
    return "Lifted. Notices will go out by text. Email still sends from our test address, so nothing reaches a household that way.";
  }
  return "Lifted. Notices can now reach your households.";
}
