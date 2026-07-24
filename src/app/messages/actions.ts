"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getPlatformSettings } from "@/lib/settings";
import { classifyCustomerMessage, WHITELIST } from "@/lib/comms-classify";
import { draftCustomerReply } from "@/lib/comms-draft";

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Confirm the signed-in user owns this property. Returns their id or null. */
async function assertOwnerProperty(propertyId: string): Promise<{ userId: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createServiceClient();
  const { data } = await admin
    .from("properties")
    .select("id, owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!data || data.owner_id !== user.id) return null;
  return { userId: user.id };
}

/**
 * Messaging autonomy Level 1 (Autonomy Ladder, owner directive 2026-07-23).
 * Runs AFTER the owner's message is safely inserted, and never throws past
 * itself — a classifier/draft hiccup must never break the customer's send.
 * Auto-sends only when EVERY gate holds: the dial is on, the message clears
 * the risk screen, confidence is 'high', the intent is on WHITELIST, and the
 * drafted reply is real (never a mock draft). Otherwise it's a no-op and a
 * human sees the message on the ops board, same as today.
 */
async function maybeAutoReply(
  admin: ReturnType<typeof createServiceClient>,
  propertyId: string,
  ownerId: string,
  body: string,
): Promise<void> {
  const settings = await getPlatformSettings();
  if (settings.aiAutoreplyEnabled !== 1) return;

  // Cost/abuse rail: at most 2 auto-replies per property per hour — a
  // rapid-fire thread gets a human, not an AI echo chamber.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count: recentAi } = await admin
    .from("messages").select("id", { count: "exact", head: true })
    .eq("property_id", propertyId).eq("ai", true).gte("created_at", hourAgo);
  if ((recentAi ?? 0) >= 2) return;

  // Never two machine turns in a row: if the last board message before this
  // one was an AI reply, the next word belongs to a human — either the
  // customer moving the thread forward or ops stepping in.
  const { data: lastRows } = await admin
    .from("messages").select("ai")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false })
    .limit(2);
  if (((lastRows ?? [])[1] as { ai?: boolean } | undefined)?.ai) return;

  const { intent, confidence, risky } = await classifyCustomerMessage(body);
  if (risky || confidence !== "high" || !WHITELIST.includes(intent)) return;

  const { data: rows } = await admin
    .from("messages")
    .select("from_user, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true })
    .limit(50);
  const thread = (rows ?? []).slice(-6).map((r) => ({
    from: (r.from_user === ownerId ? "owner" : "ops") as "owner" | "ops",
    body: (r.body as string) ?? "",
  }));

  const draft = await draftCustomerReply(ownerId, thread);
  if (!draft.ok || draft.mock || !draft.text) return; // never auto-send a mock draft

  const { data: opsUser } = await admin
    .from("users")
    .select("id")
    .eq("role", "ops")
    .limit(1)
    .maybeSingle();
  const opsId = opsUser?.id as string | undefined;
  if (!opsId) return;

  await admin.from("messages").insert({
    property_id: propertyId,
    from_user: opsId,
    body: draft.text,
    ai: true,
  });
}

/**
 * Owner sends a message to LakeLife dispatch. The sender is recorded as the
 * owner's own user id (from_user); the read side labels it "owner" because
 * from_user == the property's owner_id.
 */
export async function sendOwnerMessage(propertyId: string, body: string): Promise<SendResult> {
  const ctx = await assertOwnerProperty(propertyId);
  if (!ctx) return { ok: false, error: "That property isn't yours." };

  const text = body.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Type a message first." };

  const admin = createServiceClient();
  const { error } = await admin.from("messages").insert({
    property_id: propertyId,
    from_user: ctx.userId,
    body: text,
  });
  if (error) return { ok: false, error: error.message };

  try {
    await maybeAutoReply(admin, propertyId, ctx.userId, text);
  } catch {
    // Classifier/draft/DB hiccup — the customer's send already succeeded;
    // a human will see the message on the ops board regardless.
  }

  return { ok: true };
}
