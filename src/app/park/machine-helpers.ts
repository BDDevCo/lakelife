/**
 * IS THE MACHINE ALIVE, AND WHAT IS IT ALLOWED TO DO?
 *
 * THE PROBLEM THIS SOLVES IS THAT A DEAD CRON AND A QUIET NIGHT LOOK THE SAME.
 * At a 21-lot park most nights genuinely have nothing in them, so "no email,
 * nothing on the screen" is the normal, healthy state — and it is also exactly
 * what a scheduler that stopped running three weeks ago produces. Without a
 * positive record of having looked, silence is unreadable.
 *
 * So every run writes a row saying it ran, and the SCREEN decides whether that
 * is recent enough. That direction matters: an alert sent BY the scheduler
 * cannot fire when the scheduler is the thing that died. The dead-man line is
 * computed when he opens the page, from data, so it works precisely in the case
 * it exists for.
 *
 * EMPTY AND ERRORED ARE DIFFERENT VALUES. A job that checked twenty households
 * and found nothing wrong, and a job that threw on its first query, both report
 * zero. Collapsing them is how a broken check hides for a season.
 */

export type Liveness = "fresh" | "stale" | "never_ran";

export interface RunRow {
  runner: string;
  runOn: string;
  ok: boolean;
  error: string | null;
  found: number;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * A run that ERRORED is not a run. It is the absence of a check wearing the
 * costume of one, which is worse than nothing because it looks like coverage.
 */
export function liveness(runs: readonly RunRow[], today: string): Liveness {
  const good = runs.filter((r) => r.ok);
  if (good.length === 0) return "never_ran";
  const latest = good.reduce((m, r) => (r.runOn > m ? r.runOn : m), good[0].runOn);
  return daysBetween(latest, today) <= 1 ? "fresh" : "stale";
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pretty(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY[dt.getUTCDay()]} ${d} ${
    ["January","February","March","April","May","June","July",
     "August","September","October","November","December"][m - 1]
  }`;
}

export interface LivenessLine {
  state: Liveness;
  /** The quiet footer when everything is fine. */
  line: string;
  /** Set only when the check is NOT running — this becomes an undismissable task. */
  alarm: string | null;
  /** Runners that errored on the most recent night, named. */
  brokenRunners: string[];
}

export function livenessLine(
  runs: readonly RunRow[],
  today: string,
  checkedLabels: readonly string[],
): LivenessLine {
  const state = liveness(runs, today);
  const latestOn = runs.length
    ? runs.reduce((m, r) => (r.runOn > m ? r.runOn : m), runs[0].runOn)
    : null;
  // Only the most recent night's failures matter — an error three weeks ago
  // that has since gone away is history, not an alarm.
  const brokenRunners = runs
    .filter((r) => !r.ok && r.runOn === latestOn)
    .map((r) => r.runner);

  if (state === "never_ran") {
    return {
      state,
      line: "The evening check hasn't run yet.",
      alarm:
        "Nothing has been checked automatically yet. Everything below was " +
        "worked out just now, when you opened this.",
      brokenRunners,
    };
  }

  if (state === "stale") {
    const good = runs.filter((r) => r.ok);
    const latestGood = good.reduce((m, r) => (r.runOn > m ? r.runOn : m), good[0].runOn);
    return {
      state,
      line: `Last checked ${pretty(latestGood)}.`,
      alarm:
        `Nothing has been checked since ${pretty(latestGood)} — the evening ` +
        `check hasn't run. Everything below was worked out just now, when you ` +
        `opened this.`,
      brokenRunners,
    };
  }

  const label = checkedLabels.length ? checkedLabels.join(", ") : "nothing set up yet";
  return {
    state,
    line: `Checked last night — ${label}.`,
    // A runner that threw is an alarm even on a fresh night. Its silence is
    // not the same as its finding nothing.
    alarm: brokenRunners.length
      ? `Part of last night's check failed (${brokenRunners.join(", ")}). ` +
        `Anything it would have found is missing from this screen.`
      : null,
    brokenRunners,
  };
}

// --------------------------------------------------------- what it may do --

/**
 * THE CEILING ON EACH JOB, frozen in code rather than held in a settings row.
 *
 * A dial that can be turned up is a dial somebody turns up at 11pm on the night
 * they are tired of clicking. These are not preferences; they are the boundary
 * between what the machine may do alone and what it may only prepare.
 *
 *   'act'    — may complete the work unattended.
 *   'draft'  — may prepare it and put it on the screen. A human sends it.
 *   'watch'  — may only report what it saw.
 *
 * `chase_household` is 'draft' and there is no code path that raises it. An
 * automatic chase reaches the households on email and leaves the paper third
 * accruing arrears unwarned, so the failure mode selects against exactly the
 * residents least able to absorb it. That is not a tuning decision.
 */
export type Ceiling = "act" | "draft" | "watch";

export const JOB_CEILING: Record<string, Ceiling> = {
  // Safe because the DATABASE refuses an unserved increase (0061), not because
  // the code is careful. That is the bar for 'act'.
  apply_rent_change: "act",
  // Reads and writes sentences. Its worst outcome is a wrong line on a screen.
  reconcile: "watch",
  liveness: "watch",
  owner_email: "act",
  // Preparing the packet is the labour; sending it is the consequence.
  chase_household: "draft",
  renew_agreement: "draft",
  serve_notice: "draft",
  record_payment: "draft",
  resolve_claim: "draft",
};

export function mayAct(job: string): boolean {
  return JOB_CEILING[job] === "act";
}
