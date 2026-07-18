"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const ACTIVE_PROPERTY_COOKIE = "ll_active_property";

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
