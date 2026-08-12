import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { runRouteBuild, revalidateAssignments, recordNoShows, sendNightBeforeReminders, reconcileUnsettledJobs, reconcileCancelledFees, sendCoiRevalidations, generateAutopilotProposals, demoteLakeStrikes, selfHealCrewBases, sweepWaitlist, expireUnfilledJobs, resolveRushFallbacks, matureReferralEarnings, runReferralPayoutBatch, runNudges, birthSpringJobs, overstayNotices, runMonthlyPayoutBatches, runFillInDigest, gapSlaAlerts, reconcileRefunds, learnServiceDurations, autoApplyPriceSuggestions, sendNightlyDigest, remindExpiringStays } from "@/lib/automation";
import { applyDueRentChanges } from "@/app/park/rerate-actions";
import { runParkNightly } from "@/lib/park-machine";
import { sweepDisputeDeadlines } from "@/lib/disputes";

export const dynamic = "force-dynamic";
// TWENTY-SEVEN SEQUENTIAL STEPS. On the default serverless ceiling this run
// gets cut off partway through, which looks exactly like nothing happening:
// the steps after the cut simply don't run, and the digest — the last one, and
// the only thing that reports the night — is the first casualty.
export const maxDuration = 300;

/**
 * Nightly job (Vercel Cron, 8pm America/Indiana/Indianapolis). Builds
 * tomorrow's routes and texts each crew, then sends the night-before reminder
 * to owners with a job tomorrow. Protected by CRON_SECRET (fails closed).
 * Optional ?date=YYYY-MM-DD for manual/backfill runs.
 */
/**
 * ONE STEP MUST NEVER TAKE DOWN THE REST.
 *
 * This job is 27 sequential awaits with no guard, so a throw anywhere — a park
 * query naming a column that does not exist, say — 500s the whole run and skips
 * tomorrow's crew routes, the night-before reminders and the dispatch self-heal.
 * The park module is the newest and least-exercised code in here; it must not
 * be able to stop the business that has real customers.
 *
 * Failures are COLLECTED and returned, never swallowed. A step that dies shows
 * up by name in the response and in the digest.
 */
