import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { mustRead } from "@/lib/must-read";
import { todayLakeDate, lakeDaysSince, lakeDateOf } from "@/lib/booking";
import { dayInWords } from "@/app/park/park-helpers";

/**
 * DID THE OTHER SCHEDULES ACTUALLY RUN?
 *
 * Three things are scheduled, and until 0186 only one of them left a trace.
 *
 * The NIGHTLY proves itself already: its park step claims a park_machine_runs
 * row (0079) before it works, and /park/today turns absence into an alarm on
 * the screen when the owner opens it. That direction is deliberate and it is
 * right — an alert sent BY the scheduler cannot fire when the scheduler is the
 * thing that died. park/machine-helpers.ts makes the argument in full.
 *
 * The other two proved nothing at all:
 *
 *   * /api/cron/seasonal — Vercel, `0 12 * * *`, 8am at the lakes. On the ~362
 *     days a year when no lake's pull deadline is exactly 14 days out,
 *     sendSeasonalPullReminders returns {ok:true, lakes:0, emailed:0} at its
 *     first branch and the route writes nowhere. That is the same shape a job
 *     which stopped firing in March produces — except that one produces no
 *     response at all, and nothing was looking for one. The cost lands once:
 *     the single date per lake per year when the freeze warning goes out, and
 *     by then the silence is eight months old and the send is never retried.
 *
 *   * /api/cron/intraday — Supabase pg_cron, every 30 minutes, calling back
 *     into Vercel through pg_net (0023). Its result is JSON nothing in this
 *     repo reads. A DIFFERENT RAIL from the two above, which is why the
 *     nightly watching it is worth anything: pg_cron and Vercel Cron fail
 *     separately, so this is a genuine cross-rail watch and not a job marking
 *     its own homework.
 *
 * WHY THE NIGHTLY IS THE READER, AND WHY IT IS NOT IN THE LIST. It runs at 8pm
 * at the lakes, twelve hours after the seasonal run of the SAME lake day, so
 * "seasonal has not stamped" is answerable without window arithmetic. It
 * cannot ask the same question about itself — a self-check that always passes
 * is worse than none, because it makes the screen say somebody looked — so
 * `nightly` is deliberately absent from WATCHED_JOBS and its liveness stays
 * where it already works.
 *
 * Between the two: /park/today catches the whole Vercel rail stopping; this
 * catches one job on it stopping, and the pg_cron rail stopping. Neither
 * covers the other, and neither is redundant.
 */

/** A row of cron_runs, in the app's words. */
export interface CronRunRow {
  job: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOk: boolean;
  lastError: string | null;
}

export interface JobExpectation {
  job: string;
  /** How the owner would name it, not how the route is spelled. */
  label: string;
  /** Older than this and it has stopped. */
  maxAgeHours: number;
  /** What nobody is getting while it is down. Every alarm ends in this. */
  consequence: string;
}

/**
 * NOT `nightly`. See the note above: it cannot watch itself, and
 * park_machine_runs already watches it from the screen. cron-health.test.ts
 * pins that absence, because adding it here would look like a fix.
 */
export const WATCHED_JOBS: readonly JobExpectation[] = [
  {
    job: "seasonal",
    label: "the 8am seasonal run",
    // It fires twelve hours before this check, every lake day. Thirty-six
    // hours is one clean miss plus room for a slow morning — not three days,
    // because the thing it sends cannot be sent late.
    maxAgeHours: 36,
    consequence:
      "nothing is watching for a lake whose pull deadline is two weeks out, so the " +
      "freeze warning — one email per lake per year, never retried — will not go out",
  },
  {
    job: "intraday",
    label: "the half-hourly heartbeat",
    maxAgeHours: 3,
    consequence:
      "a job waiting on a crew is not being re-tried between nightlies, and a rush " +
      "job's pre-chosen fallback is not being run",
  },
];

/**
 * ABSENCE IS LOUDER THAN LATENESS.
 *
 * A job with NO ROW has never been recorded running once — either it has never
 * fired since this was switched on, or its stamp is broken. That is a
 * different and worse fact than a job that ran on Tuesday and not since, and
 * the two get different sentences on purpose: collapsing them is the exact
 * shape that let the texting outage read as a quiet summer.
 *
 * PURE. `rows`, `now` and `today` all come from the caller, so this is
 * testable without a database — and so that deciding a read failed is the
 * caller's job, not this function's. An empty `rows` here means "the read
 * came back empty", never "the read failed"; checkCronHealth guarantees that.
 */
