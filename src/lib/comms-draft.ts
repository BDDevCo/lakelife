import "server-only";
import { aiComplete } from "@/lib/ai";
import { buildCustomerContext, renderCustomerContext } from "@/lib/comms-context";

/**
 * Personalized reply drafting (owner directive, 2026-07-23). The draft is
 * grounded in the person's REAL profile — properties, services, jobs done,
 * upcoming visits, credits — via the rule-1-safe context builders, and the
 * system prompt forbids inventing anything not in that context. Without an
 * API key the deterministic MOCK draft (built from the same context) keeps
 * the whole surface usable and provable; the real model is a drop-in.
 * v1 posture: OPS APPROVES EVERY DRAFT before it sends — the AI writes,
 * the human ships.
 */

const SYSTEM = `You draft replies for LakeLife, a lake-home services platform in Indiana.
Voice: plain, warm, brief (under 110 words), first person plural ("we"), one 🌊 at most.
HARD RULES:
- Use ONLY facts present in the provided context. Never invent prices, dates, crews, or policies.
- Never mention crew pay, platform margin, or internal operations.
- If the customer asks something the context can't answer, say we'll check and follow up — never guess.
- No signatures, no subject lines — just the message body.`;

export interface DraftResult {
  ok: boolean;
  text?: string;
  mock?: boolean;
  error?: string;
}

export async function draftCustomerReply(
  userId: string,
  thread: Array<{ from: string; body: string }>,
): Promise<DraftResult> {
  const ctx = await buildCustomerContext(userId);
  if (!ctx) return { ok: false, error: "Customer not found." };
  const rendered = renderCustomerContext(ctx);
  const lastFromOwner = [...thread].reverse().find((m) => m.from === "owner")?.body ?? "";

  const res = await aiComplete({
    system: SYSTEM,
    user: `CONTEXT ABOUT THIS CUSTOMER:\n${rendered}\n\nCONVERSATION (most recent last):\n${thread
      .slice(-6)
      .map((m) => `${m.from === "owner" ? "Customer" : "LakeLife"}: ${m.body}`)
      .join("\n")}\n\nDraft the next LakeLife reply.`,
  });
  if (res.ok && res.text) return { ok: true, text: res.text, mock: false };
  if (!res.mock) return { ok: false, error: res.error ?? "Draft failed." };

  // MOCK MODE (no ANTHROPIC_API_KEY yet): a deterministic, context-grounded
  // draft so ops can use and we can prove the surface today.
  const firstName = (ctx.name ?? "there").split(" ")[0];
  const upcoming = ctx.jobs.find((j) => j.status === "scheduled" || j.status === "requested");
  const bits: string[] = [`Hi ${firstName} — thanks for the note.`];
  if (lastFromOwner) bits.push(`We're on it.`);
  if (upcoming) bits.push(`Your ${upcoming.service} is set for ${upcoming.date}${upcoming.where ? ` at ${upcoming.where}` : ""} — we'll text when the crew's on the way, with photos after.`);
  if (ctx.creditBalance > 0) bits.push(`You've got $${ctx.creditBalance.toFixed(2)} in credits that apply automatically to your next bill.`);
  bits.push(`Anything else, just reply here. 🌊`);
  return { ok: true, text: bits.join(" "), mock: true };
}
