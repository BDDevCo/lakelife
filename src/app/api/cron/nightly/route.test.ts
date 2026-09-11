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
  remindExpiringStays: vi.fn(async () => ({ ok: true, skipped: [] })),
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
const SECRET = "cron_test_secret";
const run = () => {
  process.env.CRON_SECRET = SECRET;
  return GET(new Request("https://lakelife.test/api/cron/nightly", { headers: { authorization: `Bearer ${SECRET}` } }));
};
const digestArg = (): DigestArg => vi.mocked(auto.sendNightlyDigest).mock.calls[0][0];

beforeEach(() => {
  vi.mocked(auto.sendNightlyDigest).mockClear();
});

describe("the nightly hands dispatch's standing state to the digest", () => {
  it("passes unfilled, dead-end services and crews reached through", async () => {
    const res = await run();
    expect(res.status).toBe(200);
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
