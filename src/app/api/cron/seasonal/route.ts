import { NextResponse } from "next/server";
import { cronAuthorized } from "../auth";
import { sendSeasonalPullReminders, alertOps } from "@/lib/automation";
import { html } from "@/lib/html-safe";

export const dynamic = "force-dynamic";
// Fans out over every property on a lake; a default ceiling truncates the send
// silently, and the households past the cut simply never hear from us.
export const maxDuration = 300;

/**
 * Daily seasonal job (Vercel Cron, ~8am). Emails owners on any lake whose pull
 * deadline is exactly 14 days out — fires once per lake per season. Protected
 * by CRON_SECRET (fails closed). Optional ?lead=NN to override the lead days.
 */
/**
 * THE HIGHEST-CONSEQUENCE SEND IN THE PRODUCT HAD NO WAY TO REPORT ITSELF.
 *
 * This route was two lines: call the runner, return its result as JSON. The
 * runner builds a `skipped` list precisely because a lake missed tonight is a
 * lake whose one freeze warning of the year is simply never sent — and that
 * list went into an HTTP response body that nothing in this repo reads. A
 * throw was worse: no try/catch, so a refused read on the lakes table 500s and
 * leaves no record anywhere at all.
 *
 * The nightly solved this with noteSkips and the digest. This cron is not in
 * the nightly, so it gets the same idea in the one shape available to it: an
 * email to ops, on both endings, naming the recovery.
 *
 * TWO ENDINGS, TWO HONEST SENTENCES. When the runner throws, it died at the
 * read that discovers which lakes are due — so no lake is known, and an email
 * naming lakes on that path would be inventing them. The skip path knows
 * exactly which lakes lost their warning and says so.
 */
async function run(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const leadRaw = new URL(req.url).searchParams.get("lead");
  const lead = leadRaw && /^\d+$/.test(leadRaw) ? Number(leadRaw) : 14;

  // THE RECOVERY, NAMED IN THE EMAIL ITSELF. The once-a-season claim is
  // UNIQUE (property_id, season_year, kind) and a skipped lake writes no claim
  // row, so re-running this path by hand re-sends only to the households that
  // missed out — nobody is written to twice. Without this sentence he reads
  // "Pretty Lake got no warning" and has no idea it can still be fixed today.
  const howToRecover = html`<p>This can still be re-run by hand: call <code>/api/cron/seasonal?lead=N</code> with N set to ${lead} minus the number of days that have passed since tonight. Every household that already had its warning holds a once-a-season claim row, so a re-run reaches only the ones who missed out.</p>`;

  let result: Awaited<ReturnType<typeof sendSeasonalPullReminders>>;
  try {
    result = await sendSeasonalPullReminders(lead);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Says what is true and nothing more: which lakes were due is exactly the
    // fact this run died before learning.
    await alertOps(
      "🚨 Tonight's freeze warning did not run",
      html`<p>The seasonal pull-deadline run died before it knew which lakes were due: <b>${message}</b></p><p>If any lake's pull deadline is ${lead} days out today, <b>nobody on that lake was warned</b>. This fires on one date a year per lake and does not retry itself.</p>${howToRecover}`,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  if (result.skipped.length > 0) {
    await alertOps(
      `🚨 ${result.skipped.length} lake${result.skipped.length === 1 ? "" : "s"} got no freeze warning tonight`,
      html`<p>Tonight's pull-deadline run finished, and these did not go out:</p><ul>${result.skipped.map((s) => html`<li>${s}</li>`)}</ul>${howToRecover}`,
    );
  }
  // A night a lake lost its warning answers with a broken status code too, so
  // Vercel's own cron log carries it without anybody building anything. Same
  // assumption as the nightly's: Vercel does not retry a failed invocation, so
  // this does not re-send to the households that DID get their warning.
  return NextResponse.json(result, { status: result.skipped.length > 0 ? 500 : 200 });
}

export const GET = run;
export const POST = run;
