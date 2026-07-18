"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/** Supabase client for use in the browser (client components). */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
