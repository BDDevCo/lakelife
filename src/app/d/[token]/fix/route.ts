import { htmlPage, escapeHtml } from "@/app/a/[token]/respond";
import { todayLakeDate, toISODate } from "@/lib/booking";
import { loadDisputeByToken, crewChooseFix } from "@/lib/disputes";

/**
 * Make-It-Right — crew taps "I'll fix it" (right-to-cure, ToS §11.5). GET is
 * SAFE (renders a day picker only; SMS link-preview prefetchers issue GETs
 * and must never book anything) — the $0 photo-gated correction visit is
 * booked on POST via crewChooseFix, which re-checks the dispute is still
 * fixable (first tap across fix/verify/talk wins).
 */

export const dynamic = "force-dynamic";

const FIXABLE = ["crew_review", "talk", "verifying"];

function nextSevenDays(): { iso: string; label: string }[] {
  const start = new Date(`${todayLakeDate()}T12:00:00`);
  const days: { iso: string; label: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push({
      iso: toISODate(d),
      label: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
    });
  }
  return days;
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("crew", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (!FIXABLE.includes(d.status)) {
    return htmlPage("Already moving", "This one's already moving — check your Today list. 🌊");
  }

  const action = escapeHtml(new URL(req.url).pathname);
  const options = nextSevenDays()
    .map((day) => `<option value="${escapeHtml(day.iso)}">${escapeHtml(day.label)}</option>`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book the return visit — LakeLife</title><style>body{font-family:system-ui,sans-serif;background:#f2f6f7;margin:0;display:grid;place-items:center;min-height:100vh;padding:20px;color:#20343d}.card{background:#fff;border-radius:16px;max-width:420px;padding:28px;box-shadow:0 8px 30px rgba(10,36,48,.12)}h1{font-size:20px;margin:10px 0 8px}p{font-size:14.5px;line-height:1.5;color:#5D7681}select{width:100%;box-sizing:border-box;min-height:48px;border:1.5px solid #d7e0e3;border-radius:12px;padding:10px;font:inherit;font-size:15px;margin-top:10px;background:#fff}button{width:100%;min-height:48px;border:0;border-radius:12px;background:#d9a441;color:#0a2430;font-size:16px;font-weight:800;cursor:pointer;margin-top:12px}.badge{display:inline-block;background:#fdf1dc;color:#8a6116;font-weight:800;font-size:12px;border-radius:99px;padding:4px 10px}</style></head><body><div class="card"><span class="badge">Make it right</span><h1>Book the free return visit 🌊</h1><p>Pick a day — we'll text the customer that you're coming back, no charge, and your pay stays on hold until it's done.</p><form method="post" action="${action}"><select name="date">${options}</select><button type="submit">Book the free return visit</button></form></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("crew", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (!FIXABLE.includes(d.status)) {
    return htmlPage("Already moving", "This one's already moving — check your Today list. 🌊");
  }

  let dateISO = "";
  try {
    const form = await req.formData();
    dateISO = String(form.get("date") ?? "").trim();
  } catch {
    /* missing form body falls through to crewChooseFix's own validation */
  }

  const r = await crewChooseFix(token, dateISO);
  if (!r.ok) return htmlPage("Hmm, that didn't take", r.error ?? "Give it another tap in a minute. 🌊", false);
  return htmlPage(
    "Booked — thanks for making it right 🌊",
    "The customer's been told you're coming back, no charge. You'll see it on your Today list, and your pay releases once it's done and photographed.",
  );
}
