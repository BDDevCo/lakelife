"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AuthModal } from "@/components/AuthModal";
import { hasSupabaseEnv } from "@/lib/env";

/**
 * Right-side top-bar control. Shows "Sign in" when signed out (opens the modal
 * straight to sign-in), and "My profile" + "Sign out" once signed in.
 *
 * THE CONTROL USED TO BE INVISIBLE TO EVERY CRAWLER.
 *
 * Every render began at `signedIn === null` — "still asking" — which draws a
 * 64px spacer, and the answer only arrived from `auth.getUser()` a beat after
 * hydration. Server-rendered HTML is taken at the moment it is produced, so
 * the shipped markup of www.lakelife.ai contained neither "Sign in" nor "Get
 * set up": verified 22 September 2026 with
 *
 *     curl -s https://www.lakelife.ai/ | grep -c "Get set up"   →   0
 *
 * A search crawler that does not run scripts, a link-preview fetcher, a
 * reader-mode pane and a visitor with scripting off all saw a top bar with no
 * way into the product.
 *
 * `initialSignedIn` lets a SERVER page that has already asked — page.tsx does
 * exactly this read, for the hero's own shortcut — hand the answer down so the
 * right control is in the first byte of HTML. The effect below still runs and
 * still wins: a session that expired between the render and the hydrate, or a
 * sign-out in another tab, corrects the control the same way it always did.
 *
 * A PAGE THAT CANNOT KNOW MUST NOT GUESS. Omitting the prop keeps today's
 * behaviour exactly — spacer, then ask — because the failure directions are
 * not symmetric: a beat of spacer costs a crawler nothing, while a page that
 * guessed "signed out" would show a signed-in homeowner a sign-up pitch, and
 * one that guessed "signed in" would offer a stranger a portal link.
 */
export function TopBarAuth({ initialSignedIn }: { initialSignedIn?: boolean } = {}) {
  const router = useRouter();
  // `null` means "still asking"; false means "definitely signed out". With no
  // Supabase configured there is nothing to ask, so that answer is known at
  // first render and does not need an effect to deliver it a beat later.
  //
  // Safe as initial state precisely BECAUSE it is env: hasSupabaseEnv() reads
  // NEXT_PUBLIC_ variables, which Next inlines at build time, so the server
  // and the browser compute the same value and there is no hydration mismatch.
  // The same trick would be a bug for anything read off `window`.
  //
  // `initialSignedIn` is safe for the same reason and one more: it travels in
  // the RSC payload, so the browser's first render computes the identical
  // value the server did. `??` and not `||` — `false` is an answer, not an
  // absence, and `||` would throw away the commonest one.
  const [signedIn, setSignedIn] = useState<boolean | null>(
    initialSignedIn ?? (hasSupabaseEnv() ? null : false),
  );
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  useEffect(() => {
    if (!hasSupabaseEnv()) return;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setSignedIn(!!data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(!!session?.user);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await createClient().auth.signOut();
    setSignedIn(false);
    router.push("/");
    router.refresh();
  }

  // Don't flash the wrong control before we know the auth state.
  if (signedIn === null) return <div style={{ width: 64 }} />;

  if (signedIn) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Link href="/portal" className="ll-navbtn portal">My portal</Link>
        <button onClick={signOut} className="ll-navbtn ghost">Sign out</button>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => { setMode("signin"); setOpen(true); }} className="ll-navbtn signin">Sign in</button>
        <button onClick={() => { setMode("signup"); setOpen(true); }} className="ll-navbtn join">Get set up →</button>
      </div>
      {open && <AuthModal initialMode={mode} onClose={() => setOpen(false)} />}
    </>
  );
}

/* The five pill styles that used to live here are now `.ll-navbtn` in
   globals.css. They moved because a style object in JS is unreachable from a
   media query, and at 375px this bar needed one: the signed-out pair ran a
   pixel past the right edge of the phone and the signed-in pair wrapped to
   three lines inside a 64px bar. */
