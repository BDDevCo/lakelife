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
 */
export function TopBarAuth() {
  const router = useRouter();
  // `null` means "still asking"; false means "definitely signed out". With no
  // Supabase configured there is nothing to ask, so that answer is known at
  // first render and does not need an effect to deliver it a beat later.
  //
  // Safe as initial state precisely BECAUSE it is env: hasSupabaseEnv() reads
  // NEXT_PUBLIC_ variables, which Next inlines at build time, so the server
  // and the browser compute the same value and there is no hydration mismatch.
  // The same trick would be a bug for anything read off `window`.
  const [signedIn, setSignedIn] = useState<boolean | null>(hasSupabaseEnv() ? null : false);
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
