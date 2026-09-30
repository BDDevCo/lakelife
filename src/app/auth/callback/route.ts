import { NextResponse } from "next/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

/**
 * Where sign-in links land: Google/Apple SSO (?code), and email links for
 * confirmation / password recovery (?token_hash&type). We establish the
 * session by whichever mechanism the link carries, then continue to `next`.
 *
 * `next` COMES OFF THE QUERY STRING AND WE OWN THE LOCATION HEADER.
 *
 * AuthModal and VerifyPanel both run their destination through safeNext before
 * it reaches a Supabase `redirectTo`, and that was taken as covering this route
 * too. It does not: nothing stops a stranger typing this URL themselves, and
 * this was pasting the value onto the origin with no slash in between.
 *
 * `?next=@evil.com` builds `https://lakelife.ai@evil.com`, where everything
 * before the @ is a username and the host is evil.com. `?next=.evil.com`
 * builds `lakelife.ai.evil.com`. Both ship as Location from a page wearing our
 * sign-in. `//evil.com` does NOT — concatenation keeps it on our host — which
 * is the trap: a hand-rolled check for a double slash would have looked
 * sufficient and caught none of the three that work.
 *
 * The token_hash branch is stateless, so an attacker needs only one valid hash
 * from a recovery or confirmation email for an account they own, and can then
 * fire that link at anybody.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next")) ?? "/verify";

  /**
   * ONE DOOR OUT. safeNext above is the guard; this is the wall behind it,
   * RESOLVING against the origin instead of gluing onto it, so a fourth branch
   * added here later cannot leave the site by accident either.
   */
  const leave = (path: string) => {
    const url = new URL(path, origin);
    return NextResponse.redirect(url.origin === origin ? url : new URL("/", origin));
  };

  const supabase = await createClient();

  if (code) {
    // OAuth / PKCE: swap the one-time code for a session.
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return leave(next);
  } else if (tokenHash && type) {
    // Email OTP link (recovery, signup confirm, magic link) — verify server-side
    // without needing a browser-stored PKCE verifier, so an emailed reset link
    // works even if it's opened in a fresh tab.
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return leave(next);
  }

  // Something went wrong — back to home with a flag.
  return leave("/?auth_error=1");
}
