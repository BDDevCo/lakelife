import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { sendSeasonalPullReminders } from "@/lib/automation";

export const dynamic = "force-dynamic";

/**
 * Daily seasonal job (Vercel Cron, ~8am). Emails owners on any lake whose pull
 * deadline is exactly 14 days out — fires once per lake per season. Protected
 * by CRON_SECRET (fails closed). Optional ?lead=NN to override the lead days.
 */
async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const leadRaw = new URL(req.url).searchParams.get("lead");
  const lead = leadRaw && /^\d+$/.test(leadRaw) ? Number(leadRaw) : 14;
  const result = await sendSeasonalPullReminders(lead);
  return NextResponse.json(result);
}

export const GET = run;
export const POST = run;
