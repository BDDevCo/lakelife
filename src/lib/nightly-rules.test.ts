import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE THREE RULES THE NIGHTLY LIVES BY.
 *
 * automation.ts runs at 00:00 UTC with nobody watching. A wrong sentence on a
 * screen gets noticed; a wrong decision here does not. These are the rules that
 * kept being broken, each one written after it actually happened:
 *
 *  1. NEVER ABORT A RUN FOR ONE ITEM. runRouteBuild deleted every route row for
 *     the date, then `return`ed mid-loop when one vendor's insert failed —
 *     leaving EVERY REMAINING CREW with no route at all for the next day.
 *  2. A SKIP MUST BE VISIBLE. sendCoiRevalidations returned {ok:true, due:0}
 *     every night for months while its query was refused outright, so no crew
 *     was ever warned their insurance was lapsing.
 *  3. AN ALERT MUST NOT BREAK THE THING IT IS ALERTING ABOUT.
 *     alertOpsDoubleCharge runs after a card HAS been charged.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const automation = () => src("./automation.ts");
const nightly = () => src("../app/api/cron/nightly/route.ts");

describe("rule 1 — one item never costs the run", () => {
  it("runRouteBuild does not return from inside its per-vendor loop", () => {
    // It deletes the day's routes BEFORE the loop. A mid-loop return is not a
    // stale route, it is no route.
    const s = automation();
    const start = s.indexOf("export async function runRouteBuild");
    const end = s.indexOf("export interface SettleOutcome");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = s.slice(start, end);
    // The delete-then-rebuild is what makes this dangerous; assert it is still
    // the shape this test is protecting.
    expect(body).toMatch(/from\("routes"\)\s*\.delete\(\)/);
    const midLoopReturns = body.match(/if \(rErr\) return \{/g) ?? [];
    expect(midLoopReturns, "a failed route insert must skip the crew, not the rebuild").toEqual([]);
    expect(body).toMatch(/truckWriteFailed/);
  });

  it("revalidateAssignments guards its per-job call", () => {
    const s = automation();
    const at = s.indexOf("await revalidateJob(");
    expect(at).toBeGreaterThan(-1);
    // The try must OPEN before the call, inside the loop.
    const before = s.slice(Math.max(0, at - 400), at);
    expect(before, "revalidateJob must be wrapped per item").toMatch(/try \{/);
  });

  it("reconcileUnsettledJobs guards its per-job settle", () => {
    const s = automation();
    const at = s.indexOf("await settleJob(");
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(Math.max(0, at - 500), at)).toMatch(/try \{/);
  });
});

describe("rule 2 — a skip reaches the person who reads the email", () => {
  it("noteSkips exists and feeds the same list a thrown step feeds", () => {
    expect(nightly()).toMatch(/function noteSkips/);
    expect(nightly()).toMatch(/failures\.push\(\{ step: name, error: s \}\)/);
  });

  it("EVERY money step's skips are wired", () => {
    // These are the ones where a silent skip costs the most: a fee not charged,
    // a crew's month not batched, a referral never credited.
    const s = nightly();
    for (const step of ["feeReconcile", "referrals", "payoutBatch", "monthlyPayouts"]) {
      expect(s, `${step} skips never reach the digest`).toMatch(
        new RegExp(`noteSkips\\("${step}"`),
      );
    }
    // reconcile reports `failures` rather than `skipped` — same destination.
    expect(s).toMatch(/reconcile\?\.failures/);
  });

  it("the skips are collected BEFORE the digest is sent", () => {
    // Ordering is the whole mechanism: `failures` is read when
    // sendNightlyDigest is called, so anything pushed afterwards is too late.
    const s = nightly();
    const lastNote = s.lastIndexOf("noteSkips(\"autoPricing\"");
    const digest = s.indexOf("sendNightlyDigest(");
    expect(lastNote).toBeGreaterThan(-1);
    expect(digest).toBeGreaterThan(-1);
    expect(digest, "noteSkips must run before the digest is built").toBeGreaterThan(lastNote);
  });
});

describe("rule 3 — the alert cannot break the payment path", () => {
  it("nothing in alertOpsDoubleCharge can throw at its caller", () => {
    // It runs when a card HAS been charged and the ledger refused the row.
    // A log line that throws would propagate into settleJob.
    const s = automation();
    const start = s.indexOf("async function alertOpsDoubleCharge");
    const end = s.indexOf("export async function settleJob");
    const body = s.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // The unguarded `amount.toFixed()` outside the try was the regression.
    expect(body).not.toMatch(/\n  if \(notified === 0\) \{\n    console\.error\(/);
    expect(body).toMatch(/Number\(amount\)\.toFixed/);
  });
});
