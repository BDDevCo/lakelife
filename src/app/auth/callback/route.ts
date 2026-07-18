import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Where Google / Apple send the user back after they sign in.
 * We swap the one-time code for a real logged-in session, then send
 * them to the mobile-verification step.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/verify";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Something went wrong — back to home with a flag.
  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
