import { htmlPage } from "@/app/a/[token]/respond";
import { loadExtendByToken, type ExtendView, extendByToken } from "@/lib/extend-server";
import { ReadFailed } from "@/lib/must-read";
import { lengthInWords } from "@/app/park/agreement-helpers";

/**
 * ONE-TAP EXTEND, for a renter who has no account and may never have one.
 *
 * GET IS SAFE and only renders a confirm button. SMS link-preview prefetchers
 * issue GETs, and a GET that extended a stay would bill people for opening a
 * text message. Same discipline as the Make-It-Right links.
 *
 * AT A CAPPED PARK THE TAP IS A CHOICE. The owner's decision: the household
 * picks one, three or six months at every renewal. So the page offers one
 * button per length the park writes (only the ones the tap can honour — the
 * loader drops a length whose dates are already taken), each posting its
 * length, and the write re-validates that length against the park as it
 * stands now. This page used to name ONE length — the cap — and the tap
 * wrote it. The buttons are `htmlPage`'s own `choices` — the same card every
 * token page renders, from one home.
 */

export const dynamic = "force-dynamic";

function pretty(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
}

/** "$425 a month" on a monthly tenancy; "$425" otherwise. */
function rentWords(view: { price: number | null; term: string }): string {
  return view.price != null
    ? `$${view.price.toLocaleString()}${view.term === "monthly" ? " a month" : ""}`
    : "";
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // The loader THROWS on a failed read and this Route Handler has no error
  // boundary. A renter here has no account to sign into, so a bare 500 is a
  // dead end — and "this link doesn't match a stay" would assert a fact we
  // couldn't read.
  let view: ExtendView | null;
  try {
    view = await loadExtendByToken(token);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return htmlPage(
      "We couldn't load that just now",
      "Nothing has changed and nothing has been charged. Open the link again in a moment — if it keeps happening, give the park a call. 🌊",
      false,
    );
  }
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
  // its own dates, and the only thing that can carry over is a deposit, when
  // the park is holding one.
  if (view.isRenewal) {
    // `price` is the rent in force on the successor's first morning — the
    // number every button writes — and on a monthly tenancy it is a MONTHLY
    // rent, not the price of the whole agreement. "for $425" alone reads as
    // the latter.
    const rent = view.price != null ? ` at ${rentWords(view)}` : "";
    // Only to somebody the park is actually holding a deposit for. This
    // sentence used to be printed to everyone, and at a park where nobody
    // has paid one it described a deposit that did not exist.
    const deposit = view.depositHeld
      ? `Your deposit carries over — there's nothing more to pay on it. `
      : "";
    // THE CHOICE. One button per length the park writes and the tap can
    // honour, each posting `months`; the sentence names no single length,
    // because none is chosen yet. A park that offers one length gets one
    // button, worded the same.
    // Built from the view's LENGTHS, not the bare numbers: a slip lot's
    // season can cut a length short, and a button that says "3 months" for
    // an agreement the tap writes to the season close is a button that lies.
    const choices = view.lengths.map(({ months, end, cutShortBySeason }) => ({
      name: "months",
      value: String(months),
      label: cutShortBySeason
        ? `Renew for ${lengthInWords(months)} — cut short by the season close, to ${pretty(end)}`
        : `Renew for ${lengthInWords(months)}`,
    }));
    // One length on offer is not a choice; say what the tap does.
    const ask = choices.length === 1
      ? `Tapping below starts the next agreement — ${lengthInWords(view.lengths[0].months)} from ${pretty(view.newStart!)}${rent}. `
      : `Pick how long to renew for — the next agreement starts ${pretty(view.newStart!)}${rent}. `;
    return htmlPage(
      `Stay on at site ${view.lotNumber}? 🌊`,
      `Your agreement runs to ${pretty(view.currentEnd)}. ` +
        ask +
        deposit +
        `${view.parkName} will send the agreement to sign.`,
      true,
      new URL(req.url).pathname,
      undefined,
      undefined,
      choices,
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

/** The length the button posted, or null — an extension posts none. */
async function postedMonths(req: Request): Promise<number | null> {
  try {
    const form = await req.formData();
    const raw = form.get("months");
    if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw.trim())) return null;
    return Number(raw.trim());
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const months = await postedMonths(req);
  const res = await extendByToken(token, months);
  if (!res.ok) {
    return htmlPage("We couldn't extend it", res.error ?? "Give the park a call. 🌊", false);
  }
  // A renewal says back what was chosen — the length and its dates — so a
  // tap on the wrong button is caught here and not by the ledger.
  if (res.renewMonths != null && res.newStart && res.newEnd) {
    const rent = res.price != null ? ` at ${rentWords({ price: res.price, term: res.term ?? "monthly" })}` : "";
    return htmlPage(
      "You're set 🌊",
      `Your next agreement runs ${pretty(res.newStart)} to ${pretty(res.newEnd)} — ` +
        `${lengthInWords(res.renewMonths)}${res.cutShortBySeason ? ", cut short by the season close" : ""}${rent}. ` +
        `The park will send the agreement to sign` +
        // Same gate as the page before the tap: a deposit is mentioned only
        // to somebody who paid one.
        (res.depositHeld ? ` — nothing more to pay on your deposit.` : `.`),
    );
  }
  return htmlPage(
    "You're set 🌊",
    `Your site is yours through ${pretty(res.newEnd!)}. ` +
      `The park will send the paperwork if there's any to sign` +
      (res.depositHeld ? ` — nothing more to pay on your deposit.` : `.`),
  );
}
