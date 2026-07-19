import { NextResponse } from "next/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Where sign-in links land: Google/Apple SSO (?code), and email links for
 * confirmation / password recovery (?token_hash&type). We establish the
 * session by whichever mechanism the link carries, then continue to `next`.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/verify";

  const supabase = await createClient();

  if (code) {
    // OAuth / PKCE: swap the one-time code for a session.
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  } else if (tokenHash && type) {
    // Email OTP link (recovery, signup confirm, magic link) — verify server-side
    // without needing a browser-stored PKCE verifier, so an emailed reset link
    // works even if it's opened in a fresh tab.
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  // Something went wrong — back to home with a flag.
  return NextResponse.redirect(`${origin}/?auth_error=1`);
}
