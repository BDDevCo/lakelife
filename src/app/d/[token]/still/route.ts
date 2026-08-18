import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, customerStill } from "@/lib/disputes";
import { ReadFailed } from "@/lib/must-read";

/**
 * Make-It-Right — customer says it's STILL not right. GET is SAFE (renders
 * a confirm button only; SMS link-preview prefetchers issue GETs and must
 * never fire the refund policy) — the policy engine decides on POST via
 * customerStill: small verified charges refund themselves, everything else
 * escalates to a human with the file already complete.
 */

export const dynamic = "force-dynamic";

const OPEN = ["verifying", "talk", "fixing", "crew_review"];

/**
 * A ROUTE HANDLER HAS NO ERROR BOUNDARY — src/app/error.tsx wraps page and
 * layout renders, not this. loadDisputeByToken now THROWS ReadFailed rather
 * than returning null on a dropped read (a valid link is not an unknown one),
 * so uncaught it is a bare 500 on the one link a customer was given. Catch it
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
    "Something on our end didn't answer, so nothing has changed — we haven't closed anything out, and nothing has been charged or refunded. Give it another tap in a minute. 🌊",
    false,
  );

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCustomer(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (!OPEN.includes(d.status)) {
    return htmlPage("Already settled", "This one's already closed out. 🌊");
  }
  return htmlPage(
    "Still not right? 🌊",
    "Sorry to hear it — tap below and we'll take it from here. No return visit needed.",
    true,
    new URL(req.url).pathname,
    "Yes — still not right",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCustomer(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await customerStill(token);
  // "Already settled" USED to be the only way this could refuse — customerStill
  // had no read-failure path. It has seven now (every read firePolicy makes to
  // decide the money), and announcing one of those as a settlement tells a
  // customer their complaint is closed when it was never even read. The two
  // refusals are distinguished by `readFailed`, not by the sentence.
  if (!r.ok && r.readFailed) return htmlPage("We couldn't check just now", r.error ?? "Nothing has changed. Give it another tap in a minute. 🌊", false);
  if (!r.ok) return htmlPage("Already settled", r.error ?? "This one's already closed out. 🌊");
  if (r.refunded) {
    return htmlPage("Sorry it's still not right — we'll take it from here 🌊", "A refund is on the way. No further action needed from you.");
  }
  return htmlPage("Sorry it's still not right — we'll take it from here 🌊", "Our team has it and will follow up shortly.");
}
