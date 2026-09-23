/**
 * WHICH LAKES A CREW TICKS IS A SILENT GATE, AND THE SENTENCE THAT SAYS SO
 * LIVES HERE — ONCE.
 *
 * `canEverDo` drops a crew from every job on a lake they have not ticked, with
 * no error on their screen. A plough contractor in LaGrange County does not
 * think of himself as working "Pretty Lake" — but The Haven, a mobile-home
 * park, is on it. Guess wrong at the wizard and no work ever arrives.
 *
 * THERE ARE TWO LAKE DOORS, NOT ONE. The onboarding wizard's step, and
 * `/vendor/availability` — which is the ONLY place a crew who has already gone
 * live can change the answer. The wizard got the honest copy first and the
 * live editor kept "Tap the lakes your crew works", so the sentence that would
 * have saved Josh disappeared the moment he went live. A rule in one doorway
 * of two is not a rule; both import from here.
 *
 * The park clause is DERIVED from the parks rows, never written down, so park
 * #2 on Big Turkey names itself the day it is created.
 */

/** The gate, said out loud. True on both doors, in the same words. */
export const LAKE_GATE_SENTENCE =
  "We only send you jobs on the lakes you tick — an untapped lake is one you never hear about.";

/**
 * "Pretty Lake includes The Haven", or null.
 *
 * A lake with no park gets NO sentence: a label saying "parks count too" on a
 * lake that has none is noise, and noise is what stops the sentence being read
 * on the lake where it matters.
 */
export function parkNote(
  lakeName: string,
  lakeId: string,
  parksByLake: Record<string, string[]> | null,
): string | null {
  // A FAILED READ IS NOT "NO PARKS". Saying nothing is the honest outcome —
  // the sentence is an ADDITION to the copy, so its absence misleads nobody,
  // where inventing "this lake has no parks" would.
  if (!parksByLake) return null;
  const names = (parksByLake[lakeId] ?? []).filter((n) => n.trim().length > 0);
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${lakeName} includes ${list}`;
}

/**
 * The whole park clause for a list of lakes, or null when no lake has a park
 * (and null when the parks read failed, via `parkNote`).
 *
 * Returned as ONE string so both doors render identical words; a caller that
 * joined the notes itself is how the two would drift apart again.
 */
export function parkClause(
  lakes: { id: string; name: string }[],
  parksByLake: Record<string, string[]> | null,
): string | null {
  const notes = lakes
    .map((l) => parkNote(l.name, l.id, parksByLake))
    .filter((s): s is string => !!s);
  if (notes.length === 0) return null;
  return `Mobile-home and RV parks count too: ${notes.join("; ")}.`;
}
