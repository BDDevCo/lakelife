import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { liveness } from "@/app/park/machine-helpers";
import { addDays } from "@/app/park/today-helpers";
import { dayInWords } from "@/app/park/park-helpers";

/**
 * IS THE MACHINE STILL RUNNING?
 *
 * A DEAD CRON AND A QUIET NIGHT LOOK IDENTICAL, and at 21 lots with no jobs
 * booked most nights genuinely have nothing in them. The nightly's only report
 * is an email; when it stops arriving, the absence is the same absence a
 * healthy quiet night produces. That is the exact shape that hid the SMS
 * outage from 19 July to 16 August.
 *
 * WHERE THE HEARTBEAT COMES FROM TODAY. The nightly's own `failures` list is
 * assembled in memory and posted into an email and an HTTP response; nothing
 * persists it. The ONE durable trace a nightly run leaves is the row the park
 * evening check writes in `park_machine_runs` (migration 0079) — and that step
 * is the LAST of the twenty-seven, at nightly/route.ts:183, immediately before
 * the digest. Every step is wrapped so it cannot abort the run, so a row with
 * `ok` and a `finished_at` is proof the invocation reached the end and was not
 * killed by the 300s ceiling.
 *
 * IT CANNOT SAY WHICH EARLIER STEP FAILED, and the panel says so out loud
 * rather than implying a clean run. When the dedicated cron-stamp table lands,
 * only `getAutomationHealth` below changes: `automationVerdict` and the panel
 * read `AutomationHealth`, which names no table.
 *
 * THE DIRECTION MATTERS. This is computed when he opens the page, from data.
 * An alarm sent BY the scheduler cannot fire when the scheduler is what died.
 */

/** How many nights back the panel looks. Counts, never a percentage. */
export const WINDOW_NIGHTS = 8;

/** One recorded run. Deliberately not `RunRow` — /ops has no use for findings. */
export interface AutomationRun {
  runner: string;
  runOn: string;
  ok: boolean;
  error: string | null;
  /** Null means it claimed the night and died partway — NOT a night that ran. */
  finishedAt: string | null;
}

export interface AutomationHealth {
  /** The lake date the verdict is measured against. */
  today: string;
  /**
   * NULL MEANS THE READ FAILED, never "no runs". An empty array is a real
   * answer (nothing ran); null is the absence of an answer, and the two get
   * different sentences.
   */
  runs: AutomationRun[] | null;
  /**
   * How many things exist that would stamp a run at all. Today that is the
   * parks count, because the park evening check is the only stamping step —
   * `runParkNightly` iterates every row of `parks` with no fixture filter, so
   * this counts the same way its writer does. Null means THAT read failed, and
   * a failed count must not let a guard pass: it is treated as "can't rule it
   * out", which lands on the alarm side.
   */
  recorders: number | null;
  error?: string;
}

export type AutomationState =
  /** We could not ask. Not a yes and not a no. */
  | "unreadable"
  /** Nothing exists that would write a run record, so silence proves nothing. */
  | "no-recorder"
  /** Something should be writing records and nothing has, all window. */
  | "never_ran"
  /** Rows exist, every one claimed a night and died before finishing. */
  | "started_never_finished"
  /** Rows exist and finished, every one with an error. */
  | "failing"
  /** It finished, but not recently enough. */
  | "stale"
  /** It finished last night (or tonight). The only healthy answer. */
  | "fresh";

export interface AutomationVerdict {
  state: AutomationState;
  /**
   * Set whenever the run CANNOT be shown as healthy — including when we could
   * not check. Null is reserved for a finished, clean, recent run.
   */
  alarm: string | null;
  /** The quiet footer. Only ever non-empty when `alarm` is null. */
  line: string;
  /** Distinct nights in the window that finished cleanly. A count. */
  goodNights: number;
  /** Runners that errored on the most recent recorded night, by name. */
  brokenRunners: string[];
}

