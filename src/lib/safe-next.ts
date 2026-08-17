/**
 * WHERE A SIGN-IN IS ALLOWED TO SEND SOMEBODY.
 *
 * A resident arriving at /parks/claim with a slip, or at /parks/welcome from
 * an invite link, has to sign in first — and until now that lost her place
 * entirely. Carrying a destination through the sign-in fixes that, and the
 * destination is the dangerous part: it ends up in an OAuth `redirectTo`, so
 * anything that could name another host is an open redirect with LakeLife's
 * name on the front of it.
 *
 * SO THE RULE IS A PATH ON THIS SITE, OR NOTHING. Not "a URL we like the look
 * of" — parsing and then judging a URL is how open redirects get written. A
 * value either starts with a single slash and continues with an ordinary path
 * character, or it is refused and the caller falls back to its own default.
 */

/**
 * `//evil.com` is protocol-relative and loads another site. `/\evil.com` is
 * the same trick with the slash that some parsers normalise. `/%2f...` and any
 * control character are the encoded versions. Everything else that begins with
 * one slash is a path here.
 */
const SAFE = /^\/(?![/\\])[^\s\x00-\x1f]*$/;

/**
 * The destination, or null when there isn't a usable one.
 *
 * Null rather than a default, because the right fallback differs by caller: a
 * new sign-up belongs at /verify and a returning sign-in at /portal, and this
 * function has no business knowing either.
 */
export function safeNext(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (!SAFE.test(s)) return null;
  // A second decode pass: `/%2F%2Fevil.com` survives the test above and is
  // `//evil.com` by the time a browser acts on it.
  try {
    const once = decodeURIComponent(s);
    if (once !== s && !SAFE.test(once)) return null;
  } catch {
    return null; // malformed escapes are not a destination
  }
  return s;
}
