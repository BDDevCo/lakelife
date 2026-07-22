import { createServiceClient } from "@/lib/supabase/server";
import { todayLakeDate } from "@/lib/booking";
import { autoAssignJob } from "@/app/book/dispatch";
import { htmlPage, loadTokenEvent, prettyDay } from "../respond";

/**
 * Autopilot CONFIRM. GET is SAFE (renders a "Book it" button) — SMS apps and
 * link scanners prefetch GETs, and a prefetch must never book anything. The
 * actual booking happens on POST: guarded transition proposed→confirmed (only
 * one submit ever wins), a re-check that nothing else got booked meanwhile,
 * then the job is created at the enrollment's LOCKED price and auto-dispatched.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ev = await loadTokenEvent(token);
  if (!ev) return htmlPage("That link isn't right", "This link doesn't match anything — book anytime at lakelife.ai. 🌊", false);

  if (ev.status === "confirmed") {
    return htmlPage("Already booked ✓", `${ev.enrollment.serviceName} at ${ev.enrollment.where} is on the books for ${prettyDay(ev.proposed_date)}. We'll text you the night before. 🌊`);
  }
  if (ev.status !== "proposed" || !ev.enrollment.active || ev.proposed_date <= todayLakeDate()) {
    return htmlPage("This one expired", "No worries — nothing was booked. You can book anytime at lakelife.ai/book. 🌊", false);
  }
  return htmlPage(
    "Ready to book? 🌊",
    `${ev.enrollment.serviceName} at ${ev.enrollment.where} — ${prettyDay(ev.proposed_date)}, at your locked price. One tap and it's on the books.`,
    true,
    new URL(req.url).pathname,
    "Book it 👍",
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ev = await loadTokenEvent(token);
  if (!ev) return htmlPage("That link isn't right", "This link doesn't match anything — book anytime at lakelife.ai. 🌊", false);

  if (ev.status === "confirmed") {
    return htmlPage("Already booked ✓", `${ev.enrollment.serviceName} at ${ev.enrollment.where} is on the books for ${prettyDay(ev.proposed_date)}. 🌊`);
  }
  if (ev.status !== "proposed" || !ev.enrollment.active || ev.proposed_date <= todayLakeDate()) {
    return htmlPage("This one expired", "No worries — nothing was booked. You can book anytime at lakelife.ai/book. 🌊", false);
  }

  const admin = createServiceClient();

  // Did something else get booked for this property+service in the meantime
  // (manual booking, another proposal)? Never double-book the same work.
  const { data: upcoming } = await admin
    .from("jobs")
    .select("id")
    .eq("property_id", ev.enrollment.property_id)
    .eq("service_id", ev.enrollment.service_id)
    .in("status", ["requested", "scheduled", "in_progress"])
    .gte("date", todayLakeDate())
    .limit(1);
  if (upcoming && upcoming.length > 0) {
    await admin.from("autopilot_events").update({ status: "expired" }).eq("id", ev.id).eq("status", "proposed");
    return htmlPage("Already on the books ✓", `You already have ${ev.enrollment.serviceName} coming up at ${ev.enrollment.where} — no need to book it twice. 🌊`);
  }

  // Only one submit wins the proposed→confirmed flip (double-tap, two phones).
  const { data: won } = await admin
    .from("autopilot_events")
    .update({ status: "confirmed" })
    .eq("id", ev.id)
    .eq("status", "proposed")
    .select("id");
  if (!won || won.length === 0) {
    return htmlPage("Already handled", "This proposal was just confirmed or skipped — check your requests at lakelife.ai. 🌊");
  }

  // Book at the LOCKED price (the rate-lock perk), then dispatch right away.
  const { data: job, error } = await admin
    .from("jobs")
    .insert({
      property_id: ev.enrollment.property_id,
      service_id: ev.enrollment.service_id,
      date: ev.proposed_date,
      status: "requested",
      customer_price: ev.enrollment.locked_price,
    })
    .select("id")
    .single();
  if (error || !job) {
    // Roll the event back so the link can be tapped again later.
    await admin.from("autopilot_events").update({ status: "proposed" }).eq("id", ev.id);
    return htmlPage("Hmm, that didn't take", "Give it another tap in a minute, or book at lakelife.ai/book. 🌊", false);
  }
  await admin.from("autopilot_events").update({ job_id: job.id }).eq("id", ev.id);
  await autoAssignJob(job.id as string);

  return htmlPage(
    "You're booked 🌊",
    `${ev.enrollment.serviceName} at ${ev.enrollment.where} — ${prettyDay(ev.proposed_date)}, at your locked price. We'll text you the night before, and again when it's done (with photos).`,
  );
}
