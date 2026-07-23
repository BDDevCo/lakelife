import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { TOS_VERSION } from "@/lib/tos";

/**
 * The agreement stamp, at the moment of service (owner, 2026-07-22):
 * onboarding is frictionless — acceptance happens the FIRST time someone
 * agrees to give or receive service (booking / go-live), then never again
 * until the profile is deleted or TOS_VERSION bumps. "needs" tells the
 * caller to show the quick scroll-and-agree; the retried call carries
 * accepted=true, stamps, and pushes the request through in one motion.
 */
export async function ensureTos(userId: string, accepted?: boolean): Promise<"ok" | "needs"> {
  const admin = createServiceClient();
  const { data } = await admin.from("users").select("tos_version").eq("id", userId).maybeSingle();
  if (data?.tos_version === TOS_VERSION) return "ok";
  if (!accepted) return "needs";
  await admin
    .from("users")
    .update({ tos_version: TOS_VERSION, tos_accepted_at: new Date().toISOString() })
    .eq("id", userId);
  return "ok";
}
