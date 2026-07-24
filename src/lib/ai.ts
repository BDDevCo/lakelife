import "server-only";

/**
 * The ONE Claude API integration point (owner directive, 2026-07-23) —
 * exactly the payments pattern: everything upstream builds against this
 * seam, which runs in MOCK mode until ANTHROPIC_API_KEY lands in the
 * environment, then lights up with zero changes anywhere else.
 *
 * Callers own their mock fallbacks (they have the context to write a
 * useful deterministic draft); this module only talks to the API.
 */

export interface AiResult {
  ok: boolean;
  text?: string;
  mock?: boolean; // true = no API key, caller should use its fallback
  error?: string;
}

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Default drafting model — smart enough for customer-facing words,
 *  priced for every-message use. Vision/QA work will pin its own model. */
const DRAFT_MODEL = "claude-sonnet-5";

export async function aiComplete(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AiResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, mock: true };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: DRAFT_MODEL,
        max_tokens: opts.maxTokens ?? 400,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `AI ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    if (!text) return { ok: false, error: "AI returned no text." };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "AI call failed" };
  }
}
