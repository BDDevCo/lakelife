import { createServiceClient } from "@/lib/supabase/server";
import { htmlPage, escapeHtml } from "@/app/a/[token]/respond";
import { recordJobVerdict } from "@/lib/job-verdict";
import { signedJobPhotosOrNone } from "@/lib/photos";
import { photoStripHtml } from "@/lib/photo-strip";

/**
 * Post-job quality check — 👎 SOMETHING'S OFF. GET renders a small form
 * (optional note); POST records the verdict via the same first-tap-wins flip,
 * then ZERO-OPS routing: a fresh 👎 on a CORRECTION visit closes the loop via
 * the dispute's own policy (resolveFromCorrection); any other 👎 OPENS a
 * Make-It-Right dispute (holds the crew's pay, hands the crew the cure-first
 * ladder), and the note lands on the property's Messages board where the
 * owner and ops can both see the thread. No ops queue.
 */

export const dynamic = "force-dynamic";

/**
 * A FAILED READ IS NOT A BAD LINK.
 *
 * This is the 👎 door, which makes the swallow worse than on its 👍 twin: the
 * customer tapping it has something wrong with their job, and "This link
 * doesn't match anything" told them the way to report it was junk — while the
 * POST that was meant to open a Make-It-Right dispute and hold the crew's pay
 * quietly did nothing at all. No session, no account, nowhere else to look,
 * and no error boundary on a route handler, so the load reports the failure as
 * its own value and each door renders the difference.
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
    .select("id, verdict, job_id, property_id, vendor_id, jobs(date, correction_of, services(name)), properties(address, nickname, owner_id)")
    .eq("confirm_token", token)
    .maybeSingle();
  if (res.error) {
    console.error("[read failed] your feedback link:", res.error.code ?? "", res.error.message ?? res.error);
    return CONF_READ_FAILED;
  }
  return res.data ?? null;
}

const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (conf === CONF_READ_FAILED) return confReadFailedPage();
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (conf.verdict) return htmlPage("Thanks — got it ✓", "Your feedback is already in. If anything's still unresolved, message us from your portal. 🌊");

  const job = one(conf.jobs) as { services?: unknown } | null;
  const svc = (one(job?.services) as { name?: string } | null)?.name ?? "your service";
  // Small form: the note is optional — a bare 👎 still counts and still routes.
  const action = escapeHtml(new URL(req.url).pathname);
  // THE 👎 DOOR NEEDS THE REPORT MORE THAN THE 👍 DOES. Someone about to say
  // what went wrong should be looking at what the crew photographed while
  // they write it — it makes the note specific ("the port side, third photo")
  // instead of a sentence ops has to go and interpret. Never throws: see
  // signedJobPhotosOrNone.
  const strip = photoStripHtml(await signedJobPhotosOrNone(conf.job_id as string | null));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Something's off — LakeLife</title><style>body{font-family:system-ui,sans-serif;background:#f2f6f7;margin:0;display:grid;place-items:center;min-height:100vh;padding:20px;color:#20343d}.card{background:#fff;border-radius:16px;max-width:420px;padding:28px;box-shadow:0 8px 30px rgba(10,36,48,.12)}h1{font-size:20px;margin:10px 0 8px}p{font-size:14.5px;line-height:1.5;color:#5D7681}textarea{width:100%;box-sizing:border-box;min-height:90px;border:1.5px solid #d7e0e3;border-radius:12px;padding:10px;font:inherit;font-size:15px;margin-top:10px}button{width:100%;min-height:48px;border:0;border-radius:12px;background:#d9a441;color:#0a2430;font-size:16px;font-weight:800;cursor:pointer;margin-top:12px}.badge{display:inline-block;background:#fdf1dc;color:#8a6116;font-weight:800;font-size:12px;border-radius:99px;padding:4px 10px}</style></head><body><div class="card"><span class="badge">Heads up</span><h1>Sorry to hear it — tell us what's off</h1><p>${escapeHtml(`Your crew will be told right away and it's on them to make ${svc} right — that's how standing works here.`)}</p>${strip}<form method="post" action="${action}"><textarea name="note" maxlength="500" placeholder="What happened? (optional)"></textarea><button type="submit">Send it — flag the issue</button></form></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (conf === CONF_READ_FAILED) return confReadFailedPage();
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (conf.verdict) return htmlPage("Thanks — got it ✓", "Your feedback is already in. 🌊");

  let note = "";
  try {
    const form = await req.formData();
    note = String(form.get("note") ?? "").trim().slice(0, 500);
  } catch {
    /* bare 👎 without a form still counts */
  }

  // ONE implementation, two doors: this SMS link and the in-portal tap on the
  // job page both run recordJobVerdict — the guarded first-tap-wins flip, the
  // Make-It-Right dispute (which holds the crew's pay and texts them their
  // three cure links), and the annotated board post all live there.
  const res = await recordJobVerdict(conf.id as string, "issue", note);
  if (!res.recorded) return htmlPage("Thanks — got it ✓", "Your feedback is already in. 🌊");

  return htmlPage(
    "Flagged — your crew is on it 🌊",
    "They've been told and it's on them to make it right. You can follow up anytime from Messages in your portal — and this never costs you anything.",
  );
}
