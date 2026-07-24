import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, customerStill } from "@/lib/disputes";

/**
 * Make-It-Right — customer says it's STILL not right. GET is SAFE (renders
 * a confirm button only; SMS link-preview prefetchers issue GETs and must
 * never fire the refund policy) — the policy engine decides on POST via
 * customerStill: small verified charges refund themselves, everything else
 * escalates to a human with the file already complete.
 */

export const dynamic = "force-dynamic";

const OPEN = ["verifying", "talk", "fixing", "crew_review"];

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("customer", token);
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
  const d = await loadDisputeByToken("customer", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await customerStill(token);
  if (!r.ok) return htmlPage("Already settled", r.error ?? "This one's already closed out. 🌊");
  if (r.refunded) {
    return htmlPage("Sorry it's still not right — we'll take it from here 🌊", "A refund is on the way. No further action needed from you.");
  }
  return htmlPage("Sorry it's still not right — we'll take it from here 🌊", "Our team has it and will follow up shortly.");
}
