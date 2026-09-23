import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WHAT THE NIGHTLY HANDS THE DIGEST — tested through the real handler, with
 * every step mocked, so the wiring under test is the wiring that runs.
 *
 * Two things had to be true and were not:
 *  - dispatch's result (unfilled jobs, dead-end services, crews reached) never
 *    reached sendNightlyDigest at all, so the repeating dead-end SMS was ops'
 *    only signal about unfilled work;
 *  - every entry pushed into `failures` — a thrown step, a per-item skip, a
 *    settle that refused, a park finding — arrived unlabelled, and the digest
 *    called all of them "steps [that] failed ... did not run".
 */

vi.mock("server-only", () => ({}));

/** The slice of sendNightlyDigest's input these tests read. */
interface DigestArg {
  dispatch?: { unfilled: number; deadEnd?: string[]; crewsNotified?: number };
  failures?: Array<{ step: string; error: string; kind?: string }>;
}

const auto = {
  runRouteBuild: vi.fn(async () => { throw new Error("routes: connection terminated"); }),
  revalidateAssignments: vi.fn(async () => ({
    ok: true, checked: 3, rehomed: 0, unfilled: 2, crewsTexted: 1, crewsNotified: 1, deadEnd: ["Snow plowing"],
    skipped: ["Couldn't re-check the crew on one job (j9) — it keeps the crew it has."],
  })),
  recordNoShows: vi.fn(async () => ({ ok: true, flagged: 0, skipped: [] })),
  sendNightBeforeReminders: vi.fn(async () => ({ ok: true })),
  reconcileUnsettledJobs: vi.fn(async () => ({ ok: true, settled: 0, capped: 0, skipped: 1, failures: ["Job j2: not settled — no card on file."] })),
  reconcileCancelledFees: vi.fn(async () => ({ ok: true, collected: 0, skipped: [] })),
  sendCoiRevalidations: vi.fn(async () => ({ ok: true })),
  generateAutopilotProposals: vi.fn(async () => ({ ok: true, skipped: [] })),
  demoteLakeStrikes: vi.fn(async () => ({ ok: true, skipped: [] })),
  selfHealCrewBases: vi.fn(async () => ({ ok: true, skipped: [] })),
  sweepWaitlist: vi.fn(async () => ({ ok: true, skipped: [] })),
  expireUnfilledJobs: vi.fn(async () => ({ ok: true, skipped: [] })),
  resolveRushFallbacks: vi.fn(async () => ({ ok: true })),
  matureReferralEarnings: vi.fn(async () => ({ ok: true, credited: 0, skipped: [] })),
  runReferralPayoutBatch: vi.fn(async () => ({ ok: true, beneficiaries: 0, total: 0, skipped: [] })),
  runNudges: vi.fn(async () => ({ ok: true, skipped: [] })),
  birthSpringJobs: vi.fn(async () => ({ ok: true, skipped: [] })),
  overstayNotices: vi.fn(async () => ({ ok: true, sent: 0, skipped: [] })),
  runMonthlyPayoutBatches: vi.fn(async () => ({ ok: true, batches: 0, total: 0, skipped: [] })),
  sweepStrandedPayoutBatches: vi.fn(async () => ({ ok: true, skipped: [] })),
  runFillInDigest: vi.fn(async () => ({ ok: true, sent: 0, skipped: [] })),
  gapSlaAlerts: vi.fn(async () => ({ ok: true, alerted: 0, skipped: [] })),
  reconcileRefunds: vi.fn(async () => ({ orphansCleared: 0, flipsCompleted: 0 })),
  learnServiceDurations: vi.fn(async () => ({ changes: [] })),
  autoApplyPriceSuggestions: vi.fn(async () => ({ changes: [], skipped: [] })),
  sendNightlyDigest: vi.fn(async (_results: DigestArg) => ({ ok: true, sent: 1, skipped: [] })),
  remindExpiringStays: vi.fn(async () => ({ ok: true, reminded: 0, unreached: 0, refused: { inherited: 0, lot_taken: 0, no_rate: 0, other: 0 }, skipped: [] })),
  proposeOverdueFees: vi.fn(async () => ({ proposed: 0, skipped: 0 })),
  raiseTripFees: vi.fn(async () => ({ paid: 0, total: 0, onUs: 0 })),
  tipsCollectedSinceLastNight: vi.fn(async () => ({ count: 0, total: 0 })),
};
vi.mock("@/lib/automation", () => auto);
vi.mock("@/lib/rent-changes", () => ({ applyDueRentChangesFor: vi.fn(async () => ({ applied: 0 })) }));
vi.mock("@/lib/park-machine", () => ({
  runParkNightly: vi.fn(async () => ({ ok: true, parks: 1, findings: 1, errors: [], urgent: ["The Haven: 3 occupied lots have no bill for September 2026"] })),
}));
vi.mock("@/lib/disputes", () => ({ sweepDisputeDeadlines: vi.fn(async () => ({ fired: 0, escalated: 0 })) }));

