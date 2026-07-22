import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { runRouteBuild, revalidateAssignments, recordNoShows, sendNightBeforeReminders, reconcileUnsettledJobs, sendCoiRevalidations, generateAutopilotProposals, demoteLakeStrikes, selfHealCrewBases } from "@/lib/automation";

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
  // Self-heal assignments (re-home lapsed crews, fill stragglers), then route.
  const dispatch = await revalidateAssignments(date);
  const routes = await runRouteBuild(date);
  const reminders = await sendNightBeforeReminders(date);
  // Catch any job completed but left partially billed (e.g. a mid-write crash).
  const reconcile = await reconcileUnsettledJobs();
  // Yearly COI re-attest nudge (fires on an exact boundary, so once per crew).
  const coi = await sendCoiRevalidations();
  // Autopilot: propose enrolled services' next visits (one-tap confirm texts).
  const autopilot = await generateAutopilotProposals();
  // Phase E: re-pin crew bases from where they actually complete jobs.
  const bases = await selfHealCrewBases();
  return NextResponse.json({ ok: true, noShows, lakeStanding, dispatch, routes, reminders, reconcile, coi, autopilot, bases });
}

export const GET = run; // Vercel Cron issues GET
export const POST = run; // allow manual POST trigger
