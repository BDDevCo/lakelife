"use server";

import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";

const ACTIVE_PROPERTY_COOKIE = "ll_active_property";

/** Give one of your properties a nickname ("The Cabin"). Owner-verified; the
 *  write runs with the service role (owners have no direct UPDATE grant on the
 *  column). Empty string clears it. Max 40 chars — it has to fit the switcher. */
export async function setPropertyNickname(propertyId: string, nickname: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: own } = await supabase
    .from("properties")
    .select("id")
    .eq("owner_id", user.id)
    .eq("id", propertyId)
    .maybeSingle();
  if (!own) return { ok: false, error: "That property isn't yours." };

  const clean = String(nickname ?? "").trim().slice(0, 40);
  const admin = createServiceClient();
  const { error } = await admin
    .from("properties")
    .update({ nickname: clean.length > 0 ? clean : null })
    .eq("id", propertyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Focus the portal on one of the owner's properties (validated as theirs). */
export async function setActiveProperty(propertyId: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const { data } = await supabase
    .from("properties")
    .select("id")
    .eq("owner_id", user.id)
    .eq("id", propertyId)
    .maybeSingle();
  if (!data) return { ok: false };

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_PROPERTY_COOKIE, propertyId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return { ok: true };
}
