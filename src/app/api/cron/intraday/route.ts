import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { sweepWaitlist, resolveRushFallbacks } from "@/lib/automation";

export const dynamic = "force-dynamic";

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
  const sweep = await sweepWaitlist();
  // ⚡ First beat past the rush cutoff executes each unclaimed rush job's
  // pre-chosen fallback (roll to tomorrow at standard price, or free-cancel).
  const rush = await resolveRushFallbacks();
  return NextResponse.json({ ok: true, sweep, rush });
}

export const GET = run;
export const POST = run;
