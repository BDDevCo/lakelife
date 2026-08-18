import { createServiceClient } from "@/lib/supabase/server";
import { htmlPage, loadTokenEvent, TOKEN_READ_FAILED, tokenReadFailedPage } from "../respond";

/**
 * Autopilot SKIP — free, always (§8d). GET is SAFE (renders a "Skip" button —
 * link prefetchers must never consume the proposal); the skip happens on POST,
 * and we only claim "skipped" when OUR update actually won (a confirm racing
 * on another device may have booked it — then the customer sees the truth).
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ev = await loadTokenEvent(token);
  if (ev === TOKEN_READ_FAILED) return tokenReadFailedPage();
  if (!ev) return htmlPage("That link isn't right", "This link doesn't match anything — book anytime at lakelife.ai. 🌊", false);
  if (ev.status === "skipped") return htmlPage("Skipped ✓", "No charge, nothing booked. We'll check in again next time. 🌊");
  if (ev.status !== "proposed") {
    return htmlPage("Already handled", "This proposal was already confirmed or expired — see your requests at lakelife.ai. 🌊");
  }
  return htmlPage(
    "Skip this one?",
    `We'll skip ${ev.enrollment.serviceName} this time — free, nothing booked. We'll check in again next season.`,
    true,
    new URL(req.url).pathname,
    "Skip it — no charge",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ev = await loadTokenEvent(token);
  if (ev === TOKEN_READ_FAILED) return tokenReadFailedPage();
  if (!ev) return htmlPage("That link isn't right", "This link doesn't match anything — book anytime at lakelife.ai. 🌊", false);
  if (ev.status === "skipped") return htmlPage("Skipped ✓", "No charge, nothing booked. We'll check in again next time. 🌊");

  const admin = createServiceClient();
  const wonRes = await admin
    .from("autopilot_events")
    .update({ status: "skipped" })
    .eq("id", ev.id)
    .eq("status", "proposed")
    .select("id");
  // An errored update is not a lost race. "Already handled" would tell somebody
  // who tapped Skip that the matter is closed when nothing was written — and
  // the proposal is still live behind them.
  if (wonRes.error) {
    console.error("[read failed] skipping this proposal:", wonRes.error.code ?? "", wonRes.error.message);
    return htmlPage(
      "We couldn't skip it just now",
      "Nothing has been booked and nothing has been charged, but the skip didn't save. Give it another tap in a minute. 🌊",
      false,
    );
  }
  const won = wonRes.data;
  if (!won || won.length === 0) {
    // Lost a race (e.g. confirm won on another device) — tell the truth.
    return htmlPage("Already handled", "This proposal was just confirmed or expired — check your requests at lakelife.ai before assuming it's off. 🌊", false);
  }
  return htmlPage("Skipped — no charge 🌊", `We'll skip ${ev.enrollment.serviceName} this time and check in again next season. Change of heart? Book anytime at lakelife.ai/book.`);
}
