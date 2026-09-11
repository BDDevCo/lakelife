/**
 * TEXT A PERSON TYPED, ON ITS WAY INTO AN HTML EMAIL.
 *
 * Every notification body in this codebase is a template literal assembled by
 * hand, and for a long time that was safe by construction: the values going
 * into them were names, addresses, counts and prices we composed ourselves.
 *
 * Then the crew got a box to type a sentence into, and that sentence started
 * arriving in the owner's inbox. A crew writing
 *
 *     gate is <4ft wide, truck won't fit
 *
 * sends an email a mail client renders as
 *
 *     Your crew can't start until you've seen this: "gate is
 *
 * because everything from `<4ft` onward is eaten as an unknown tag — including
 * the sentence telling them nothing is charged while they decide. They are
 * then asked to hold or release somebody's job on half a sentence. That is not
 * a security story, it is the plain-and-obvious one: the message did not
 * arrive.
 *
 * Apply this at the point the text enters HTML, NOT at the point it is
 * composed. The same sentences also go out by SMS, where an owner reading
 * `&quot;` aloud is the bug.
 */
export function emailSafe(text: string): string {
  return text
    // & FIRST, or the ampersands introduced below get escaped a second time
    // and the owner reads `&amp;lt;`.
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
