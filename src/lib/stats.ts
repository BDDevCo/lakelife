/**
 * The importer's median and lake-standing's are now this one. There were
 * three: lake-standing (base-pin self-heal), learning (duration dials), and
 * one written for the importer's rate-card scale — with two different
 * answers for an empty list. Two of them are this now, with the honest
 * answer: no values, no median. `learning.ts` keeps its own, whose empty
 * answer is 0 and is pinned by its tests, until its owner moves it.
 */

/** Median of a list (average of the middle two for even counts); null on empty. */
export function median(values: readonly number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
