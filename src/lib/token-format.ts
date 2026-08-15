/**
 * THE SHAPE OF A BEARER TOKEN — one rule, in one place, so it cannot drift.
 *
 * Several links in this app carry their authority in the URL: the guest link
 * that books a park's boat (/use), the dispute links that let the crew or the
 * customer act on a job (/d), and the one-tap job actions (/a /c /x /fix
 * /paid). Whoever holds the link IS the person, so the string arriving in the
 * path is an untrusted credential and gets checked before it reaches a query.
 *
 * WHY A SHARED MODULE RATHER THAN A CONSTANT IN EACH FILE. This regex already
 * existed twice — amenity-guest-server.ts had it, and disputes.ts had nothing
 * at all and passed the raw path segment straight into `.eq()`. Two copies of
 * a rule is the same disease as a rule enforced in eight hand-written places:
 * the copies agree right up until somebody changes one. Kept pure (no
 * `server-only`) so tests can reach it — the same split that park-rates.ts
 * needed for the same reason.
 *
 * WHAT IT ALLOWS: hex, 32 to 96 characters. 32 is one `randomUUID()` with the
 * dashes taken out, which is what mints a dispute token; the ceiling leaves
 * room for a longer token without a code change. Case-insensitive because a
 * URL that has been through a mail client is not guaranteed to come back in
 * the case it left in.
 */
export const BEARER_TOKEN = /^[0-9a-f]{32,96}$/i;

/** True when `tok` could be one of our tokens. Never throws; null-safe. */
export function isBearerToken(tok: string | null | undefined): boolean {
  return typeof tok === "string" && BEARER_TOKEN.test(tok);
}
