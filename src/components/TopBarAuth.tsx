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
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasSupabaseEnv()) {
      setSignedIn(false);
      return;
    }
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
        <Link href="/profile" style={linkBtn}>My profile</Link>
        <button onClick={signOut} style={ghostBtn}>Sign out</button>
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setOpen(true)} style={signInBtn}>Sign in</button>
      {open && <AuthModal initialMode="signin" onClose={() => setOpen(false)} />}
    </>
  );
}

const signInBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.22)",
  color: "#fff",
  fontWeight: 700,
  fontSize: 13.5,
  padding: "8px 16px",
  borderRadius: 99,
  cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  color: "#fff",
  fontWeight: 700,
  fontSize: 13.5,
  textDecoration: "none",
  padding: "8px 14px",
  borderRadius: 99,
  background: "var(--teal)",
};
const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.22)",
  color: "#9fc0cb",
  fontWeight: 700,
  fontSize: 13.5,
  padding: "8px 14px",
  borderRadius: 99,
  cursor: "pointer",
};
