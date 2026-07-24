import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, crewChooseTalk } from "@/lib/disputes";

/**
 * Make-It-Right — crew wants to talk it through. GET is SAFE (renders a
 * confirm button only; SMS link-preview prefetchers issue GETs and must
 * never change anything) — opening the message thread happens on POST via
 * crewChooseTalk, which re-checks the dispute is still open.
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
    "Want to talk it through? 🌊",
    "We'll open a message thread with the customer so you can sort this out together — no return visit needed yet.",
    true,
    new URL(req.url).pathname,
    "Yes — let's talk",
  );
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("crew", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await crewChooseTalk(token);
  if (!r.ok) return htmlPage("Hmm, that didn't take", r.error ?? "Give it another tap in a minute. 🌊", false);
  return htmlPage(
    "Opened — check Messages 🌊",
    "The customer's been told you want to talk it through. Continue the conversation from Messages in your portal.",
  );
}