const { GET } = await import("./route");
const { runParkNightly } = await import("@/lib/park-machine");
const SECRET = "cron_test_secret";
const run = () => {
  process.env.CRON_SECRET = SECRET;
  return GET(new Request("https://lakelife.test/api/cron/nightly", { headers: { authorization: `Bearer ${SECRET}` } }));
};
const digestArg = (): DigestArg => vi.mocked(auto.sendNightlyDigest).mock.calls[0][0];

beforeEach(() => {
  vi.mocked(auto.sendNightlyDigest).mockClear();
  vi.mocked(runParkNightly).mockClear();
});

/** Every argument sendNightlyDigest was called with, in order. */
const digestArgs = (): DigestArg[] => vi.mocked(auto.sendNightlyDigest).mock.calls.map((c) => c[0]);

describe("the nightly hands dispatch's standing state to the digest", () => {
  it("passes unfilled, dead-end services and crews reached through", async () => {
    const res = await run();
    // 500, and it is the fixture that says why: `routes` throws in it. This
    // asserted 200 — pinning the behaviour that let a night where every step
    // died read as green in Vercel's cron log, which is the only place a
    // night's outcome is recorded without anybody building anything.
    expect(res.status).toBe(500);
    expect(auto.sendNightlyDigest).toHaveBeenCalledTimes(1);
    expect(digestArg().dispatch).toMatchObject({ unfilled: 2, deadEnd: ["Snow plowing"], crewsNotified: 1 });
  });
});

