import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, crewChooseVerify } from "@/lib/disputes";

/**
 * Make-It-Right — crew stands by the work. GET is SAFE (renders a confirm
 * button only; SMS link-preview prefetchers issue GETs and must never
 * change anything) — sending the customer to the photo evidence happens on
 * POST via crewChooseVerify, which re-checks the dispute is still open.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("crew", token);
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
  const d = await loadDisputeByToken("crew", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await crewChooseVerify(token);
  if (!r.ok) return htmlPage("Hmm, that didn't take", r.error ?? "Give it another tap in a minute. 🌊", false);
  return htmlPage(
    "Sent — over to the customer 🌊",
    "They'll see your completion photos and let us know if that settles it. We'll update you either way.",
  );
}