export function cronAlarms(
  rows: readonly CronRunRow[],
  expectations: readonly JobExpectation[],
  nowISO: string,
  today: string,
): string[] {
  const byJob = new Map(rows.map((r) => [r.job, r] as const));
  const alarms: string[] = [];
  const now = Date.parse(nowISO);

  for (const e of expectations) {
    const row = byJob.get(e.job);

    // THE LOUD ONE. No row at all: nobody has ever seen this job alive.
    if (!row) {
      alarms.push(
        `${capitalise(e.label)} has NEVER been recorded running — not once. ` +
        `While it is down, ${e.consequence}.`,
      );
      continue;
    }

    const started = row.lastStartedAt ? Date.parse(row.lastStartedAt) : null;
    const finished = row.lastFinishedAt ? Date.parse(row.lastFinishedAt) : null;

    // Started and never came back. `lastOk` is still sitting on its default of
    // true here, which is precisely how a killed run reads as a good one.
    if (started !== null && (finished === null || finished < started)) {
      if (now - started > e.maxAgeHours * 3_600_000) {
        alarms.push(
          `${capitalise(e.label)} started on ${whenInWords(row.lastStartedAt!)} and ` +
          `never finished. While it is down, ${e.consequence}.`,
        );
      }
      // Under the ceiling it is simply still going. Not an alarm.
      continue;
    }

    if (finished === null) continue; // unreachable, but never guess

    if (now - finished > e.maxAgeHours * 3_600_000) {
      const days = lakeDaysSince(row.lastFinishedAt!, today);
      alarms.push(
        `${capitalise(e.label)} has not run since ${whenInWords(row.lastFinishedAt!)}` +
        `${days > 0 ? ` — ${days} day${days === 1 ? "" : "s"} ago` : ""}. ` +
        `While it is down, ${e.consequence}.`,
      );
      continue;
    }

    // Recent, but it ended badly. Its OWN reason, never one we invent —
    // 0186's check constraint guarantees there is one.
    if (!row.lastOk) {
      alarms.push(
        `${capitalise(e.label)} ran and failed: ${row.lastError ?? "no reason recorded"}. ` +
        `While it is down, ${e.consequence}.`,
      );
    }
  }
  return alarms;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A timestamptz as the day a person reads — "September 25, 2026".
 *
 * Converted to the LAKE calendar day first. A stamp written at 8pm Indiana is
 * already tomorrow in UTC, so slicing the string would name the wrong day in
 * an alarm whose whole job is to say when somebody last looked.
 */
function whenInWords(iso: string): string {
  return dayInWords(lakeDateOf(iso) ?? iso.slice(0, 10));
}

/**
 * THE WRITER. Every column in cron_runs is written here and nowhere else.
 *
 * FAILS TOWARD THE ALARM, NOT AWAY FROM IT. This is telemetry, and it must
 * never take down the freeze warning it exists to watch — so a write that
 * refuses is logged and swallowed. The consequence of swallowing is that the
 * row goes stale and the nightly raises an alarm for a job that is in fact
 * running: a false alarm, in the safe direction, that a person can resolve in
 * a minute. The opposite trade — throwing here — would mean a broken stamp
 * silences the very send it was added to guard.
 */
export async function stampCronRun(
  job: string,
  phase: "started" | "finished",
  outcome?: { ok: boolean; error?: string | null },
): Promise<void> {
  try {
    const admin = createServiceClient();
    const now = new Date().toISOString();
    if (phase === "started") {
      // Clears last_finished_at on purpose: from this instant until the finish
      // stamp, the row honestly says "begun, not back".
      const { error } = await admin.from("cron_runs").upsert(
        { job, last_started_at: now, last_finished_at: null, last_ok: true, last_error: null },
        { onConflict: "job" },
      );
      if (error) console.error(`[cron stamp failed] ${job} started:`, error.message);
      return;
    }
    const ok = outcome?.ok ?? true;
    const { error } = await admin.from("cron_runs").update({
      last_finished_at: now,
      last_ok: ok,
      // 0186 refuses ok=false with no reason. Say SOMETHING rather than lose
      // the whole stamp to a check violation and look like a job that hung.
      last_error: ok ? null : (outcome?.error || "the run reported a failure with no message"),
    }).eq("job", job);
    if (error) console.error(`[cron stamp failed] ${job} finished:`, error.message);
  } catch (e) {
    console.error(`[cron stamp failed] ${job} ${phase}:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * THE READER, called from the nightly — the only caller.
 *
 * A FAILED READ IS NOT AN EMPTY ONE. `mustRead` throws on a refused query, so
 * a cron_runs read that fails reaches the nightly's step() and lands in the
 * digest as a named failure. Returning [] here instead would have reported
 * BOTH watched jobs as never having run: a confident, frightening alarm built
 * on no data at all.
 */
export async function checkCronHealth(): Promise<{ alarms: string[]; rows: CronRunRow[] }> {
  const admin = createServiceClient();
  const data = mustRead(
    "the scheduled jobs' last runs",
    await admin
      .from("cron_runs")
      .select("job, last_started_at, last_finished_at, last_ok, last_error"),
  );
  const rows: CronRunRow[] = (data ?? []).map((r) => ({
    job: r.job as string,
    lastStartedAt: (r.last_started_at as string) ?? null,
    lastFinishedAt: (r.last_finished_at as string) ?? null,
    lastOk: (r.last_ok as boolean) ?? true,
    lastError: (r.last_error as string) ?? null,
  }));
  return {
    alarms: cronAlarms(rows, WATCHED_JOBS, new Date().toISOString(), todayLakeDate()),
    rows,
  };
}
