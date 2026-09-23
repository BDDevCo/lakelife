/**
 * CREW STANDING — a derived STATUS, never a stored score. Pure, no imports.
 *
 * Brendon, 23 September 2026, in order:
 *   "then all crews should start out somewhere nuetral because we wont have
 *    data in to rate them."
 *   "we also dont want to hinder any crews from onboarding and staying on the
 *    platform right away, so maybe its a feature we toggle on at a later
 *    saturation date."
 *
 * So this SHIPS OFF (platform_settings.crew_standing_public, default 0). Until
 * he turns it on the offers screen shows price and days and nothing else —
 * which is his original list minus the part nothing can yet support. The crew
 * bench is the commercial blocker, every crew on it is new, and a screen that
 * silently sorts newcomers to the bottom costs him the crews he is recruiting.
 *
 * ================= WHY A STATUS AND NOT A NUMBER =================
 *
 * A neutral VALUE stops being neutral the day somebody earns a real one. Start
 * everyone at 3 stars and day one is fair, because everyone has it. On day
 * ninety a crew nobody has hired still reads "3.0 — average" next to Josh's
 * twelve real jobs, and the platform is now judging a business that has never
 * worked for us. That is this codebase's "default that asserts a fact" — the
 * pre-ticked "they signed" box that wrote 19 leases nobody signed.
 *
 * "New to LakeLife" is true on day one and STILL TRUE on day ninety. It is the
 * only sentence about an unworked crew that never becomes a lie.
 *
 * It is also why this is DERIVED on every read rather than stored: a stored
 * standing is a column with a writer nobody remembers, and the day the writer
 * stops firing the number stays on the screen looking maintained.
 *
 * ================= WHAT IT IS NOT =================
 *
 * NOT the private ops score (lib/scoring.ts). That one prints 50 for a crew
 * nobody has complained about, measures on-time behaviour and flag accuracy
 * rather than whether the work was any good, and its own file says it is never
 * public and never a leaderboard. Publishing it would print a number nobody
 * gave where a rating goes.
 *
 * NOT a rating. There are zero customer ratings and zero thumbs rows in
 * production. A real average is a LATER question and this file does not answer
 * it: `completedJobs` is a COUNT of finished work, which is a fact we hold.
 */

/** What the offers screen may print about a crew — words, never a score. */
export interface CrewStanding {
  /** The headline: "New to LakeLife", or "12 jobs completed". */
  label: string;
  /** Where the work was, when there is any. Null for a crew with none. */
  detail: string | null;
  /** True while this crew has completed nothing — the sort/badge can use it
   *  without re-parsing the sentence above. */
  isNew: boolean;
}

/** The facts standing is derived from. Both come off completed jobs. */
export interface CrewWorkRecord {
  /** Jobs this crew has taken to `complete`. Counted, never averaged. */
  completedJobs: number;
  /** Lake names those jobs were on, already de-duplicated by the loader. */
  lakeNames: string[];
}

/** "Big Long", "Big Long and Pretty", "Big Long, Pretty and Big Turkey". */
function lakeList(names: string[]): string {
  const clean = names.map((n) => (n ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * The whole rule.
 *
 *   no completed jobs -> "New to LakeLife"
 *   some              -> the count, and which lakes
 *
 * A NEGATIVE OR NON-FINITE COUNT IS TREATED AS NONE. A count arriving as NaN
 * is a failed read that got past its guard, and "New to LakeLife" is the one
 * answer that cannot overstate a crew's record.
 */
export function deriveStanding(record: CrewWorkRecord): CrewStanding {
  const n = Number(record?.completedJobs);
  const done = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (done === 0) {
    return {
      label: "New to LakeLife",
      detail: null,
      isNew: true,
    };
  }
  const lakes = lakeList(record?.lakeNames ?? []);
  return {
    label: `${done} job${done === 1 ? "" : "s"} completed`,
    // NAMED, not counted: "on Big Long and Pretty" answers the question a
    // person actually has, which is whether this crew knows their water.
    detail: lakes ? `on ${lakes}` : null,
    isNew: false,
  };
}

/**
 * WHAT TURNING THE DIAL ON WOULD PRINT — the flip must not be blind.
 *
 * He named the risk himself: hindering crews from onboarding AND STAYING. So
 * the ops control has to show, BEFORE the flip, how many active crews would
 * read "New to LakeLife" and how many carry real work. Trigger on DATA, not on
 * a calendar date — a date can arrive with the bench still thin, and flipping
 * it then does the exact harm he is avoiding.
 */
export interface StandingPreview {
  /** Active, non-fixture crews considered. */
  crews: number;
  /** How many would print a completed-work count. */
  withWork: number;
  /** How many would print "New to LakeLife". */
  newToLakeLife: number;
  /** Lakes that any worked crew has completed a job on, for the sentence. */
  lakes: string[];
}

export function summarisePreview(records: CrewWorkRecord[]): StandingPreview {
  const list = records ?? [];
  const worked = list.filter((r) => !deriveStanding(r).isNew);
  const lakes = [...new Set(worked.flatMap((r) => (r.lakeNames ?? []).map((n) => (n ?? "").trim()).filter(Boolean)))];
  lakes.sort();
  return {
    crews: list.length,
    withWork: worked.length,
    newToLakeLife: list.length - worked.length,
    lakes,
  };
}

/**
 * The sentence the ops control prints above the switch. No invented numbers —
 * every figure here is a count of rows.
 */
export function previewSentence(p: StandingPreview): string {
  if (p.crews === 0) {
    return "No active crews yet, so turning this on would print nothing anywhere. It is the crew bench, not the calendar, that decides when this is safe to switch on.";
  }
  if (p.withWork === 0) {
    return `All ${p.crews} active crew${p.crews === 1 ? "" : "s"} would read "New to LakeLife" — none has completed a job yet. Turning it on today tells every buyer that nobody here has ever worked, which is the thing you said you did not want to do to crews who are still settling in.`;
  }
  const where = p.lakes.length ? ` on ${lakeList(p.lakes)}` : "";
  return `${p.withWork} of ${p.crews} active crews would show completed work${where}; the other ${p.newToLakeLife} would read "New to LakeLife". Switch on when enough of the bench has a record that the label stops being a penalty — that is a question about the data on this line, not about the date.`;
}