const failures: { step: string; error: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failures.push({ step: name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  failures.length = 0;
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  // Flag yesterday's ghosted jobs (records the no-show, releases for free reschedule)
  // BEFORE self-heal, so released jobs re-enter the dispatch pool the same run.
  const noShows = await step("noShows", () => recordNoShows());
  // Phase E: pause crews on lakes they keep ghosting (BEFORE re-dispatch, so
  // tonight's waterfall never re-hands a job to the crew that just lost the lake).
  const lakeStanding = await step("lakeStanding", () => demoteLakeStrikes());
  // Rush stragglers first (their fallback is kinder than a blunt expiry),
  // then the honest terminal for jobs whose date passed unfilled (+ the
  // T-minus warning), then try to fill every future waiting job.
  const rushFallbacks = await step("rushFallbacks", () => resolveRushFallbacks());
  const springBirths = await step("springBirths", () => birthSpringJobs()); // before the sweep: home-variant spring jobs get filled the same night
  const waitlist = await step("waitlist", () => expireUnfilledJobs());
  // Ask a renter before they pack, and roll a month-to-month tenancy forward
  // before it lapses. Both are the same mechanism — see lib/extend-stay.ts.
  const extendReminders = await step("extendReminders", () => remindExpiringStays());
  // Scheduled rent changes that have come due AND were properly served. The
  // database refuses any that weren't, so this can only ever apply the ones
  // with notice on the record.
  const rentChanges = await step("rentChanges", () => applyDueRentChanges());
  const sweep = await step("sweep", () => sweepWaitlist());
  const overstay = await step("overstay", () => overstayNotices());
  // Self-heal assignments (re-home lapsed crews, fill stragglers), then route.
  const dispatch = await step("dispatch", () => revalidateAssignments(date));
  const learning = await step("learning", () => learnServiceDurations());
  const routes = await step("routes", () => runRouteBuild(date));
  const reminders = await step("reminders", () => sendNightBeforeReminders(date));
  // Catch any job completed but left partially billed (e.g. a mid-write crash),
  // and retry uncollected late-cancellation fees (crew share releases on collect).
  const reconcile = await step("reconcile", () => reconcileUnsettledJobs());
  const refundReconcile = await step("refundReconcile", () => reconcileRefunds());
  const feeReconcile = await step("feeReconcile", () => reconcileCancelledFees());
  // Referral accruals past the clawback window become spendable credits.
  const referrals = await step("referrals", () => matureReferralEarnings());
  // Yearly COI re-attest nudge (fires on an exact boundary, so once per crew).
  const coi = await step("coi", () => sendCoiRevalidations());
  // Autopilot: propose enrolled services' next visits (one-tap confirm texts).
  const autopilot = await step("autopilot", () => generateAutopilotProposals());
  // Phase E: re-pin crew bases from where they actually complete jobs.
  const bases = await step("bases", () => selfHealCrewBases());
  // Growth: month-end referral payout batch (self-gates to the last lake-day)
  // + the frequency-capped, prefs-gated nudge engine.
  const payoutBatch = await step("payoutBatch", () => runReferralPayoutBatch());
  const monthlyPayouts = await step("monthlyPayouts", () => runMonthlyPayoutBatches());
  const fillInDigest = await step("fillInDigest", () => runFillInDigest());
  // Autonomy Ladder (2026-07-23): silent-crew disputes fire their policy,
  // margin_stranded prices within the dial apply themselves.
  const disputeSweep = await step("disputeSweep", () => sweepDisputeDeadlines());
  const autoPricing = await step("autoPricing", () => autoApplyPriceSuggestions());
  const gapSla = await step("gapSla", () => gapSlaAlerts());
  const nudges = await step("nudges", () => runNudges());
  // THE nightly digest — always last, carries everything above to ops in one email.
  // The park's evening read. Guarded like everything else, and it writes its
  // own run row so a night it never ran is visible on his screen tomorrow.
  const park = await step("park", () => runParkNightly());
  // A step that died contributes its empty shape rather than blocking the
  // digest — the digest is how ops finds out, so it must survive the failure
  // it is reporting. `failures` carries what actually broke.
  const digest = await step("digest", () => sendNightlyDigest({
    learning: learning ?? { changes: [] },
    autoPricing: autoPricing ?? { changes: [] },
    disputeSweep: disputeSweep ?? { fired: 0, escalated: 0 },
    routes: routes ?? {},
    gapSla: gapSla ?? { alerted: 0 },
    // WHAT BROKE TONIGHT, FIRST. These were collected all the way down this
    // function and then dropped on the floor: a night where a step threw
    // produced the same email as a clean one, often literally "Quiet night —
    // nothing needed a human." The digest is how ops finds out, so it has to
    // survive — and report — the failure it is reporting.
    failures,
    // MONEY THAT MOVED TONIGHT. Every one of these was already sitting in a
    // local, and went only into an HTTP response nobody reads — so month-end,
    // the night the largest sum of the month leaves the account, read as a
    // quiet night. The fields have existed on DigestSections since the
    // two-season audit; nothing ever passed them.
    payoutBatch: payoutBatch ?? undefined,
    monthlyPayouts: monthlyPayouts ?? undefined,
    referrals: referrals ?? undefined,
    feeReconcile: feeReconcile ?? undefined,
    refundReconcile: refundReconcile ?? undefined,
  }));
  return NextResponse.json({ ok: failures.length === 0, failures, park, noShows, lakeStanding, rushFallbacks, springBirths, overstay, waitlist, extendReminders, rentChanges, sweep, dispatch, learning, routes, reminders, reconcile, refundReconcile, feeReconcile, referrals, coi, autopilot, bases, payoutBatch, monthlyPayouts, fillInDigest, disputeSweep, autoPricing, gapSla, nudges, digest });
}

export const GET = run; // Vercel Cron issues GET
export const POST = run; // allow manual POST trigger
