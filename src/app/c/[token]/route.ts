import { htmlPage } from "@/app/a/[token]/respond";
import { loadPaymentByToken, confirmByToken, disputeByToken } from "@/lib/confirm-server";

/**
 * "DOES THIS LOOK RIGHT?" — the renter's half of the receipt.
 *
 * GET IS SAFE and only renders buttons. Link-preview prefetchers issue GETs,
 * and a GET that confirmed a payment would have people agreeing to figures by
 * opening a text message. Same discipline as the extend-stay and
 * Make-It-Right links.
 */

export const dynamic = "force-dynamic";

function pretty(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const view = await loadPaymentByToken(token);
  if (!view) {
    return htmlPage("That link isn't right", "This link doesn't match a payment. 🌊", false);
  }

  const line =
    `${view.parkName} recorded $${view.amount.toFixed(2)} from lot ${view.lotNumber}, ` +
    `paid by ${view.method}${view.reference ? ` ${view.reference}` : ""} ` +
    `on ${pretty(view.receivedOn)}. Receipt ${view.ref}.`;

  if (view.alreadyConfirmedAt) {
    return htmlPage("Already confirmed 🌊", `${line}\n\nYou've confirmed this one — nothing more to do.`);
  }

  // Two buttons, equally weighted. A page with only "yes" is a rubber stamp,
  // which is why htmlPage's single-button form isn't used here.
  return confirmPage(token, line);
}

/**
 * htmlPage only renders one button, so the two-answer page is built here. Both
 * answers are the same size and weight — making "yes" the easy one is how you
 * get agreement that means nothing.
 */
function confirmPage(token: string, line: string): Response {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const t = encodeURIComponent(token);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Does this look right? — LakeLife</title><style>
body{margin:0;background:#f4f7f8;color:#0a2430;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.card{max-width:520px;margin:36px auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 2px 18px rgba(10,36,48,.08)}
h1{font-size:22px;margin:0 0 14px}
p{white-space:pre-wrap;margin:0 0 18px}
button{width:100%;min-height:48px;border:0;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer}
.yes{background:#d9a441;color:#0a2430}
.no{background:#fff;color:#0a2430;border:2px solid #cbd8dd;margin-top:10px}
</style></head><body><div class="card">
<h1>Does this look right?</h1>
<p>${esc(line)}</p>
<p>If that matches what you handed over, tap the first button. If it doesn&#39;t, tap the second and the park will look into it — nothing will be chased while they do.</p>
<form method="post" action="/c/${t}"><button class="yes" name="answer" value="yes" type="submit">Yes, that&#39;s right</button></form>
<form method="post" action="/c/${t}"><button class="no" name="answer" value="no" type="submit">That&#39;s not what I paid</button></form>
</div></body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await req.formData().catch(() => null);
  const answer = String(form?.get("answer") ?? "yes");

  if (answer === "no") {
    const res = await disputeByToken(token);
    if (!res.ok) return htmlPage("We couldn't save that", res.error ?? "Give the park a call. 🌊", false);
    return htmlPage(
      "Thanks — we've flagged it 🌊",
      "The park has been told this doesn't match what you paid. " +
        "Nothing will be chased on this bill while they look into it. " +
        "If you have a receipt or a check number, bring it in.",
    );
  }

  const res = await confirmByToken(token);
  if (!res.ok) return htmlPage("We couldn't save that", res.error ?? "Give the park a call. 🌊", false);
  return htmlPage(
    "Thanks 🌊",
    "That's on the record now, from you as well as the park. Keep your receipt.",
  );
}
