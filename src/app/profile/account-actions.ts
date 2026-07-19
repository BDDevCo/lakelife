"use server";

import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { supabaseUrl } from "@/lib/env";
import { getActivePropertyId } from "./data";

export interface DeleteResult {
  ok: boolean;
  error?: string;
}

/** Read the minimal marketing contact for the signed-in user and retain it. */
async function retainMarketingContact(
  userId: string,
  reason: "property_removed" | "account_deleted",
): Promise<void> {
  const supabase = await createClient();
  const { data: me } = await supabase
    .from("users")
    .select("name, email, phone")
    .eq("id", userId)
    .maybeSingle();

  // Lake (if they have a property) — for seasonal segmentation.
  const { data: property } = await supabase
    .from("properties")
    .select("lakes(name)")
    .eq("owner_id", userId)
    .limit(1)
    .maybeSingle();
  const lakesField = property?.lakes as unknown;
  const lakeName = Array.isArray(lakesField)
    ? (lakesField[0] as { name?: string } | undefined)?.name
    : (lakesField as { name?: string } | null | undefined)?.name;

  if (!me?.email) return; // nothing to retain

  // Write with the service role so retention isn't blocked by RLS. If they had
  // already opted out, leave that flag intact.
  const admin = createServiceClient();
  await admin.from("marketing_contacts").upsert(
    {
      user_id: userId,
      name: me.name ?? null,
      email: me.email,
      phone: me.phone ?? null,
      lake: lakeName ?? null,
      reason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" },
  );
}

/**
 * Remove ONE property — the one the portal is currently focused on — and all
 * its house data. The login and any OTHER properties stay untouched.
 * Retains a marketing contact first.
 */
export async function removeProperty(propertyId?: string): Promise<DeleteResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  // Prefer the exact property the confirmation dialog showed; fall back to the
  // active one. Either way the delete below is scoped to this owner.
  const activeId = propertyId ?? (await getActivePropertyId());
  if (!activeId) return { ok: false, error: "No property to remove." };

  await retainMarketingContact(user.id, "property_removed");

  // Deleting the property cascades to profile, boats, toys, photos, jobs, etc.
  // Scoped to the ACTIVE property only — never the whole portfolio.
  const { error } = await supabase
    .from("properties")
    .delete()
    .eq("owner_id", user.id)
    .eq("id", activeId);
  if (error) return { ok: false, error: error.message };

  // Clear the switcher cookie so the portal falls back to another property.
  const cookieStore = await cookies();
  cookieStore.set("ll_active_property", "", { path: "/", maxAge: 0 });
  return { ok: true };
}

/**
 * Fully delete the customer's account: retains a marketing contact, then
 * removes the auth login (which cascades and wipes all their data). The client
 * signs out afterward.
 */
export async function deleteAccount(): Promise<DeleteResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  await retainMarketingContact(user.id, "account_deleted");

  // Delete the auth user via the admin endpoint (service role). auth.users has
  // ON DELETE CASCADE into public.users -> properties -> children, so all house
  // data goes with it.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok && res.status !== 200) {
    const body = await res.text();
    return { ok: false, error: `Could not delete account (${res.status}). ${body}` };
  }
  return { ok: true };
}
