/**
 * WHO IS ON THE LAND TODAY — the arithmetic behind the visits board and the
 * one line Today borrows from it.
 *
 * The board (visits-data getSiteVisits) used to split its rows into Today /
 * Coming up / Last 30 days inline, so when Today needed "N crews on site" it
 * would have grown a second copy of the same split. Both read this file now:
 * the split, the placeholder the view coalesces a missing crew to, and the
 * one sentence.
 *
 * Plain module, no supabase: the loaders pass rows in and read answers out.
 */

/**
 * What the view park_site_visits prints when a job has nobody assigned yet
 * (0137 coalesces the vendor name to this). ONE copy — visits-data imports it
 * — because "Crew to be assigned" is a placeholder, not a company, and the
 * count below must know that string to leave it out.
 */
export const UNASSIGNED_CREW = "Crew to be assigned";

/** Thirty days back is enough to answer "was that truck last Tuesday ours?"
 *  without turning into a history of the tenants. */
export const RECENT_DAYS = 30;

function daysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The board's three buckets. `upcoming` keeps the order given (the loader
 * asks the database for ascending dates); `recent` is newest first, because
 * "last Tuesday" is nearer the top of his mind than a month ago.
 */
export function splitVisits<T extends { date: string }>(
  all: readonly T[],
  today: string,
): { today: T[]; upcoming: T[]; recent: T[] } {
  const cutoffISO = daysBefore(today, RECENT_DAYS);
  return {
    today: all.filter((v) => v.date === today),
    upcoming: all.filter((v) => v.date > today),
    recent: all.filter((v) => v.date < today && v.date >= cutoffISO).reverse(),
  };
}

/**
 * How many TRUCKS, not how many jobs. A crew with two jobs in the park is one
 * truck in the drive; a job nobody is assigned to yet is nobody in the drive.
 */
export function crewsOnSite(todayRows: readonly { crew: string }[]): number {
  const names = new Set<string>();
  for (const r of todayRows) {
    if (r.crew && r.crew !== UNASSIGNED_CREW) names.add(r.crew);
  }
  return names.size;
}

/** The sentence Today links to the board. Null at zero — a zero line never exists. */
export function crewsOnSiteLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 crew on site today — see who" : `${n} crews on site today — see who`;
}
