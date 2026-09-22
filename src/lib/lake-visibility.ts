/**
 * WHICH LAKES LAKELIFE ADVERTISES — one predicate, one doorway.
 *
 * ============================================================================
 * THE DEFECT
 * ============================================================================
 * `findOrCreateLake` (lib/lake-birth.ts) lets a CUSTOMER typing "my lake isn't
 * listed", or a CREW widening its service area, insert a `lakes` row. That is
 * deliberate and it stays: demand is how the next market gets found, and a
 * person who cannot name their own water cannot be set up at all.
 *
 * What was not deliberate is where that row then appeared. Every public
 * surface asked the same, single question — `is_fixture = false` — which means
 * "this is not one of our own scratch rows" and nothing whatsoever about
 * whether LakeLife has agreed to work there. So the moment somebody typed
 * "Adamm Lake" into the set-up wizard, the typo was on the front page's hero
 * chip, in /lakes, on its own indexable /lakes/[slug] landing page complete
 * with a priced menu, in sitemap.xml, and — since 64e798c — on the Open Graph
 * card that rides into every shared link. One person's typing became the
 * brand's own claim about where it works, with nobody at LakeLife in between.
 *
 * ============================================================================
 * WHY NO MIGRATION
 * ============================================================================
 * The sentence "a lake LakeLife serves" was already expressible and nobody was
 * asking it: `lakes.source` is 'ops' when somebody at LakeLife put the row
 * there, and 'customer' or 'crew' when demand did. Verified on production on
 * 22 September 2026 — all three real lakes carry source = 'ops',
 * season_confirmed = true, is_fixture = false, and the column is NOT NULL with
 * a CHECK constraining it to exactly those three words.
 *
 * So served = "not a fixture, AND somebody at LakeLife put it there", and
 * promotion is that same column moving to 'ops' (ops/actions.ts).
 *
 * ============================================================================
 * WHY A MATCH OBJECT RATHER THAN TWO `.eq()` CALLS
 * ============================================================================
 * The rule lives in ONE doorway or it is not a rule. Two chained `.eq()` calls
 * are two things a reader can take half of, and half of this one — the half
 * that was already there — is the defect. `.match(SERVED_LAKE_MATCH)` is a
 * single call carrying the whole predicate, so a new public reader either has
 * it or visibly does not. lake-visibility.test.ts scans for exactly that.
 *
 * ============================================================================
 * WHAT THIS IS NOT FOR
 * ============================================================================
 * NOT for a customer's own lake. A homeowner on an unpromoted lake keeps their
 * property, their ice-out and pull-deadline gates and their booking — those
 * readers reach the row through `properties.lake_id` and must never ask this
 * question. The gate decides what LakeLife ADVERTISES, never what a person who
 * is already here can do. See the "this person's own data" half of
 * lake-visibility.test.ts, which pins that both ways.
 */

/** `lakes.source` on a lake somebody at LakeLife put there. */
export const SERVED_LAKE_SOURCE = "ops";

/**
 * The filter for a `lakes` query on a public surface: `.match(SERVED_LAKE_MATCH)`.
 * One call, so it cannot be half-applied.
 */
export const SERVED_LAKE_MATCH = { is_fixture: false, source: SERVED_LAKE_SOURCE };

/** The columns a caller must have selected before `isServedLake` can answer. */
export const SERVED_LAKE_COLUMNS = "is_fixture, source";

/** Just enough of a `lakes` row to decide. Loose on purpose: callers hand this
 *  rows straight off supabase-js, which types every column as `unknown`. */
export interface LakeServingFacts {
  is_fixture?: unknown;
  source?: unknown;
}

/**
 * Does LakeLife say, in public, that it works on this lake?
 *
 * STRICTLY `=== false`, never `!== true`. A caller who forgot to select
 * `is_fixture` hands us `undefined`, and `!== true` would read that absence as
 * a fact and publish the lake. Absence fails closed here; the worst case is a
 * real lake missing from a chip, which ops can see and fix, rather than a
 * stranger's typo on the front page, which nobody would.
 */
export function isServedLake(lake: LakeServingFacts | null | undefined): boolean {
  if (!lake) return false;
  return lake.is_fixture === false && lake.source === SERVED_LAKE_SOURCE;
}

/**
 * A real lake that demand created and nobody at LakeLife has agreed to yet —
 * the queue the ops screen and the nightly digest name.
 *
 * `source !== 'ops'` rather than a list of the two values the CHECK allows
 * today: a fourth source added later is then automatically something ops is
 * asked about, instead of a row that is neither served nor waiting and so
 * appears on no screen at all.
 */
export function isAwaitingPromotion(lake: LakeServingFacts | null | undefined): boolean {
  if (!lake) return false;
  return lake.is_fixture === false && lake.source !== SERVED_LAKE_SOURCE;
}

/**
 * Whole days since the row was created, for "how long has this been waiting".
 *
 * NULL, NEVER ZERO, when the timestamp is missing or unparseable. Zero is a
 * real answer — a lake named this morning — and handing it back for "we do not
 * know" would put a brand-new lake and an unreadable one in the same sentence
 * at the bottom of the ops queue. The renderer says which it got.
 */
export function daysWaiting(createdAt: string | null | undefined, now: Date): number | null {
  if (!createdAt) return null;
  const born = new Date(createdAt);
  const t = born.getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * "waiting 4 days" — the phrase both the ops card and the digest use, so the
 * screen and the email cannot start counting differently. No date in it on
 * purpose: a duration is the thing that makes somebody act.
 */
export function waitingWords(days: number | null): string {
  if (days === null) return "waiting — we couldn't work out how long";
  if (days === 0) return "named today";
  if (days === 1) return "waiting 1 day";
  return `waiting ${days} days`;
}