describe("every entry in the needs-a-look list says what kind of thing it is", () => {
  it("a thrown step is failed; a per-item skip and a settle refusal are skipped; a park finding is found", async () => {
    await run();
    const f = digestArg().failures ?? [];
    const kindOf = (step: string, error: RegExp) => f.find((x) => x.step === step && error.test(x.error))?.kind;
    expect(kindOf("routes", /connection terminated/)).toBe("failed");
    expect(kindOf("dispatch", /re-check the crew/)).toBe("skipped");
    expect(kindOf("reconcile", /not settled/)).toBe("skipped");
    expect(kindOf("park", /occupied lots have no bill/)).toBe("found");
    expect(f.filter((x) => !x.kind), "nothing reaches the digest unlabelled").toEqual([]);
  });

  it("and no push into that list can be added without a label", () => {
    // Match the CALL. Comments stripped first, so the prose explaining the
    // rule cannot satisfy it; then every `failures.push(` in the route must
    // carry a kind in its literal — except the one nightly-rules.test.ts pins
    // verbatim inside noteSkips, which is stamped on the lines after it.
    const src = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const calls = [...src.matchAll(/failures\.push\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(calls.length, "the scanner still finds the pushes").toBeGreaterThanOrEqual(4);
    const unlabelled = calls.filter((a) => !/kind: "(failed|skipped|found)"/.test(a));
    expect(unlabelled).toEqual(["{ step: name, error: s }"]);
    expect(src).toMatch(/kind = "skipped"/);
  });
});

/**
 * THE PARK MACHINE REPORTS ITS DEATHS RATHER THAN THROWING THEM.
 *
 * `step()` only ever sees a throw, and runParkNightly never throws: a failed
 * parks read returns { ok:false, errors:[…] } and every per-park death is
 * caught into the same array. So the step came back looking perfectly
 * ordinary, `park.errors` had no reader anywhere, and the machine could die on
 * every park, every night, while this email said "Quiet night".
 */
describe("a park check that did not run reaches the person who could fix it", () => {
  it("every park error lands in the needs-a-look list, labelled failed", async () => {
    vi.mocked(runParkNightly).mockResolvedValueOnce({
      ok: false, parks: 2, findings: 0,
      errors: ["The Haven: park_lots: connection terminated unexpectedly"],
      urgent: [],
    });

    const res = await run();
    const f = digestArg().failures ?? [];
    const park = f.filter((x) => x.step === "park");
    expect(park, "the error is in the list the digest reads").toHaveLength(1);
    expect(park[0].error).toContain("connection terminated");
    expect(park[0].kind, "a check that did not run is failed, never found").toBe("failed");
    expect(res.status, "and a night with a dead step answers 500").toBe(500);
  });

  it("a standing finding is still found, and a healthy night is still 200", async () => {
    // The park machine's urgent findings — "N occupied lots have no bill" — are
    // a HEALTHY night's output. Counting them as failures would pin the alarm
    // permanently red at The Haven, which is how an alarm stops being read.
    vi.mocked(auto.runRouteBuild).mockResolvedValueOnce({ ok: true, skipped: [] } as never);
    vi.mocked(auto.revalidateAssignments).mockResolvedValueOnce({
      ok: true, checked: 0, rehomed: 0, unfilled: 0, crewsTexted: 0, crewsNotified: 0, deadEnd: [], skipped: [],
    } as never);
    vi.mocked(auto.reconcileUnsettledJobs).mockResolvedValueOnce({ ok: true, settled: 0, capped: 0, skipped: 0, failures: [] } as never);

    const res = await run();
    const f = digestArg().failures ?? [];
    expect(f.every((x) => x.kind === "found"), "only standing findings tonight").toBe(true);
    expect(f.length).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    expect((await res.json()).ok, "a finding is not a failure").toBe(true);
  });
});

/**
 * ONE NIGHT'S LIST BELONGS TO THAT NIGHT.
 *
 * `failures` used to live at module scope, cleared at the top of every run. A
 * route handler's module scope is shared across concurrent invocations, so two
 * overlapping runs shared one array and the second run's reset erased the
 * first's collected failures mid-flight — both digests then reported a clean
 * night. The route exports POST and documents ?date= for manual backfills, so
 * the overlap is reachable, and it is reachable exactly on the night somebody
 * re-runs the cron BECAUSE the scheduled one looked wrong.
 */
describe("two runs in flight do not erase each other's failures", () => {
  it("each run's digest gets its own list", async () => {
    // Suspend run A inside the park step, start run B to completion, then let
    // A finish: the classic interleaving, with A's failures already collected.
    let release: () => void = () => {};
    const suspended = new Promise<void>((r) => { release = r; });
    vi.mocked(runParkNightly).mockImplementationOnce(async () => {
      await suspended;
      return { ok: true, parks: 1, findings: 0, errors: [], urgent: [] };
    });

    const runA = run();
    const resB = await run();
    release();
    const resA = await runA;

    const [first, second] = digestArgs();
    expect(digestArgs(), "both runs reported").toHaveLength(2);
    expect(first.failures, "two runs, two lists — never one array").not.toBe(second.failures);
    for (const arg of digestArgs()) {
      const routes = (arg.failures ?? []).filter((x) => x.step === "routes");
      expect(routes, "its own thrown step, once").toHaveLength(1);
    }
    expect(resA.status).toBe(500);
    expect(resB.status).toBe(500);
  });
});
