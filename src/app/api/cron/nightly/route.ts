import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { runRouteBuild, revalidateAssignments, sendNightBeforeReminders, reconcileUnsettledJobs } from "@/lib/automation";

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
  // Self-heal assignments FIRST (re-home lapsed crews, fill stragglers), then route.
  const dispatch = await revalidateAssignments(date);
  const routes = await runRouteBuild(date);
  const reminders = await sendNightBeforeReminders(date);
  // Catch any job completed but left partially billed (e.g. a mid-write crash).
  const reconcile = await reconcileUnsettledJobs();
  return NextResponse.json({ ok: true, dispatch, routes, reminders, reconcile });
}

export const GET = run; // Vercel Cron issues GET
export const POST = run; // allow manual POST trigger
