import "server-only";
import { aiComplete } from "@/lib/ai";

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
  risky: boolean;
}

/** Intents narrow and low-stakes enough to auto-send a reply to (Level 1). */
export const WHITELIST: string[] = [
  "schedule_question",
  "confirmation_ack",
  "access_info_ack",
  "receipt_request",
  "thanks",
];

// Substring match on the lowercased body — deliberately broad. A false
// positive here just means a human reads the message on the ops board,
// same as today; a false negative means the machine answers something it
// shouldn't. Bias toward caution.
const RISK_WORDS = [
  "refund",
  "money",
  "charge",
  "angry",
  "terrible",
  "lawyer",
  "attorney",
  "sue",
  "damage",
  "broke",
  "cancel",
  "complaint",
  // Commitment smells — a message asking the machine to ratify a deal
  // ("confirming next month is free like your guy promised") must reach a
  // human even when it's wrapped in a thank-you (review finding). "free"
  // also catches "freeze" — a false positive here is just a human reading.
  "dispute",
  "waive",
  "free",
  "credit",
  "promise",
  "discount",
  "owed",
  "bill",
];

function isRisky(body: string): boolean {
  const lower = body.toLowerCase();
  return RISK_WORDS.some((word) => lower.includes(word));
}

const SYSTEM = `Classify a homeowner's message to LakeLife, a lake-home services company.
Respond with STRICT JSON only — no prose, no markdown fences:
{"intent": one of "schedule_question","confirmation_ack","access_info_ack","receipt_request","thanks","other", "confidence": one of "high","medium","low"}`;

/** Strip a ```json fenced block if the model wraps its answer in one. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export async function classifyCustomerMessage(body: string): Promise<ClassifyResult> {
  // Gate 1: pure risk screen, no AI call.
  if (isRisky(body)) {
    return { intent: "other", confidence: "low", risky: true };
  }

  // Gate 2: model classification.
  const res = await aiComplete({
    system: SYSTEM,
    user: `Message: ${body}`,
    maxTokens: 100,
  });

  if (res.mock || !res.ok || !res.text) {
    // No API key (or a failed call) — autonomy silently stays off.
    return { intent: "other", confidence: "low", risky: false };
  }

  try {
    const parsed = JSON.parse(unfence(res.text)) as { intent?: unknown; confidence?: unknown };
    const intent = typeof parsed.intent === "string" && parsed.intent ? parsed.intent : "other";
    const confidence: Confidence =
      parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
        ? parsed.confidence
        : "low";
    return { intent, confidence, risky: false };
  } catch {
    return { intent: "other", confidence: "low", risky: false };
  }
}
