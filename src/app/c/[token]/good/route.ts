import { createServiceClient } from "@/lib/supabase/server";
import { htmlPage } from "@/app/a/[token]/respond";
import { recordJobVerdict } from "@/lib/job-verdict";

/**
 * Post-job quality check — 👍 ALL GOOD. GET is SAFE (renders a confirm button;
 * SMS link-preview prefetchers must never record a verdict — same lesson the
 * adversarial review taught the Autopilot links). POST records the one and
 * only verdict via a guarded flip: first tap wins, re-taps see a thank-you.
 * A fresh 👍 on a CORRECTION visit also closes the loop: the dispute resolves
 * and the held payout releases (resolveFromCorrection owns all of that).
 */

export const dynamic = "force-dynamic";

/**
 * A FAILED READ IS NOT A BAD LINK.
 *
 * This page is reached by tapping a text message. There is no session, no
 * account and nowhere else to look, so "This link doesn't match anything" —
 * the sentence written for a token that genuinely matches nothing — told a
 * customer their feedback link was junk when the truth was that the database
 * didn't answer. On POST it was worse: the verdict was silently not recorded
 * and the tap that was meant to release their crew's credit did nothing. A
 * route handler has no error boundary either, so throwing would be a bare 500
 * on a phone. The load reports the failure as its own value instead.
 */
const CONF_READ_FAILED = "conf-read-failed" as const;

/** What to show when we could not look. Never "that link isn't right". */
const confReadFailedPage = () =>
  htmlPage(
    "We couldn't check that just now",
    "Something on our end didn't answer, so nothing has been recorded yet. The link still works — give it another tap in a minute. 🌊",
    false,
  );

async function loadConf(token: string) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const admin = createServiceClient();
  const res = await admin
    .from("job_confirmations")
    .select("id, verdict, job_id, jobs(correction_of, services(name))")
    .eq("confirm_token", token)
    .maybeSingle();
  if (res.error) {
    console.error("[read failed] your feedback link:", res.error.code ?? "", res.error.message ?? res.error);
    return CONF_READ_FAILED;
  }
  return res.data ?? null;
}

const svcName = (c: { jobs?: unknown }): string => {
  const j = (Array.isArray(c.jobs) ? c.jobs[0] : c.jobs) as { services?: unknown } | null;
  const s = (Array.isArray(j?.services) ? j?.services[0] : j?.services) as { name?: string } | null;
  return s?.name ?? "your service";
};

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (conf === CONF_READ_FAILED) return confReadFailedPage();
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
  if (conf === CONF_READ_FAILED) return confReadFailedPage();
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  // ONE implementation, two doors: this SMS link and the in-portal tap on the
  // job page both run recordJobVerdict, so the consequences can never drift.
  await recordJobVerdict(conf.id as string, "good", "");
  return htmlPage("Thanks — that's what we like to hear 🌊", "Your crew gets the credit. See you next time.");
}
