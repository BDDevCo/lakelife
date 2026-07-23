"use server";

import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TOS_VERSION } from "@/lib/tos";

/** Explicit, versioned acceptance — stamped who/which/when, then onward. */
export async function acceptTos(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const admin = createServiceClient();
  await admin
    .from("users")
    .update({ tos_version: TOS_VERSION, tos_accepted_at: new Date().toISOString() })
    .eq("id", user.id);
  redirect("/portal");
}
