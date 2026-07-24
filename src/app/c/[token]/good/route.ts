import { createServiceClient } from "@/lib/supabase/server";
import { htmlPage } from "@/app/a/[token]/respond";
import { resolveFromCorrection } from "@/lib/disputes";

/**
 * Post-job quality check — 👍 ALL GOOD. GET is SAFE (renders a confirm button;
 * SMS link-preview prefetchers must never record a verdict — same lesson the
 * adversarial review taught the Autopilot links). POST records the one and
 * only verdict via a guarded flip: first tap wins, re-taps see a thank-you.
 * A fresh 👍 on a CORRECTION visit also closes the loop: the dispute resolves
 * and the held payout releases (resolveFromCorrection owns all of that).
 */

export const dynamic = "force-dynamic";

async function loadConf(token: string) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("job_confirmations")
    .select("id, verdict, job_id, jobs(correction_of, services(name))")
    .eq("confirm_token", token)
    .maybeSingle();
  return data ?? null;
}

const jobOf = (c: { jobs?: unknown }): { correction_of?: string | null; services?: unknown } | null =>
  (Array.isArray(c.jobs) ? c.jobs[0] : c.jobs) as { correction_of?: string | null; services?: unknown } | null;

const svcName = (c: { jobs?: unknown }): string => {
  const j = jobOf(c);
  const s = (Array.isArray(j?.services) ? j?.services[0] : j?.services) as { name?: string } | null;
  return s?.name ?? "your service";
};

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (conf.verdict) return htmlPage("Thanks — got it ✓", "Your feedback is already in. See you out there. 🌊");
  return htmlPage(
    "Glad it went well? 🌊",
    `One tap and your crew gets the credit for ${svcName(conf)}.`,
    true,
    new URL(req.url).pathname,
    "All good 👍",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (!conf.verdict) {
    const admin = createServiceClient();
    const { data: won } = await admin
      .from("job_confirmations")
      .update({ verdict: "good", responded_at: new Date().toISOString() })
      .eq("id", conf.id)
      .is("verdict", null) // one verdict, ever — first tap wins
      .select("id");
    if (won && won.length > 0 && jobOf(conf)?.correction_of) {
      // Fresh 👍 on a CORRECTION visit — customer accepted the fix — close
      // the loop: dispute resolves, held payout releases.
      await resolveFromCorrection(conf.job_id, true);
    }
  }
  return htmlPage("Thanks — that's what we like to hear 🌊", "Your crew gets the credit. See you next time.");
}
