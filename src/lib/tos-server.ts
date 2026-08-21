import "server-only";
import { TOS_VERSION } from "@/lib/tos";
import { termsPlainText } from "@/lib/terms-content";
import { hasAccepted, recordAcceptance } from "@/lib/acceptances";

/**
 * The agreement stamp, at the moment of service (owner, 2026-07-22):
 * onboarding is frictionless — acceptance happens the FIRST time someone
 * agrees to give or receive service (booking / go-live), then never again
 * until the profile is deleted or TOS_VERSION bumps. "needs" tells the
 * caller to show the quick scroll-and-agree; the retried call carries
 * accepted=true, stamps, and pushes the request through in one motion.
 *
 * NOW WRITES TO THE LEDGER (0139), not to two columns on `users`.
 *
 * What changed and why it matters: acceptance used to be `tos_version` +
 * `tos_accepted_at`, overwritten in place. One acceptance per person, ever, and
 * none of the words. Accepting a second document destroyed the record of the
 * first, which made a renter who must agree to our terms AND a park lease AND a
 * rulebook simply unrepresentable — and left us holding a version string that
 * cannot answer what anybody actually read.
 *
 * The words are now snapshotted at the moment of the tap, from
 * `termsPlainText()` — the same source `TermsBody` renders — so what is in the
 * record is by construction what was on screen. That is 0133's rule, which SMS
 * consent has followed since it shipped and the terms never did.
 *
 * A FAILED READ NO LONGER READS AS "hasn't accepted". The old version
 * destructured `data` with no error check, so a dropped connection returned
 * "needs" and re-prompted somebody who had already agreed — then wrote a second
 * acceptance when they tapped again. `hasAccepted` throws instead, and the
 * request fails honestly rather than quietly collecting a duplicate agreement.
 */
export async function ensureTos(userId: string, accepted?: boolean): Promise<"ok" | "needs"> {
  if (await hasAccepted({ userId }, "tos", TOS_VERSION)) return "ok";
  if (!accepted) return "needs";

  const res = await recordAcceptance({
    subject: { userId },
    kind: "tos",
    version: TOS_VERSION,
    text: termsPlainText(),
  });
  // The caller's next move is to perform the thing the acceptance gates —
  // booking, going live — so an unrecorded agreement must not read as a
  // recorded one. Sending them back to the modal is the honest failure.
  if (!res.ok) return "needs";

  return "ok";
}
