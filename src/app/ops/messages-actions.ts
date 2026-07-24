"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { draftCustomerReply, type DraftResult } from "@/lib/comms-draft";

export interface OpsSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Ops replies to an owner on a property's thread. The sender is recorded as the
 * ops user's id (from_user); the read side labels it "ops" because that id is
 * not the property's owner_id. Ops-only — assertOps gates it.
 */
export async function sendOpsMessage(propertyId: string, body: string): Promise<OpsSendResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Operations only." };

  const text = body.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Type a message first." };

  const admin = createServiceClient();
  // Guard against a typo'd/foreign property id (FK would otherwise 500).
  const { data: prop } = await admin
    .from("properties")
    .select("id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!prop) return { ok: false, error: "That property no longer exists." };

  const { error } = await admin.from("messages").insert({
    property_id: propertyId,
    from_user: ops.id,
    body: text,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * ✨ Draft reply — resolves the property's owner, loads that thread's recent
 * messages (same {from, body} shape the board renders), and hands both to
 * the already-built drafting engine. This ONLY returns text for ops to
 * review; it never inserts a message itself — sending still goes through
 * sendOpsMessage above, triggered by ops clicking the existing Send button.
 * Ops-only — assertOps gates it.
 */
export async function draftReplyForThread(propertyId: string): Promise<DraftResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Operations only." };

  const admin = createServiceClient();
  const { data: prop } = await admin
    .from("properties")
    .select("owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  const ownerId = (prop?.owner_id as string | null) ?? null;
  if (!ownerId) return { ok: false, error: "That property no longer exists." };

  const { data: rows } = await admin
    .from("messages")
    .select("from_user, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true })
    .limit(50);

  const thread = (rows ?? []).map((r) => ({
    from: (r.from_user === ownerId ? "owner" : "ops") as "owner" | "ops",
    body: (r.body as string) ?? "",
  }));

  return draftCustomerReply(ownerId, thread);
}
