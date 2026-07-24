import { createServiceClient } from "@/lib/supabase/server";
import { htmlPage, escapeHtml } from "@/app/a/[token]/respond";
import { sendSms } from "@/lib/sms";
import { openDisputeForJob, resolveFromCorrection } from "@/lib/disputes";

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

async function loadConf(token: string) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("job_confirmations")
    .select("id, verdict, job_id, property_id, vendor_id, jobs(date, correction_of, services(name)), properties(address, nickname, owner_id)")
    .eq("confirm_token", token)
    .maybeSingle();
  return data ?? null;
}

const one = <T,>(x: T | T[] | null | undefined): T | null => (x == null ? null : Array.isArray(x) ? x[0] ?? null : x);

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (conf.verdict) return htmlPage("Thanks — got it ✓", "Your feedback is already in. If anything's still unresolved, message us from your portal. 🌊");

  const job = one(conf.jobs) as { services?: unknown } | null;
  const svc = (one(job?.services) as { name?: string } | null)?.name ?? "your service";
  // Small form: the note is optional — a bare 👎 still counts and still routes.
  const action = escapeHtml(new URL(req.url).pathname);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Something's off — LakeLife</title><style>body{font-family:system-ui,sans-serif;background:#f2f6f7;margin:0;display:grid;place-items:center;min-height:100vh;padding:20px;color:#20343d}.card{background:#fff;border-radius:16px;max-width:420px;padding:28px;box-shadow:0 8px 30px rgba(10,36,48,.12)}h1{font-size:20px;margin:10px 0 8px}p{font-size:14.5px;line-height:1.5;color:#5D7681}textarea{width:100%;box-sizing:border-box;min-height:90px;border:1.5px solid #d7e0e3;border-radius:12px;padding:10px;font:inherit;font-size:15px;margin-top:10px}button{width:100%;min-height:48px;border:0;border-radius:12px;background:#d9a441;color:#0a2430;font-size:16px;font-weight:800;cursor:pointer;margin-top:12px}.badge{display:inline-block;background:#fdf1dc;color:#8a6116;font-weight:800;font-size:12px;border-radius:99px;padding:4px 10px}</style></head><body><div class="card"><span class="badge">Heads up</span><h1>Sorry to hear it — tell us what's off</h1><p>${escapeHtml(`Your crew will be told right away and it's on them to make ${svc} right — that's how standing works here.`)}</p><form method="post" action="${action}"><textarea name="note" maxlength="500" placeholder="What happened? (optional)"></textarea><button type="submit">Send it — flag the issue</button></form></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const conf = await loadConf(token);
  if (!conf) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (conf.verdict) return htmlPage("Thanks — got it ✓", "Your feedback is already in. 🌊");

  let note = "";
  try {
    const form = await req.formData();
    note = String(form.get("note") ?? "").trim().slice(0, 500);
  } catch {
    /* bare 👎 without a form still counts */
  }

  const admin = createServiceClient();
  const { data: won } = await admin
    .from("job_confirmations")
    .update({ verdict: "issue", note: note || null, responded_at: new Date().toISOString() })
    .eq("id", conf.id)
    .is("verdict", null) // one verdict, ever
    .select("id");
  if (!won || won.length === 0) return htmlPage("Thanks — got it ✓", "Your feedback is already in. 🌊");

  const job = one(conf.jobs) as { date?: string; correction_of?: string | null; services?: unknown } | null;
  const svc = (one(job?.services) as { name?: string } | null)?.name ?? "the service";
  const prop = one(conf.properties) as { address?: string; nickname?: string; owner_id?: string } | null;
  const where = prop?.nickname || prop?.address || "the property";

  if (job?.correction_of) {
    // A fresh 👎 on a CORRECTION visit — the dispute's own policy engine
    // decides what happens next and owns all comms; no crew SMS from here.
    await resolveFromCorrection(conf.job_id, false);
  } else {
    // ZERO-OPS routing: open the Make-It-Right dispute (holds the crew's
    // pay) and hand the crew the cure-first ladder in one text.
    const r = await openDisputeForJob(conf.job_id, note || null);
    if (r.ok && r.crewLinks && conf.vendor_id) {
      const { data: v } = await admin.from("vendors").select("user_id").eq("id", conf.vendor_id as string).maybeSingle();
      if (v?.user_id) {
        const { data: cu } = await admin.from("users").select("phone").eq("id", v.user_id as string).maybeSingle();
        if (cu?.phone) {
          void sendSms(
            cu.phone as string,
            `LakeLife: the customer flagged the ${svc} at ${where}${note ? ` — "${note.slice(0, 120)}"` : ""}. Your pay for it is ON HOLD until this is settled. Make it right (free return visit): ${r.crewLinks.fix} · It was done right (send them your photos): ${r.crewLinks.verify} · Talk it through: ${r.crewLinks.talk}`,
          );
        }
      }
    }
  }
  // And the note lands on the property's Messages board (owner + ops can see).
  if (conf.property_id) {
    await admin.from("messages").insert({
      property_id: conf.property_id,
      from_user: prop?.owner_id ?? null,
      body: `⚠️ Issue flagged on ${svc}${job?.date ? ` (${job.date})` : ""}: ${note || "no details left — crew has been notified"}`,
    });
  }

  return htmlPage(
    "Flagged — your crew is on it 🌊",
    "They've been told and it's on them to make it right. You can follow up anytime from Messages in your portal — and this never costs you anything.",
  );
}
