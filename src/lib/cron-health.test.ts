import { describe, it, expect, vi } from "vitest";

/**
 * A JOB THAT NEVER RAN MUST NOT READ LIKE ONE THAT RAN LATE.
 *
 * Both are "not working", and a single shared sentence would pass an
 * absence-only test — which is exactly the collapse this file exists to
 * refuse. Every case below asserts the branch it wants AND asserts that the
 * other branch's wording is absent, so merging the two makes two tests fail.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => { throw new Error("no database in this test"); } }));

const { cronAlarms, WATCHED_JOBS } = await import("./cron-health");
type CronRunRow = import("./cron-health").CronRunRow;
type JobExpectation = import("./cron-health").JobExpectation;

// The nightly's own moment: 0 0 * * * UTC is 8pm at the lakes the day before.
const NOW = "2026-09-30T00:05:00Z";
const TODAY = "2026-09-29";

const EXP: JobExpectation[] = [{
  job: "seasonal",
  label: "the 8am seasonal run",
  maxAgeHours: 36,
  consequence: "the freeze warning will not go out",
}];

/** A healthy row: ran at 8am this lake day, twelve hours before the check. */
const row = (o: Partial<CronRunRow> = {}): CronRunRow => ({
  job: "seasonal",
  lastStartedAt: "2026-09-29T12:00:00Z",
  lastFinishedAt: "2026-09-29T12:00:09Z",
  lastOk: true,
  lastError: null,
  ...o,
});

describe("absence is louder than lateness", () => {
  it("gives never-ran and ran-late DIFFERENT sentences", () => {
    const never = cronAlarms([], EXP, NOW, TODAY);
    const late = cronAlarms(
      [row({ lastStartedAt: "2026-09-20T12:00:00Z", lastFinishedAt: "2026-09-20T12:00:09Z" })],
      EXP, NOW, TODAY,
    );
    expect(never, "no row at all is an alarm").toHaveLength(1);
    expect(late, "nine days stale is an alarm").toHaveLength(1);
    // BOTH WAYS. Each branch must carry its own wording and NOT the other's;
    // one shared string would satisfy a test that only checked for non-empty.
    expect(never[0]).toMatch(/NEVER been recorded running/);
    expect(late[0]).not.toMatch(/NEVER been recorded running/);
    expect(late[0]).toMatch(/has not run since September 20, 2026/);
    expect(never[0]).not.toMatch(/has not run since/);
    expect(never[0]).not.toEqual(late[0]);
  });

  it("counts the days in words a person reads, not an ISO string", () => {
    const late = cronAlarms(
      [row({ lastStartedAt: "2026-09-20T12:00:00Z", lastFinishedAt: "2026-09-20T12:00:09Z" })],
      EXP, NOW, TODAY,
    );
    expect(late[0]).toContain("9 days ago");
    expect(late[0]).not.toContain("2026-09-20");
  });

  it("a run twelve hours ago is not an alarm at all", () => {
    expect(cronAlarms([row()], EXP, NOW, TODAY)).toEqual([]);
  });

  it("claimed the morning and never came back is its own case", () => {
    // last_ok is STILL TRUE here — it is the column default, and the finish
    // stamp never landed. That is the whole trap: without finished_at this
    // row reads as a clean run.
    const r = cronAlarms(
      [row({ lastStartedAt: "2026-09-25T12:00:00Z", lastFinishedAt: null, lastOk: true })],
      EXP, NOW, TODAY,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/started on September 25, 2026 and never finished/);
  });

  it("but a run that started ten minutes ago is simply still going", () => {
    expect(cronAlarms(
      [row({ lastStartedAt: "2026-09-29T23:55:00Z", lastFinishedAt: null })],
      EXP, NOW, TODAY,
    )).toEqual([]);
  });

  it("a recent run that failed reports its OWN reason, not one we invent", () => {
    const r = cronAlarms(
      [row({ lastOk: false, lastError: "the lakes and their season dates: connection terminated" })],
      EXP, NOW, TODAY,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("connection terminated");
  });

  it("every alarm says what nobody is getting while it is down", () => {
    const stale = [row({ lastStartedAt: "2026-09-01T12:00:00Z", lastFinishedAt: "2026-09-01T12:00:09Z" })];
    const dead = [row({ lastStartedAt: "2026-09-01T12:00:00Z", lastFinishedAt: null })];
    const failed = [row({ lastOk: false, lastError: "boom" })];
    for (const rows of [[] as CronRunRow[], stale, dead, failed]) {
      const lines = cronAlarms(rows, EXP, NOW, TODAY);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toContain("the freeze warning will not go out");
    }
  });
});

describe("the watch list", () => {
  it("does NOT contain the nightly — it cannot watch itself", () => {
    // A job that checks its own liveness always passes, which is worse than
    // no check: it makes the digest say somebody looked. The nightly's
    // dead-man is park_machine_runs (0079), read on /park/today.
    expect(WATCHED_JOBS.map((j) => j.job)).not.toContain("nightly");
    expect([...WATCHED_JOBS.map((j) => j.job)].sort()).toEqual(["intraday", "seasonal"]);
  });

  it("every watched job names a consequence and a ceiling", () => {
    for (const j of WATCHED_JOBS) {
      expect(j.consequence.length, `${j.job} must say what is lost`).toBeGreaterThan(20);
      expect(j.maxAgeHours).toBeGreaterThan(0);
    }
  });
});
