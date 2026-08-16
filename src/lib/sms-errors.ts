/**
 * TWILIO ERROR CODES, IN WORDS, WITH THE REMEDY IN THEM.
 *
 * A four-digit number on an ops screen is a thing to go and google at the
 * moment somebody is trying to work out why nobody got their booking
 * confirmation. The sentence should be enough on its own.
 *
 * 30034 is the one that matters here and it is the reason this file exists:
 * every real message this product has ever sent failed with it.
 */
const TEXT: Record<string, string> = {
  // The whole story, as of Aug 2026.
  "30034": "the sending number isn't registered for business texting (A2P 10DLC) — carriers reject everything until it is",
  "30032": "the sending number is blocked for this kind of traffic",
  "30003": "the handset was unreachable — off, or out of coverage",
  "30005": "that number doesn't exist any more",
  "30006": "a landline, or a carrier that won't take texts",
  "30007": "the carrier filtered it as spam",
  "21610": "they replied STOP — we may not text them again",
  "21268": "the number can't be messaged (a reserved or service line)",
  "21211": "that number isn't a valid phone number",
};

export function smsErrorText(code: string): string {
  // Unknown codes render as the code plus a nudge, never as blank — a silent
  // gap here is how a new failure mode hides behind a tidy screen.
  return TEXT[code] ?? `Twilio error ${code} — look it up before assuming it's harmless`;
}

/** True for the failures a person can actually clear. */
export function smsErrorIsFixable(code: string): boolean {
  return code === "30034" || code === "30032" || code === "30007";
}
