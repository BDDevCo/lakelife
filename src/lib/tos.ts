/**
 * The user agreement version (owner posture, 2026-07-22): ONE bulletproof
 * agreement, both sides. LakeLife is a THIRD-PARTY ADMINISTRATOR — the
 * service relationship is customer ↔ crew, accepted between each other;
 * our duty is verification (crew insurance on file + W-9/EIN). Bumping
 * this constant re-prompts every signed-in user at their next visit to
 * the portal; each acceptance is stamped (who, which version, when) in the
 * acceptance ledger (0139), along with the exact words.
 *
 * v1-beta (21 Aug 2026) adds the two sections that were missing: what LakeLife
 * does for a PARK OWNER and for a RENTER. Neither role was mentioned anywhere
 * in the terms, and both are now asked to accept them — asking somebody to
 * agree to a document that does not describe their relationship produces a
 * record that reads as evidence and is not one.
 *
 * EVERY CLAIM IN THOSE SECTIONS IS A MECHANISM IN THE TREE, not a promise:
 * never owns (no ownership anywhere in the schema) · handles no cash · never
 * writes the lease and takes no position on a park's terms (0061, 0062, 0064,
 * 0067) · hosts no signing (owner decision, 20 Aug) · never a consumer
 * reporting agency (0052, 0108, with a post-condition) · bills nothing for a
 * month that began before go-live (0131) · a payment is credited only on the
 * park's confirmation (0074) · texts only on the resident's own consent (0133).
 *
 * STILL FOR COUNSEL. These describe what the software does. They are not a
 * substitute for the full agreement, which is still being drafted.
 */
export const TOS_VERSION = "tos-v1-beta";
