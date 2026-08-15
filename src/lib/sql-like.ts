/**
 * AN EMAIL ADDRESS IS NOT A SEARCH PATTERN.
 *
 * `.ilike(column, value)` sends `value` to Postgres as a LIKE PATTERN, where
 * `_` means "any single character" and `%` means "any run of characters". Nine
 * places in this app looked somebody up by an address they control, and every
 * one of them handed that address straight to `.ilike()`.
 *
 * WHAT THAT COST. Ops invites `crew.mow@outlook.com`. A stranger registers the
 * real, working address `crew_mow@outlook.com` — underscores are legal, every
 * provider allows them — signs in once, and `invite_email ILIKE
 * 'crew_mow@outlook.com'` matches the invite. They get the crew's route, their
 * jobs and their payout account, and the real crew can never claim the invite
 * because the app now sees it as taken. Nothing has to be intercepted; the
 * attacker only needs to know an address that is usually painted on the truck.
 *
 * The identity fix before this one made the email come from the SESSION rather
 * than from an argument, which was right and did not help: the session email is
 * still the pattern. Proving who you are does not stop you being a wildcard.
 *
 * THE FIRST ANSWER IS NOT TO PATTERN-MATCH AT ALL. Every `invite_email` column
 * is written by us and lower-cased on the way in (crews-invite, import-helpers,
 * contractor-actions), so those lookups use `.eq()` — exact, with no pattern
 * engine anywhere near them. That is the strongest fix available and it is what
 * the two exploitable paths got.
 *
 * THIS HELPER IS FOR THE REST. `users.email` is synced from Supabase auth
 * (migration 0003), so this repo cannot promise what case it is stored in, and
 * those lookups have to stay case-insensitive. They keep `ilike` and escape the
 * pattern characters instead. They are also not the security holes — they are
 * "does this address already have an account" checks, where a wrong match
 * refuses an invite rather than handing one over.
 *
 * WHY `*` IS IN THE ESCAPE SET. PostgREST accepts `*` as an alias for `%` in a
 * like/ilike filter, so an unescaped `*` would become a wildcard before SQL
 * ever sees it. Escaped, it degrades to a literal `%` and simply fails to
 * match. That is the right direction to fail in: a lookup that finds nobody is
 * an inconvenience, a lookup that finds the wrong person is this bug.
 */

/** LIKE/ILIKE metacharacters, plus PostgREST's `*` alias for `%`. */
const LIKE_META = /[\\%_*]/g;

/**
 * Make `value` match itself and nothing else inside a LIKE/ILIKE pattern.
 * Never throws; a non-string returns the empty string, which matches no row.
 */
export function likeLiteral(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(LIKE_META, "\\$&");
}
