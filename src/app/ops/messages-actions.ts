"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { assertOps } from "./data";
import { draftCustomerReply, type DraftResult } from "@/lib/comms-draft";
import { ReadFailed, readFailedMessage } from "@/lib/must-read";

export interface OpsSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Ops replies to an owner on a property's thread. The sender is recorded as the
 * ops user's id (from_user); the read side labels it "ops" because that id is
 * not the property's owner_id. Ops-only — assertOps gates it.
 *
 * `jobId` is optional and purely an annotation — passing it does NOT split the
 * thread (the AI auto-reply rails and ops' thread grouping both key on the
 * property), it just records which job the reply concerns.
 */
export async function sendOpsMessage(propertyId: string, body: string, jobId?: string): Promise<OpsSendResult> {
  const ops = await assertOps();
  if (!ops) return { ok: false, error: "Operations only." };

  const text = body.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Type a message first." };

  const admin = createServiceClient();
  // Guard against a typo'd/foreign property id (FK would otherwise 500).
  const propRes = await admin
    .from("properties")
    .select("id")
    .eq("id", propertyId)
    .maybeSingle();
  // "No longer exists" is a fact about the property. A failed read knows no
  // such fact — and ops would be looking at the thread while being told it's
  // gone, with their typed reply still unsent.
  if (propRes.error) return { ok: false, error: readFailedMessage("that property", propRes.error) };
  const prop = propRes.data;
  if (!prop) return { ok: false, error: "That property no longer exists." };

  const { error } = await admin.from("messages").insert({
    property_id: propertyId,
    from_user: ops.id,
    body: text,
    // Optional job annotation (0046): a reply sent from a job's file stays
    // on the ONE property thread but remembers what it was about, so both
    // the job page and the board can show it in context.
    ...(jobId ? { job_id: jobId } : {}),
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
  const propRes = await admin
    .from("properties")
    .select("owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (propRes.error) return { ok: false, error: readFailedMessage("that property", propRes.error) };
  const prop = propRes.data;
  const ownerId = (prop?.owner_id as string | null) ?? null;
  if (!ownerId) return { ok: false, error: "That property no longer exists." };

  // AN EMPTY THREAD IS A DRAFT WRITTEN AS IF THE CUSTOMER SAID NOTHING. The
  // engine's whole safety posture is "use ONLY facts in the context" — hand it
  // a thread emptied by a dropped connection and it answers a question nobody
  // asked, in ops' voice, one click from being sent.
  const rowsRes = await admin
    .from("messages")
    .select("from_user, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true })
    .limit(50);
  if (rowsRes.error) return { ok: false, error: readFailedMessage("that conversation", rowsRes.error) };
  const rows = rowsRes.data;

  const thread = (rows ?? []).map((r) => ({
    from: (r.from_user === ownerId ? "owner" : "ops") as "owner" | "ops",
    body: (r.body as string) ?? "",
  }));

  // The engine's own reads throw too (buildCustomerContext), and a rejection
  // out of a "use server" action reaches the button as a blank failure with no
  // sentence — the exact thing the two guards above exist to prevent. Nothing
  // is sent either way; a draft is only text for ops to look at.
  try {
    return await draftCustomerReply(ownerId, thread);
  } catch (e) {
    if (!(e instanceof ReadFailed)) throw e;
    return { ok: false, error: readFailedMessage("that customer's details", e) };
  }
}
