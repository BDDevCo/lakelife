/**
 * THE SHAPE OF A BEARER TOKEN — one module, so the rules cannot drift.
 *
 * Several links in this app carry their authority in the URL: the guest link
 * that books a park's boat (/use), the dispute links that let the crew or the
 * customer act on a job (/d), and the one-tap job actions (/a /c /x /fix
 * /paid). Whoever holds the link IS the person, so the string arriving in the
 * path is an untrusted credential and gets checked before it reaches a query.
 *
 * WHY A SHARED MODULE RATHER THAN A CONSTANT IN EACH FILE. The regex already
 * existed twice — amenity-guest-server.ts had it, and disputes.ts had nothing
 * at all and passed the raw path segment straight into `.eq()`. Two copies of
 * a rule is the same disease as a rule enforced in eight hand-written places:
 * the copies agree right up until somebody changes one. Kept pure (no
 * `server-only`) so tests can reach it — the same split that park-rates.ts
 * needed for the same reason.
 *
 * WHY THERE IS MORE THAN ONE SHAPE HERE, AND WHY THAT IS NOT THE IDEA FAILING.
 *
 * This module first shipped as ONE regex — hex, 32 to 96 — on the claim that
 * every loader could share it. It cannot. The app mints four structurally
 * different credentials, and a single hex-32 rule silently refuses two:
 *
 *   dispute   disputes.crew_token / customer_token    32 hex
 *   payment   park_payments.confirm_token             40 hex
 *   sticker   park_lots.qr_token                      20 hex        <- under the 32 floor
 *   extend    lot_reservations.extend_token           'x' + 32 hex  <- not hex at all
 *
 * The sticker is `randomUUID()` cut to 20 (park/request-actions.ts) and the
 * extend token is minted with a literal 'x' in front (automation.ts). Pointing
 * the old rule at either loader would have rejected every token already
 * printed on a pedestal or already sent in a text — a validator that refuses
 * the real credentials is a worse bug than the missing check it replaced.
 *
 * A FIFTH LIVES OUTSIDE THIS MODULE ON PURPOSE. job_confirmations.confirm_token
 * is a Postgres `gen_random_uuid()` (0026), so it arrives DASHED and the /c/
 * routes match `/^[0-9a-f-]{36}$/i` of their own. Migrating it would mean
 * re-minting live links for no security gain. It is named here so the next
 * person finds it by reading this file rather than by breaking that route.
 *
 * So the shared thing is the MODULE, not one regex: one place to look, one
 * place to change, and each shape states what it actually is.
 */

/**
 * Hex, 20 to 96 characters, case-insensitive.
 *
 * The floor is 20 because that is the shortest credential the app mints (the
 * QR sticker), not because 20 is enough entropy for everything — see
 * `DEFAULT_MIN`. Case-insensitive because a URL that has been through a mail
 * client is not guaranteed to come back in the case it left in.
 */
export const BEARER_TOKEN = /^[0-9a-f]{20,96}$/i;

/**
 * THE FLOOR IS A SEPARATE QUESTION FROM THE SHAPE, and this is why.
 *
 * Widening the regex so the 20-char sticker fits must not quietly halve the
 * entropy demanded of every other caller. If `isBearerToken` simply matched
 * the widened regex, the dispute loader — which passes no length at all —
 * would have started accepting 20-char tokens the moment the sticker was
 * accommodated, and nothing on screen or in a test would have said so.
 *
 * So the default stays at 32 (one `randomUUID()` with the dashes out) and the
 * one caller with a shorter token asks for it BY NAME.
 */
export const DEFAULT_MIN = 32;

/** The QR sticker on the pedestal: `randomUUID()`, dashes out, cut to 20. */
export const STICKER_MIN = 20;

/**
 * True when `tok` could be one of our hex tokens. Never throws; null-safe.
 *
 * `minLength` defaults to DEFAULT_MIN. Pass STICKER_MIN at the one call site
 * whose credential is genuinely shorter.
 */
export function isBearerToken(
  tok: string | null | undefined,
  minLength: number = DEFAULT_MIN,
): boolean {
  return typeof tok === "string" && BEARER_TOKEN.test(tok) && tok.length >= minLength;
}

/**
 * The extend-stay link: a literal 'x' followed by 32 hex.
 *
 * `remindExpiringStays` mints it as `` `x${randomUUID().replace(/-/g,"")}` ``
 * (src/lib/automation.ts). The prefix is the whole reason this needs its own
 * rule: no hex-only pattern can ever match it, so the honest options were a
 * validator that fits the token or a migration that re-mints every extend link
 * already sitting in somebody's messages. This is the first one.
 */
export const EXTEND_TOKEN = /^x[0-9a-f]{32}$/i;

/** True when `tok` could be an extend-stay token. Never throws; null-safe. */
export function isExtendToken(tok: string | null | undefined): boolean {
  return typeof tok === "string" && EXTEND_TOKEN.test(tok);
}
