import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, crewChooseVerify } from "@/lib/disputes";
import { ReadFailed } from "@/lib/must-read";

/**
 * Make-It-Right — crew stands by the work. GET is SAFE (renders a confirm
 * button only; SMS link-preview prefetchers issue GETs and must never
 * change anything) — sending the customer to the photo evidence happens on
 * POST via crewChooseVerify, which re-checks the dispute is still open.
 */

export const dynamic = "force-dynamic";

/**
 * A ROUTE HANDLER HAS NO ERROR BOUNDARY — src/app/error.tsx wraps page and
 * layout renders, not this. loadDisputeByToken now THROWS ReadFailed rather
 * than returning null on a dropped read (a valid link is not an unknown one),
 * so uncaught it is a bare 500 on the link holding this crew's pay. Catch it
 * and say the only true thing: we couldn't look, and nothing changed. `null`
 * still means the token genuinely matches nothing.
 */
async function loadForCrew(tok: string): Promise<{ d: Awaited<ReturnType<typeof loadDisputeByToken>>; readFailed: boolean }> {
  try {
    return { d: await loadDisputeByToken("crew", tok), readFailed: false };
  } catch (e) {
    if (e instanceof ReadFailed) return { d: null, readFailed: true };
    throw e;
  }
}

const couldNotCheck = () =>
  htmlPage(
    "We couldn't check just now",
    "Something on our end didn't answer, so nothing has changed — we haven't booked, sent or settled anything. Give it another tap in a minute. 🌊",
    false,
  );

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCrew(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);
  if (d.status !== "crew_review") {
    return htmlPage("Already moving", "This one's already moving — check your Today list. 🌊");
  }
  return htmlPage(
    "Stand by your work? 🌊",
    "The customer will be shown your completion photos and asked whether that settles it — no return visit.",
    true,
    new URL(req.url).pathname,
    "Yes — I stand by it",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const { d, readFailed } = await loadForCrew(token);
  if (readFailed) return couldNotCheck();
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await crewChooseVerify(token);
  if (!r.ok) return htmlPage("Hmm, that didn't take", r.error ?? "Give it another tap in a minute. 🌊", false);
  return htmlPage(
    "Sent — over to the customer 🌊",
    "They'll see your completion photos and let us know if that settles it. We'll update you either way.",
  );
}
