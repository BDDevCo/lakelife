import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase client for the server (server components, route handlers).
 * Reads/writes the auth session from cookies.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — safe to ignore; middleware/route
          // handlers refresh the session cookie instead.
        }
      },
    },
  });
}

/**
 * Service-role client — FULL ACCESS, bypasses row-level security.
 * BACKEND ONLY. Never import this into a client component.
 * Used for trusted server actions like marking a phone verified after Twilio confirms.
 */
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createServerClient(supabaseUrl(), key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
