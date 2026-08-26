/**
 * EVERY PATH WHERE THE URL IS THE CREDENTIAL.
 *
 * Two files needed this list and both wrote it out by hand — the `X-Robots-Tag`
 * matcher in next.config.ts and the disallow list in src/app/robots.ts — and
 * both called it closed ("the seven paths where the URL IS the credential").
 * Then an eighth was added and neither knew.
 *
 * That eighth was /doc, which 302s to a lease naming a household, its rent and
 * its address. robots.txt allows by default, so the new path was affirmatively
 * CRAWLABLE, and the response carried no noindex. Worse than the leak: the
 * route stamps `opened_at` on the way through, so a crawler arriving at a
 * pasted link would have written a false "Opened" into the park's delivery log
 * — the one record that exists to be relied on.
 *
 * So the list lives here once and both files derive from it, and a test fails
 * when a `src/app/<something>/[token]` directory is not in it. A ninth path
 * cannot be forgotten the same way.
 *
 * WHAT EACH ONE IS:
 *   use   a guest booking the park's boat
 *   d     a dispute — the token authorises acting as the crew or the customer
 *   a c x fix paid   one-tap actions on a job
 *   doc   a park document delivered to a household
 */
export const TOKEN_PATHS = [
  "use", "d", "a", "c", "x", "fix", "paid", "doc",
] as const;

/** For the `source:` matcher in next.config.ts. */
export const TOKEN_PATH_PATTERN = `/:path(${TOKEN_PATHS.join("|")})/:rest*`;

/** For the disallow list in robots.ts. */
export const TOKEN_PATH_DISALLOW = TOKEN_PATHS.map((p) => `/${p}/`);
