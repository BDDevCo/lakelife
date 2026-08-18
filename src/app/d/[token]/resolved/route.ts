import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, customerResolved } from "@/lib/disputes";
import { ReadFailed } from "@/lib/must-read";

/**
 * Make-It-Right — customer accepts (photos convinced them, or the fix
 * satisfied them informally). GET is SAFE (renders a confirm button only;
 * SMS link-preview prefetchers issue GETs and must never release money) —
 * the payout releases on POST via customerResolved.
 */

export const dynamic = "force-dynamic";

const OPEN = ["crew_review", "verifying", "talk", "fixing"];

/**
 * A ROUTE HANDLER HAS NO ERROR BOUNDARY — src/app/error.tsx wraps page and
 * layout renders, not this. loadDisputeByToken now THROWS ReadFailed rather
 * than returning null on a dropped read (a valid link is not an unknown one),
 * so uncaught it is a bare 500 on a link that releases somebody's pay. Catch it
 * and say the only true thing: we couldn't look, and nothing changed. `null`
 * still means the token genuinely matches nothing.
 */
async function loadForCustomer(tok: string): Promise<{ d: Awaited<ReturnType<typeof loadDisputeByToken>>; readFailed: boolean }> {
  try {
    return { d: await loadDisputeByToken("customer", tok), readFailed: false };
  } catch (e) {
    if (e instanceof ReadFailed) return { d: null, readFailed: true };
    throw e;
  }
}

const couldNotCheck = () =>
  htmlPage(
    "We couldn't check just now",
    "Something on our end didn't answer, so nothing has changed — we haven't closed anything out or released any pay. Give it another tap in a minute. 🌊",
    false,
  );

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCustomer(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (!OPEN.includes(d.status)) {
    return htmlPage("Already settled ✓", "This one's already closed out — thank you. 🌊");
  }
  return htmlPage(
    "Glad it's settled? 🌊",
    "One tap and we'll close this out — your crew gets the credit for making it right.",
    true,
    new URL(req.url).pathname,
    "Yes — this settles it",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCustomer(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await customerResolved(token);
  // "Already settled ✓" is a claim about a dispute we may never have read:
  // customerResolved refuses both when the dispute really is closed and when
  // the read behind it failed. `readFailed` is what tells those apart.
  if (!r.ok && r.readFailed) return htmlPage("We couldn't check just now", r.error ?? "Nothing has changed. Give it another tap in a minute. 🌊", false);
  if (!r.ok) return htmlPage("Already settled ✓", r.error ?? "This one's already closed out. 🌊");
  return htmlPage("Thanks — glad we could make it right 🌊", "This one's closed out. See you next time.");
}
