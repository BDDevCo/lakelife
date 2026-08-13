import { htmlPage, escapeHtml } from "@/app/a/[token]/respond";
import { loadSticker, fileRequestByToken, REQUEST_CATEGORIES } from "@/lib/park-request-server";

/**
 * THE QR STICKER ON A LOT PEDESTAL — /fix/<token>.
 *
 * The blueprint keeps exactly two renter-facing things in season one, and this
 * is one of them: "the QR sticker on the lot pedestal that opens a pre-filled
 * maintenance request with no login", chosen because it "works for a
 * 74-year-old with a flip phone".
 *
 * SO IT IS PLAIN HTML WITH A REAL FORM, not a React page. A QR scan opens in
 * whatever browser the phone hands it — often an in-app one, sometimes an old
 * one — and a server-rendered form with a POST works with no JavaScript at
 * all. Everything else in this product can assume a session and a modern
 * runtime; this cannot assume either.
 *
 * GET IS SAFE. Link-preview fetchers, messaging apps and school filters all
 * issue GETs, and a GET that filed a report would fill the owner's queue with
 * ghosts. The page renders a form; only the POST writes. (Same reasoning as
 * /x/<token>, which learned it first.)
 *
 * IT NAMES THE LOT AND THE PARK AND NOTHING ELSE. A sticker is readable by
 * anyone standing in the park, so this page must never answer "who lives
 * here" — that would be a tenant directory screwed to a post.
 */

function page(
  view: { parkName: string; lotNumber: string },
  token: string,
  problem?: string,
): Response {
  const options = REQUEST_CATEGORIES
    .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
    .join("");
  const warn = problem
    ? `<p class="warn">${escapeHtml(problem)}</p>`
    : "";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report something — LakeLife</title><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f2f7f8;color:#0a2430}
.wrap{max-width:460px;margin:0 auto;padding:20px 16px 48px}
.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(10,36,48,.08);padding:26px 22px}
.badge{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:4px 12px;border-radius:999px;background:#e0f2ef;color:#0e7a6a}
h1{font-size:22px;margin:14px 0 4px}
.sub{font-size:15px;color:#48626e;line-height:1.5;margin:0 0 18px}
label{display:block;font-size:14px;font-weight:700;margin:16px 0 6px}
select,textarea,input{width:100%;box-sizing:border-box;font-size:16px;font-family:inherit;
  padding:12px 13px;border:1.5px solid #dce9ec;border-radius:10px;background:#fff;color:#0a2430}
textarea{min-height:110px;resize:vertical}
button{width:100%;min-height:52px;margin-top:20px;border:0;border-radius:12px;background:#d9a441;
  color:#0a2430;font-size:17px;font-weight:800;cursor:pointer}
.hint{font-size:12.5px;color:#5d7681;line-height:1.5;margin:6px 0 0}
.warn{background:#fdf1dc;color:#9a6b15;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 14px}
</style></head><body><div class="wrap"><div class="card">
<span class="badge">${escapeHtml(view.parkName)}</span>
<h1>Lot ${escapeHtml(view.lotNumber)}</h1>
<p class="sub">Tell the office what needs looking at. No account, no app — this
goes straight to them.</p>
${warn}
<form method="post">
  <label for="category">What kind of thing?</label>
  <select id="category" name="category">${options}</select>

  <label for="note">What&rsquo;s wrong?</label>
  <textarea id="note" name="note" placeholder="e.g. the water riser is leaking under the step" required></textarea>

  <label for="name">Your name <span style="font-weight:400;color:#5d7681">(optional)</span></label>
  <input id="name" name="name" autocomplete="name">

  <label for="phone">Phone, if you want a call back <span style="font-weight:400;color:#5d7681">(optional)</span></label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel">
  <p class="hint">You don&rsquo;t have to leave either. A report with no name is
  still a report.</p>

  <button type="submit">Send it to the office</button>
</form>
</div></div></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A sticker's page is per-lot and must never be served from a shared
      // cache with somebody else's lot number on it.
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const view = await loadSticker(token);
  if (!view) {
    return htmlPage(
      "That sticker isn't working",
      "We can't match this one to a lot. Please ring the office and tell them — the sticker may need replacing. 🌊",
      false,
    );
  }
  if (view.flooded) {
    return htmlPage(
      `Lot ${view.lotNumber}`,
      "There are already several open reports for this lot. Please ring the office so nothing gets missed. 🌊",
      false,
    );
  }
  return page(view, token);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await req.formData().catch(() => null);
  if (!form) {
    return htmlPage("That didn't send", "Please try again, or ring the office. 🌊", false);
  }

  const res = await fileRequestByToken({
    token,
    category: String(form.get("category") ?? "other"),
    note: String(form.get("note") ?? ""),
    name: String(form.get("name") ?? ""),
    phone: String(form.get("phone") ?? ""),
  });

  if (!res.ok) {
    // Re-render the form with what went wrong rather than a dead end — on a
    // phone, "go back" loses everything they typed.
    const view = await loadSticker(token);
    if (view) return page(view, token, res.error);
    return htmlPage("That didn't send", res.error ?? "Please ring the office. 🌊", false);
  }

  return htmlPage(
    "Sent 🌊",
    `${res.signal} Somebody will take a look. If it's urgent — no water, no power, anything unsafe — ring the office as well.`,
  );
}
