import "server-only";
import { aiComplete } from "@/lib/ai";
import { screenMessage, type Population, type Outcome } from "@/lib/comms-fence";

/**
 * Messaging autonomy — Level 1 classifier (Autonomy Ladder, owner directive
 * 2026-07-23). Every homeowner message that could be auto-answered runs
 * through this first. Two gates, cheapest first:
 *
 *   1. A pure risk screen — no AI call, no cost, no ambiguity. Any message
 *      that even smells like money, anger, or legal exposure is `risky`
 *      and the AI is never consulted about it.
 *   2. Only messages that clear the screen go to the model for a narrow
 *      intent + confidence read.
 *
 * This module only classifies — it never decides to send anything. The
 * caller (the homeowner send action) still requires aiAutoreplyEnabled=1,
 * confidence 'high', and intent on WHITELIST before it will auto-send, and
 * it never sends a mock draft. Without an ANTHROPIC_API_KEY, aiComplete
 * returns mock:true and this classifier comes back {intent:'other',
 * confidence:'low', risky:false} — autonomy silently stays off.
 */

export type Confidence = "high" | "medium" | "low";

export interface ClassifyResult {
  intent: string;
  confidence: Confidence;
  /** Kept for the existing callers: true whenever the fence refused to let the
   *  model see the message. */
  risky: boolean;
  /** The fence's full verdict, so ops can be told WHY rather than just "held". */
  outcome: Outcome;
  /** The one line ops reads on the board. Null when nothing fired. */
  opsLine: string | null;
  /** Population-aware: false for every tenant, park owner, crew and RV guest
   *  at launch, no matter how innocuous the message. */
  mayAutoSend: boolean;
}

/** Intents narrow and low-stakes enough to auto-send a reply to (Level 1). */
export const WHITELIST: string[] = [
  "schedule_question",
  "confirmation_ack",
  "access_info_ack",
  "receipt_request",
  "thanks",
];

/**
 * THE RISK SCREEN NOW LIVES IN lib/comms-fence.ts.
 *
 * What used to be here was twenty words matched as SUBSTRINGS, and it was
 * backwards in both directions. It cleared every housing message we tested —
 * "can I get a ramp? I use a wheelchair" was eligible for a machine reply —
 * while blocking the safest traffic we have, because "free" matches inside
 * "freeze", "sue" inside "issue" and "owed" inside "showed".
 *
 * The replacement matches whole tokens and whole phrases, knows which
 * POPULATION is on the other end (a tenant is not a lake homeowner and fair
 * housing applies to them), and returns four outcomes rather than a boolean:
 * allow / hold / never_ai / emergency. See docs/ai-safety-fence.md.
 */

const SYSTEM = `Classify a homeowner's message to LakeLife, a lake-home services company.
Respond with STRICT JSON only — no prose, no markdown fences:
{"intent": one of "schedule_question","confirmation_ack","access_info_ack","receipt_request","thanks","other", "confidence": one of "high","medium","low"}`;

/** Strip a ```json fenced block if the model wraps its answer in one. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export async function classifyCustomerMessage(
  body: string,
  population: Population = "unknown",
): Promise<ClassifyResult> {
  // GATE 1: the fence. Pure, no AI call, no cost.
  //
  // `population` defaults to "unknown", which is the FAIL-CLOSED lane: every
  // rule runs and nothing auto-sends. A caller that has not been taught to
  // stamp the population therefore gets the strictest treatment, rather than
  // the loosest — which is the opposite of what the old default did.
  const fence = screenMessage(body, population);
  if (fence.outcome !== "allow") {
    return {
      intent: "other",
      confidence: "low",
      risky: true,
      outcome: fence.outcome,
      opsLine: fence.opsLine,
      mayAutoSend: false,
    };
  }

  // Gate 2: model classification.
  const res = await aiComplete({
    system: SYSTEM,
    user: `Message: ${body}`,
    maxTokens: 100,
  });

  if (res.mock || !res.ok || !res.text) {
    // No API key (or a failed call) — autonomy silently stays off.
    return { intent: "other", confidence: "low", risky: false, outcome: "allow", opsLine: null, mayAutoSend: false };
  }

  try {
    const parsed = JSON.parse(unfence(res.text)) as { intent?: unknown; confidence?: unknown };
    const intent = typeof parsed.intent === "string" && parsed.intent ? parsed.intent : "other";
    const confidence: Confidence =
      parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
        ? parsed.confidence
        : "low";
    return { intent, confidence, risky: false, outcome: "allow", opsLine: null, mayAutoSend: fence.mayAutoSend };
  } catch {
    return { intent: "other", confidence: "low", risky: false, outcome: "allow", opsLine: null, mayAutoSend: false };
  }
}
