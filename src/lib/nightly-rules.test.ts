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

describe("the park machine reports, and never bills, on its own", () => {
  const machine = () => src("./park-machine.ts");
  const ceilings = () => src("../app/park/machine-helpers.ts");

  it("urgent findings come out in WORDS, not as a count", () => {
    // reconcile has always produced "N occupied lots have no bill for August
    // 2026 — somebody lives there and nothing is being charged". It went into
    // `findings: number`, which went into an HTTP response nobody reads. That
    // sentence IS the answer to "nobody raised the rent this month".
    const s = machine();
    expect(s).toMatch(/urgent: string\[\]/);
    expect(s).toMatch(/if \(f\.urgent\) urgent\.push/);
    // Named with the park — there will be a second one.
    expect(s).toMatch(/\$\{\(p\.name as string\) \?\? "A park"\}/);
  });

  it("those findings reach the nightly digest", () => {
    expect(nightly()).toMatch(/park\?\.urgent \?\? \[\]/);
  });

  it("raising charges is NOT something the machine may do alone", () => {
    // The park autonomy rule: a job runs unattended only if its worst outcome
    // is a sentence on a screen, or a write the database itself would refuse.
    // Raising bills asserts that nineteen households owe money. If a ceiling
    // for it is ever added, it must not be 'act'.
    const c = ceilings();
    const m = /raise_charges:\s*"(\w+)"/.exec(c);
    if (m) expect(m[1], "raising bills unattended asserts money is owed").not.toBe("act");
    // And the only 'act' entries stay the ones the DB itself makes safe.
    const acts = [...c.matchAll(/(\w+):\s*"act"/g)].map((x) => x[1]).sort();
    expect(acts).toEqual(["apply_rent_change", "owner_email"]);
  });
});

/**
 * A COUNT OF PEOPLE TOLD MUST NOT INCLUDE THE ONES WE FAILED TO TELL.
 *
 * `runRouteBuild` incremented `texted` unconditionally after notify(), so
 * a crew whose message reached nobody still counted. The failure went into
 * `skipped`, and the number ops actually read said the crew had been told. The
 * word was wrong too: notify() sends SMS AND email, and SMS has delivered
 * nothing since 19 July, so the one word naming a channel named the dead one.
 */
describe("the route build reports who it actually reached", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./automation.ts", import.meta.url)), "utf8",
  );

  it("only counts a crew as notified when a door actually took the message", () => {
    const at = src.indexOf("export async function runRouteBuild");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/if \(told\.reached\) notified\+\+; else unreached\+\+;/);
    // The old unconditional increment must be gone, not merely renamed.
    expect(body).not.toMatch(/^\s*(texted|notified)\+\+;\s*$/m);
  });

  it("still records the failure for the digest as well as counting it", () => {
    const at = src.indexOf("export async function runRouteBuild");
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/if \(!told\.reached && told\.note\) skipped\.push\(told\.note\)/);
  });

  it("nothing in the route path still calls a notification a text", () => {
    // COMMENTS STRIPPED FIRST. The comment above the counter explains why
    // "texted" was wrong, and an unstripped check fails on the documentation
    // of its own rule — which is how a guard ends up deleting the reason it
    // exists.
    const at = src.indexOf("export async function runRouteBuild");
    const body = src
      .slice(at, src.indexOf("\nexport ", at + 10))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(body).not.toMatch(/\btexted\b/);
  });

  it("and ops is shown the ones we could not reach", () => {
    const ui = readFileSync(
      fileURLToPath(new URL("../components/ops/RouteBuilder.tsx", import.meta.url)), "utf8",
    );
    expect(ui).toMatch(/crew\$\{res\.notified === 1 \? "" : "s"\} notified/);
    expect(ui).toMatch(/we couldn't reach/);
  });
});

/**
 * A PAYOUT REQUEST THAT DIED MID-FLIGHT LEFT THE CREW'S MONEY IN LIMBO.
 *
 * requestEarlyPayout inserts a batch as 'building', stamps batch_id onto the
 * crew's released payouts, then finalizes to 'queued'. Every FAILURE path
 * already unclaims and drops. What it cannot handle is the invocation ending
 * between those steps — no cleanup code runs at all. The payouts are then in a
 * batch the export refuses ('queued'/'exported' only) and invisible to the
 * crew's own screen (readyNow filters batch_id is null). Money frozen on every
 * surface, permanently, with nothing watching for it.
 */
describe("stranded payout batches are swept back into the pool", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./automation.ts", import.meta.url)), "utf8",
  );
  const at = src.indexOf("export async function sweepStrandedPayoutBatches");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));

  it("only touches batches that never finished assembling", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/\.eq\("status", "building"\)/);
  });

  it("leaves a request that is genuinely in flight alone", () => {
    // Without an age floor this would race a crew's live tap.
    expect(body).toMatch(/\.lt\("created_at", cutoff\)/);
    expect(src).toMatch(/const STRANDED_BATCH_MINUTES = 30;/);
  });

  it("unclaims the payouts BEFORE deleting the batch", () => {
    // The reverse order could delete the batch and leave payouts pointing at
    // a row that no longer exists.
    expect(body.indexOf('update({ batch_id: null })')).toBeLessThan(body.indexOf('.delete()'));
  });

  it("refuses to guess when the read fails", () => {
    // "Nothing is stranded" is the usual answer, so a swallowed read would be
    // indistinguishable from a quiet night on money nobody else watches.
    expect(body).toMatch(/mustRead\("payout batches that never finished assembling"/);
  });

  it("names what it could not free instead of counting it", () => {
    expect(body).toMatch(/could not be released back to the crew/);
    expect(body).toMatch(/skipped\.push\(/);
  });

  it("runs nightly and its skips reach the digest", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../app/api/cron/nightly/route.ts", import.meta.url)), "utf8",
    );
    expect(route).toMatch(/step\("strandedPayouts", \(\) => sweepStrandedPayoutBatches\(\)\)/);
    expect(route).toMatch(/noteSkips\("strandedPayouts", strandedPayouts\)/);
  });
});
