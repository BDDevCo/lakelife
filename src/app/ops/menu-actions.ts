"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { executeMenuUpdate, type ApplyMenuSuggestionInput, type ApplyMenuSuggestionResult } from "@/lib/menu-core";

/**
 * Apply a Margin Health price-up suggestion (docs/margin-gap-design.md
 * follow-on) — one tap turns a margin_stranded row's suggested raise into
 * a live menu change. Ops-only; the executor lives in lib/menu-core.ts
 * (server-only) so this "use server" module exports NOTHING ungated.
 */
export async function applyMenuSuggestion(input: ApplyMenuSuggestionInput): Promise<ApplyMenuSuggestionResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Ops only." };
  const admin = createServiceClient();
  return executeMenuUpdate(admin, input);
}
