import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { runRouteBuild, revalidateAssignments, recordNoShows, sendNightBeforeReminders, reconcileUnsettledJobs, reconcileCancelledFees, sendCoiRevalidations, generateAutopilotProposals, demoteLakeStrikes, selfHealCrewBases, sweepWaitlist, expireUnfilledJobs, resolveRushFallbacks, matureReferralEarnings, runReferralPayoutBatch, runNudges } from "@/lib/automation";

export const dynamic = "force-dynamic";

/**
 * Nightly job (Vercel Cron, 8pm America/Indiana/Indianapolis). Builds
 * tomorrow's routes and texts each crew, then sends the night-before reminder
 * to owners with a job tomorrow. Protected by CRON_SECRET (fails closed).
 * Optional ?date=YYYY-MM-DD for manual/backfill runs.
 */
async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  // Flag yesterday's ghosted jobs (records the no-show, releases for free reschedule)
  // BEFORE self-heal, so released jobs re-enter the dispatch pool the same run.
  const noShows = await recordNoShows();
  // Phase E: pause crews on lakes they keep ghosting (BEFORE re-dispatch, so
  // tonight's waterfall never re-hands a job to the crew that just lost the lake).
  const lakeStanding = await demoteLakeStrikes();
  // Rush stragglers first (their fallback is kinder than a blunt expiry),
  // then the honest terminal for jobs whose date passed unfilled (+ the
  // T-minus warning), then try to fill every future waiting job.
  const rushFallbacks = await resolveRushFallbacks();
  const waitlist = await expireUnfilledJobs();
  const sweep = await sweepWaitlist();
  // Self-heal assignments (re-home lapsed crews, fill stragglers), then route.
  const dispatch = await revalidateAssignments(date);
  const routes = await runRouteBuild(date);
  const reminders = await sendNightBeforeReminders(date);
  // Catch any job completed but left partially billed (e.g. a mid-write crash),
  // and retry uncollected late-cancellation fees (crew share releases on collect).
  const reconcile = await reconcileUnsettledJobs();
  const feeReconcile = await reconcileCancelledFees();
  // Referral accruals past the clawback window become spendable credits.
  const referrals = await matureReferralEarnings();
  // Yearly COI re-attest nudge (fires on an exact boundary, so once per crew).
  const coi = await sendCoiRevalidations();
  // Autopilot: propose enrolled services' next visits (one-tap confirm texts).
  const autopilot = await generateAutopilotProposals();
  // Phase E: re-pin crew bases from where they actually complete jobs.
  const bases = await selfHealCrewBases();
  // Growth: month-end referral payout batch (self-gates to the last lake-day)
  // + the frequency-capped, prefs-gated nudge engine.
  const payoutBatch = await runReferralPayoutBatch();
  const nudges = await runNudges();
  return NextResponse.json({ ok: true, noShows, lakeStanding, rushFallbacks, waitlist, sweep, dispatch, routes, reminders, reconcile, feeReconcile, referrals, coi, autopilot, bases, payoutBatch, nudges });
}

export const GET = run; // Vercel Cron issues GET
export const POST = run; // allow manual POST trigger