/** Pure. Given what we read, what may this screen say? */
export function automationVerdict(h: AutomationHealth): AutomationVerdict {
  // A FAILED READ IS NOT AN EMPTY ONE. The one thing this panel may never do
  // is look like a clean bill of health on a question nobody answered.
  if (h.runs === null) {
    return {
      state: "unreadable",
      alarm:
        "We couldn't check whether the nightly run happened" +
        (h.error ? ` — ${h.error}.` : ".") +
        " This panel is not saying it is fine.",
      line: "",
      goodNights: 0,
      brokenRunners: [],
    };
  }

  const good = h.runs.filter((r) => r.ok && r.finishedAt != null);
  const goodNights = new Set(good.map((r) => r.runOn)).size;

  if (h.runs.length === 0) {
    // TWO DIFFERENT REASONS FOR NO ROWS, and collapsing them would put a false
    // alarm on a brand-new install. `recorders === 0` is the only one of the
    // two that is not an alarm about the scheduler — but it is still an alarm,
    // because it means this panel is blind.
    if (h.recorders === 0) {
      return {
        state: "no-recorder",
        alarm:
          "Nothing is recording whether the nightly run happens. The only step " +
          "that leaves a record is the park evening check, and there is no park " +
          "for it to check — so silence here proves nothing either way.",
        line: "",
        goodNights: 0,
        brokenRunners: [],
      };
    }
    return {
      state: "never_ran",
      alarm:
        `No nightly run has finished in the last ${WINDOW_NIGHTS} nights. ` +
        "Either the schedule has stopped or the run is dying before its last step.",
      line: "",
      goodNights: 0,
      brokenRunners: [],
    };
  }

  const latestOn = h.runs.reduce((m, r) => (r.runOn > m ? r.runOn : m), h.runs[0].runOn);
  // Deduped: with a second park there is one row per park per night, and the
  // same runner name failing twice is one broken runner, not two.
  const brokenRunners = [
    ...new Set(h.runs.filter((r) => !r.ok && r.runOn === latestOn).map((r) => r.runner)),
  ];

  if (good.length === 0) {
    const failed = [...new Set(h.runs.filter((r) => !r.ok).map((r) => r.runner))];
    if (failed.length > 0) {
      return {
        state: "failing",
        alarm:
          `The nightly run has finished with an error every night in the last ` +
          `${WINDOW_NIGHTS} (${failed.join(", ")}). The last one was ` +
          `${dayInWords(latestOn)}.`,
        line: "",
        goodNights: 0,
        brokenRunners,
      };
    }
    return {
      state: "started_never_finished",
      alarm:
        `The nightly run started on ${dayInWords(latestOn)} and never finished. ` +
        "A run that claims the night and dies partway leaves the rest of the " +
        "night undone, and the digest email does not go out.",
      line: "",
      goodNights,
      brokenRunners,
    };
  }

  const lastGoodOn = good.reduce((m, r) => (r.runOn > m ? r.runOn : m), good[0].runOn);

  // The SAME decision the park owner's morning screen makes, from the same
  // function, so the two screens cannot disagree about whether it is alive.
  if (liveness(h.runs, h.today) === "stale") {
    return {
      state: "stale",
      alarm:
        `The nightly run last finished on ${dayInWords(lastGoodOn)}. ` +
        "A night it does not finish is a night the routes, the night-before " +
        "reminders and the digest email may not have gone out.",
      line: "",
      goodNights,
      brokenRunners,
    };
  }

  return {
    state: "fresh",
    // A runner that threw is an alarm even on a night that finished. Its
    // silence is not the same as its finding nothing.
    alarm: brokenRunners.length
      ? `Part of the nightly run failed on ${dayInWords(latestOn)} ` +
        `(${brokenRunners.join(", ")}). Anything it would have found is ` +
        "missing from this console."
      : null,
    line:
      `Last finished ${dayInWords(lastGoodOn)}. ` +
      `${goodNights} of the last ${WINDOW_NIGHTS} nights finished.`,
    goodNights,
    brokenRunners,
  };
}

/** Reads the heartbeat. Every failure path returns a shape that alarms. */
export async function getAutomationHealth(): Promise<AutomationHealth> {
  const today = todayLakeDate();
  const admin = createServiceClient();

  const [runsRes, recordersRes] = await Promise.all([
    admin
      // ONE LITERAL. A select built from concatenated pieces comes back as
      // GenericStringError on every column.
      .from("park_machine_runs")
      .select("runner, run_on, ok, error, finished_at")
      .gte("run_on", addDays(today, -(WINDOW_NIGHTS - 1)))
      .order("run_on", { ascending: false }),
    admin.from("parks").select("id", { count: "exact", head: true }),
  ]);

  // A FAILED COUNT MUST NOT MAKE A GUARD PASS. Null, never 0 — 0 is the one
  // value that would send the verdict down the "nothing would record it"
  // branch and explain away a dead cron.
  const recorders = recordersRes.error ? null : (recordersRes.count ?? null);
  if (recordersRes.error) {
    console.error("[ops] automation health: park count failed", recordersRes.error.message);
  }

  if (runsRes.error) {
    console.error("[ops] automation health read failed", runsRes.error.message);
    return { today, runs: null, recorders, error: runsRes.error.message };
  }

  const runs: AutomationRun[] = (runsRes.data ?? []).map((r) => ({
    runner: String(r.runner ?? "unnamed"),
    runOn: String(r.run_on),
    // `=== true`, not `!== false`: a value that is not plainly true belongs on
    // the alarm side, not on the side that says the night was fine.
    ok: r.ok === true,
    error: (r.error as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  }));

  return { today, runs, recorders };
}
