import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A DEAD CRON AND A QUIET NIGHT LOOK IDENTICAL.
 *
 * At 21 lots with nothing booked, most nights genuinely have nothing in them,
 * so "no digest email" is the healthy state AND the failure state. The ops
 * console had no answer to "is the machine running" at all; the park owner's
 * morning screen had one, framed as that park's bookkeeping check.
 *
 * Every branch below is pinned in BOTH directions — the alarm arm and the
 * quiet arm — because a test that only asserts an alarm appears still passes
 * when the condition is collapsed to `true`.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));

const { automationVerdict, WINDOW_NIGHTS } = await import("@/app/ops/automation-health");

type Health = Parameters<typeof automationVerdict>[0];
type Run = NonNullable<Health["runs"]>[number];

const TODAY = "2026-09-30";

const health = (over: Partial<Health> = {}): Health => ({
  today: TODAY,
  runs: [],
  recorders: 1,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  runner: "reconcile",
  runOn: "2026-09-29",
  ok: true,
  error: null,
  finishedAt: "2026-09-30T00:00:17.922Z",
  ...over,
});

describe("a failed read is not an empty one", () => {
  it("null runs says we couldn't check, and names why", () => {
    const v = automationVerdict(health({ runs: null, error: "connection reset" }));
    expect(v.state).toBe("unreadable");
    expect(v.alarm).toContain("couldn't check");
    expect(v.alarm).toContain("connection reset");
    expect(v.line).toBe("");
  });

  it("COLLAPSED THE OTHER WAY: the same call with rows present is NOT an alarm", () => {
    const v = automationVerdict(health({ runs: [run()] }));
    expect(v.state).toBe("fresh");
    expect(v.alarm).toBeNull();
  });
});

describe("no rows has two different reasons and they get different sentences", () => {
  it("nothing exists that would write a record — silence proves nothing", () => {
    const v = automationVerdict(health({ runs: [], recorders: 0 }));
    expect(v.state).toBe("no-recorder");
    expect(v.alarm).toContain("Nothing is recording");
  });

  it("something SHOULD be writing them and nothing has — the schedule is dead", () => {
    const v = automationVerdict(health({ runs: [], recorders: 1 }));
    expect(v.state).toBe("never_ran");
    expect(v.alarm).toContain(String(WINDOW_NIGHTS));
  });

  it("a FAILED park count must not explain a dead cron away", () => {
    // recorders null = we could not rule it out. It must NOT take the
    // "nothing would record it" exit, which would excuse the silence.
    const v = automationVerdict(health({ runs: [], recorders: null }));
    expect(v.state).toBe("never_ran");
    expect(v.alarm).not.toBeNull();
  });
});

describe("a run that didn't finish is not a run", () => {
  it("claimed the night and died partway", () => {
    const v = automationVerdict(health({ runs: [run({ finishedAt: null })] }));
    expect(v.state).toBe("started_never_finished");
    expect(v.alarm).toContain("never finished");
  });

  it("COLLAPSED THE OTHER WAY: the same row WITH a finished_at is healthy", () => {
    const v = automationVerdict(health({ runs: [run()] }));
    expect(v.alarm).toBeNull();
  });

  it("finished every night but errored every night is its own sentence", () => {
    const v = automationVerdict(health({
      runs: [run({ ok: false, error: "boom" }), run({ runOn: "2026-09-28", ok: false, error: "boom" })],
    }));
    expect(v.state).toBe("failing");
    expect(v.alarm).toContain("reconcile");
    expect(v.goodNights).toBe(0);
  });
});

describe("the date a person reads, and counts rather than shares", () => {
  it("stale names the last night that finished, in words", () => {
    const v = automationVerdict(health({ runs: [run({ runOn: "2026-09-26" })] }));
    expect(v.state).toBe("stale");
    expect(v.alarm).toContain("September 26, 2026");
    expect(v.alarm).not.toContain("2026-09-26");
  });

  it("a healthy window counts nights and prints no percentage", () => {
    const v = automationVerdict(health({
      runs: [run(), run({ runOn: "2026-09-28" }), run({ runOn: "2026-09-27" })],
    }));
    expect(v.alarm).toBeNull();
    expect(v.goodNights).toBe(3);
    expect(v.line).toContain(`3 of the last ${WINDOW_NIGHTS} nights`);
    expect(v.line).not.toContain("%");
    expect(v.line).toContain("September 29, 2026");
  });

  it("two parks on one night are ONE night, not two", () => {
    const v = automationVerdict(health({ runs: [run(), run()] }));
    expect(v.goodNights).toBe(1);
  });

  it("a runner that threw is an alarm even on a night that finished", () => {
    const v = automationVerdict(health({
      runs: [run(), run({ ok: false, error: "boom" })],
    }));
    expect(v.state).toBe("fresh");
    expect(v.alarm).toContain("reconcile");
    expect(v.brokenRunners).toEqual(["reconcile"]);
  });
});

describe("the panel has a caller", () => {
  const PAGE = fileURLToPath(new URL("./page.tsx", import.meta.url));
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("/ops renders it and loads it — not just imports it", () => {
    const src = stripComments(readFileSync(PAGE, "utf8"));
    expect(src).toContain("getAutomationHealth()");
    expect(src).toContain("<OpsAutomationHealth");
    expect(src).toContain("automationVerdict(automation)");
  });

  it("PROVE THE SCANNER WORKS: a commented-out embed does not count", () => {
    expect(stripComments("{/* <OpsAutomationHealth verdict={v} /> */}"))
      .not.toContain("<OpsAutomationHealth");
    expect(stripComments("// getAutomationHealth()"))
      .not.toContain("getAutomationHealth()");
  });
});
