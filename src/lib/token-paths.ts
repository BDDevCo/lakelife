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
 * when a `[token]` directory ANYWHERE under src/app is not in it.
 *
 * THE FIRST VERSION OF THAT TEST READ ONE LEVEL. It listed src/app, asked each
 * child whether it had a `[token]` child of its own, and stopped. So the ninth
 * path — src/app/api/ics/[token], a personal calendar feed that returns an
 * account's upcoming services and the addresses they happen at to anyone
 * holding the URL — was invisible to the check written to make a ninth path
 * unforgettable, and the test stayed green while it sat outside the fence.
 * The scanner walks the tree now, and an entry here is a URL path, not a
 * top-level folder name.
 *
 * WHAT EACH ONE IS:
 *   use   a guest booking the park's boat
 *   d     a dispute — the token authorises acting as the crew or the customer
 *   a c x fix paid   one-tap actions on a job
 *   doc   a park document delivered to a household
 *   api/ics  the personal calendar feed a phone subscribes to
 */
export const TOKEN_PATHS = [
  "use", "d", "a", "c", "x", "fix", "paid", "doc", "api/ics",
] as const;

/**
 * What every token-bearing response carries.
 *
 * Held here because it is applied at TWO doorways, and one of them is not
 * next.config.ts. A route handler builds its own Response, so a feed that is
 * noindexed only by config is noindexed only for as long as that config layer
 * is in the path — this way the .ics 200 carries the header itself and the
 * config rule is the second lock, not the only one.
 */
export const TOKEN_PATH_HEADERS: Record<string, string> = {
  // robots.txt asks a crawler not to FETCH. This tells it not to INDEX what it
  // fetched anyway, and a token URL does not have to be crawled to be found —
  // it leaks by referrer, by link preview, by being pasted somewhere public,
  // and a crawler arriving by one of those never consulted robots.txt for it.
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  // Do not hand the token to whatever the response links out to.
  "Referrer-Policy": "no-referrer",
};

/**
 * One `source:` matcher per path, for next.config.ts.
 *
 * This was a single `/:path(use|d|…)/:rest*` alternation, which CANNOT express
 * a nested path: a `/` inside that capture is not a matcher Next will honour,
 * so registering `api/ics` in it would have matched nothing, gone green, and
 * left the feed exactly as exposed as before. One rule each, no alternation.
 */
export const TOKEN_PATH_SOURCES = TOKEN_PATHS.map((p) => `/${p}/:rest*`);

/** For the disallow list in robots.ts. */
export const TOKEN_PATH_DISALLOW = TOKEN_PATHS.map((p) => `/${p}/`);
