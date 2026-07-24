import { htmlPage } from "@/app/a/[token]/respond";
import { loadDisputeByToken, customerResolved } from "@/lib/disputes";

/**
 * Make-It-Right — customer accepts (photos convinced them, or the fix
 * satisfied them informally). GET is SAFE (renders a confirm button only;
 * SMS link-preview prefetchers issue GETs and must never release money) —
 * the payout releases on POST via customerResolved.
 */

export const dynamic = "force-dynamic";

const OPEN = ["crew_review", "verifying", "talk", "fixing"];

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const d = await loadDisputeByToken("customer", token);
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
  const d = await loadDisputeByToken("customer", token);
  if (!d) return htmlPage("That link isn't right", "This link doesn't match anything. 🌊", false);

  const r = await customerResolved(token);
  if (!r.ok) return htmlPage("Already settled ✓", r.error ?? "This one's already closed out. 🌊");
  return htmlPage("Thanks — glad we could make it right 🌊", "This one's closed out. See you next time.");
}
