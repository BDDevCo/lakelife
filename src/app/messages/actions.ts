"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";

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
  return { ok: true };
}
