import { htmlPage } from "@/app/a/[token]/respond";
import { loadExtendByToken, extendByToken } from "@/lib/extend-server";

/**
 * ONE-TAP EXTEND, for a renter who has no account and may never have one.
 *
 * GET IS SAFE and only renders a confirm button. SMS link-preview prefetchers
 * issue GETs, and a GET that extended a stay would bill people for opening a
 * text message. Same discipline as the Make-It-Right links.
 */

export const dynamic = "force-dynamic";

function pretty(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const view = await loadExtendByToken(token);
  if (!view) {
    return htmlPage("That link isn't right", "This link doesn't match a stay. 🌊", false);
  }
  if (view.refusal || !view.newEnd) {
    return htmlPage("We can't do that from here", view.message ?? "Give the park a call. 🌊", false);
  }

  const money = view.price != null ? ` for $${view.price.toLocaleString()}` : "";

  // A capped park is not extending anything — it is starting the NEXT
  // agreement, and calling that "keep your spot" would be telling somebody
  // they are doing something smaller than they are. It is a fresh term with
  // its own dates, and the only thing that carries over is the deposit.
  if (view.isRenewal) {
    const months = view.capMonths ?? 3;
    return htmlPage(
      `Stay on at site ${view.lotNumber}? 🌊`,
      `Your agreement runs to ${pretty(view.currentEnd)}. ` +
        `Tapping below starts a NEW ${months}-month agreement, ` +
        `${pretty(view.newStart!)} to ${pretty(view.newEnd)}${money}. ` +
        `Your deposit carries over — there's nothing more to pay on it. ` +
        `${view.parkName} will send the agreement to sign.`,
      true,
      new URL(req.url).pathname,
      `Yes — start the next ${months} months`,
    );
  }

  return htmlPage(
    `Stay longer on site ${view.lotNumber}? 🌊`,
    `Right now you're booked through ${pretty(view.currentEnd)}. ` +
      `Tap below to keep it through ${pretty(view.newEnd)}${money}. ` +
      `${view.parkName} will see it straight away.`,
    true,
    new URL(req.url).pathname,
    `Yes — keep it through ${pretty(view.newEnd)}`,
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const res = await extendByToken(token);
  if (!res.ok) {
    return htmlPage("We couldn't extend it", res.error ?? "Give the park a call. 🌊", false);
  }
  return htmlPage(
    "You're set 🌊",
    `Your site is yours through ${pretty(res.newEnd!)}. ` +
      `The park will send the paperwork if there's any to sign — ` +
      `nothing more to pay on your deposit.`,
  );
}
