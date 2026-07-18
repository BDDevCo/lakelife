/**
 * Small helpers so the app can run and render even before the keys
 * are pasted into .env.local. Instead of crashing, screens can show a
 * friendly "add your keys" message.
 */

export function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

export function supabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

/** True once the Supabase URL + anon key are present. */
export function hasSupabaseEnv(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

/** True once the three Twilio Verify values are present (server-side). */
export function hasTwilioEnv(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_VERIFY_SERVICE_SID,
  );
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
