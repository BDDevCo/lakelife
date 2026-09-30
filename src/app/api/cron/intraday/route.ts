import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { sweepWaitlist, resolveRushFallbacks } from "@/lib/automation";
import { stampCronRun } from "@/lib/cron-health";

export const dynamic = "force-dynamic";
// A beat is two sweeps over open jobs; the default 10s serverless ceiling is
// not enough on a busy afternoon, and a timeout here looks exactly like a
// crash — the fallback simply doesn't run and nobody is told.
export const maxDuration = 60;

/**
 * INTRADAY HEARTBEAT (every 30 min, via Supabase pg_cron — Vercel Hobby's two
 * daily crons are both spoken for). Fills-only and FUTURE-only by design:
 * it re-tries "Finding a crew" jobs for tomorrow onward the moment supply
 * allows, and texts ONLY on a fill (good news is the only interruption).
 *
 * Deliberately NOT here (adversarial review, 2026-07-22): re-validating
 * TODAY's scheduled jobs. Same-day re-homing silently strips a job from a
 * crew who may already be driving to it and hands it to one who was never
 * told — that's a notification-design problem, not a cron problem. The
 * nightly revalidate (tomorrow's jobs, broadcast on, before route build)
 * remains the authoritative self-heal.
 * Protected by CRON_SECRET (fails closed).
 */
async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ONE STEP MUST NOT TAKE THE OTHER DOWN — the same guard the nightly uses.
  //
  // These were two bare awaits, so a throw inside `sweepWaitlist` skipped
  // `resolveRushFallbacks` entirely for that beat. A rush customer who had
  // already chosen "cancel it if nobody claims" then waited another half hour
  // for a decision they'd made in advance. And because a 500 here is only
  // visible in a log nobody reads, that could repeat all afternoon.
  const failures: { step: string; error: string }[] = [];
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      failures.push({ step: name, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  // THE HEARTBEAT'S OWN PULSE (0186). This beat is scheduled from Supabase
  // pg_cron, not from Vercel — and 0023 enables the extensions only, leaving
  // the cron.schedule() call to be run by hand. So "it was never scheduled at
  // all" is a live possibility that until now nothing could tell apart from a
  // quiet afternoon. One row per job, overwritten every beat.
  await stampCronRun("intraday", "started");

  const sweep = await step("sweep", () => sweepWaitlist());
  // ⚡ First beat past the rush cutoff executes each unclaimed rush job's
  // pre-chosen fallback (roll to tomorrow at standard price, or free-cancel).
  const rush = await step("rush", () => resolveRushFallbacks());

  await stampCronRun("intraday", "finished", {
    ok: failures.length === 0,
    error: failures.map((f) => `${f.step}: ${f.error}`).join("; ") || null,
  });
  return NextResponse.json({ ok: failures.length === 0, failures, sweep, rush });
}

export const GET = run;
export const POST = run;
