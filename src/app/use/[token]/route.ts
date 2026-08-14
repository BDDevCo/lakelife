import { htmlPage, escapeHtml } from "@/app/a/[token]/respond";
import {
  loadGuestView, bookDayByToken, cancelDayByToken, type GuestView,
} from "@/lib/amenity-guest-server";

/**
 * "WHAT CAN I BOOK WHILE I'M HERE?" — one link, no account.
 *
 * GET IS SAFE and only renders buttons. SMS link-preview crawlers issue GETs,
 * and a GET that booked a boat would hand somebody a $150 day for opening a
 * text message. Same scar the extend-stay links carry.
 *
 * Every POST re-derives authority from the token alone and then re-renders the
 * WHOLE page with fresh days. There is deliberately no retry button: if the day
 * went while she was reading, tapping again would fail the same way, and the
 * honest response is a current list plus a sentence about what happened.
 */

export const dynamic = "force-dynamic";

const pretty = (iso: string): string => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
};

const prevDay = (iso: string) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function page(view: GuestView, path: string, note?: { text: string; ok: boolean }): Response {
  const css = `
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f2f7f8;color:#0a2430}
  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 48px}
  .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(10,36,48,.08);padding:20px 18px;margin-bottom:14px}
  h1{font-size:21px;margin:0 0 4px}
  h2{font-size:17px;margin:0 0 2px}
  p{font-size:14px;color:#48626e;line-height:1.5;margin:0}
  .rules{font-size:13.5px;color:#0a2430;font-style:italic;margin:8px 0 0}
  .price{font-size:13px;font-weight:800;color:#0e7a6a}
  .row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #e6eef0}
  .day{font-size:14.5px;font-weight:700;min-width:104px}
  .why{font-size:13px;color:#7b929c;flex:1}
  .take{margin-left:auto;border:0;border-radius:10px;background:#d9a441;color:#0a2430;font-size:14px;font-weight:800;padding:10px 16px;min-height:44px;cursor:pointer}
  .give{margin-left:auto;border:1px solid #e6eef0;border-radius:10px;background:#fff;color:#48626e;font-size:13px;font-weight:700;padding:8px 12px;min-height:40px;cursor:pointer}
  .note{border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:14px;line-height:1.5}
  .note.ok{background:#e0f2ef;color:#0e7a6a}
  .note.no{background:#fdf1dc;color:#8a5d10}
  .mine{font-size:14px;font-weight:700}
  form{display:contents}
  `;

  const noteHtml = note
    ? `<div class="note ${note.ok ? "ok" : "no"}">${escapeHtml(note.text)}</div>`
    : "";

  const mineHtml = view.mine.length
    ? `<div class="card"><h2>What you have</h2>
       ${view.mine.map((m) => `
         <div class="row">
           <span class="mine">${escapeHtml(m.unit)}</span>
           <span class="why">${escapeHtml(pretty(m.from))}${m.to > "" && prevDay(m.to) !== m.from ? ` – ${escapeHtml(pretty(prevDay(m.to)))}` : ""}${m.amount ? ` · $${m.amount.toFixed(2)}` : " · included"}</span>
           <form method="post" action="${escapeHtml(path)}">
             <input type="hidden" name="give" value="${escapeHtml(m.id)}">
             <button class="give" type="submit">Give it back</button>
           </form>
         </div>`).join("")}
       </div>`
    : "";

  const offersHtml = view.offers.map((o) => {
    const units = o.units.map((u) => {
      const rows = u.days.map((d) => {
        if (d.open) {
          return `<div class="row">
            <span class="day">${escapeHtml(pretty(d.day))}</span>
            <form method="post" action="${escapeHtml(path)}">
              <input type="hidden" name="unit" value="${escapeHtml(u.unitId)}">
              <input type="hidden" name="day" value="${escapeHtml(d.day)}">
              <button class="take" type="submit">Take it</button>
            </form>
          </div>`;
        }
        // A greyed square with no reason is what makes somebody ring the
        // office. And HER day is not greyed at all — it is hers.
        return `<div class="row">
          <span class="day"${d.mine ? "" : ` style="color:#a8bcc4"`}>${escapeHtml(pretty(d.day))}</span>
          <span class="why"${d.mine ? ` style="color:#0e7a6a;font-weight:700"` : ""}>${escapeHtml(d.why)}</span>
        </div>`;
      }).join("");
      const heading = o.units.length > 1
        ? `<p style="font-size:13px;font-weight:800;margin-top:12px">${escapeHtml(u.label)}</p>` : "";
      return heading + rows;
    }).join("");

    return `<div class="card">
      <h2>${escapeHtml(o.name)}</h2>
      <span class="price">${escapeHtml(o.price)}</span>
      ${o.rules ? `<p class="rules">&ldquo;${escapeHtml(o.rules)}&rdquo;</p>` : ""}
      ${units}
    </div>`;
  }).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>While you're here — LakeLife</title><style>${css}</style></head>
    <body><div class="wrap">
      <div class="card">
        <h1>Hi ${escapeHtml(view.firstName)} 🌊</h1>
        <p>You're on site ${escapeHtml(view.lotNumber)} at ${escapeHtml(view.parkName)},
           ${escapeHtml(pretty(view.from))} to ${escapeHtml(pretty(prevDay(view.to)))}.
           Here's what you can book while you're here.</p>
      </div>
      ${noteHtml}
      ${mineHtml}
      ${view.nothing ? `<div class="card"><p>${escapeHtml(view.nothing)}</p></div>` : offersHtml}
    </div></body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const view = await loadGuestView(token);
  if (!view) {
    return htmlPage("That link isn't right", "This link doesn't match a stay. 🌊", false);
  }
  return page(view, new URL(req.url).pathname);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await req.formData();
  const path = new URL(req.url).pathname;

  const give = String(form.get("give") ?? "");
  const res = give
    ? await cancelDayByToken(token, give)
    : await bookDayByToken(token, String(form.get("unit") ?? ""), String(form.get("day") ?? ""));

  // FRESH DAYS, ALWAYS — including after a failure. The one thing she must not
  // be shown is the list that was true a moment ago.
  const view = await loadGuestView(token);
  if (!view) {
    return htmlPage("That link isn't right", "This link doesn't match a stay. 🌊", false);
  }
  return page(view, path, {
    text: res.ok ? (res.signal ?? "Done.") : (res.error ?? "That didn't work."),
    ok: res.ok,
  });
}
