"use client";

import { useState } from "react";
import { AuthModal } from "@/components/AuthModal";

/**
 * SIGN IN WITHOUT LEAVING THE PAGE THAT NEEDED IT.
 *
 * The claim screen and the invite-link screen both used to send people to "/"
 * to sign in. That is a page load, a marketing hero, and a top bar they then
 * have to find a button in — and at the end of it the sign-in dropped them at
 * /portal, which is the lake-services portal and has nothing to do with the
 * slip in their hand. The welcome page had to follow its own sign-in button
 * with "then come back to this page", which on a phone means switching to Mail
 * and finding the link again.
 *
 * So the modal opens here, over the screen she is already on, and `next`
 * carries her straight back to it afterwards.
 */
export function SignInHere({
  next,
  label = "Sign in",
  mode = "signin",
}: {
  /** Where to land afterwards — normally the current path plus its query. */
  next: string;
  label?: string;
  mode?: "signin" | "signup";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="ll-btn"
        onClick={() => setOpen(true)}
        style={{ minHeight: 48 }}
      >
        {label}
      </button>
      {open && (
        <AuthModal initialMode={mode} next={next} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * THE WAY OUT OF THE WRONG ACCOUNT.
 *
 * An invite is refused when the signed-in address isn't the one it was sent
 * to, and that is the likeliest real failure — a shared tablet, a spouse's
 * account, a Google session she forgot she had. The screen said "sign out and
 * sign in with that address" and offered no button, so the only sign-out was
 * the one in the top bar, which navigates to "/" and throws the invite link
 * away with it. The instruction was true and following it lost her place.
 *
 * This signs out and comes back to the same link, so the second attempt starts
 * exactly where the first one failed.
 */
export function SwitchAccount({ next, label }: { next: string; label?: string }) {
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    // A hard load, not router.push: the session cookie has just changed and
    // every server component on the way back needs to read the new one.
    window.location.href = next;
  }

  return (
    <button className="ll-btn" disabled={busy} onClick={go} style={{ minHeight: 48, marginTop: 14 }}>
      {busy ? "Signing out…" : (label ?? "Sign out and use a different email")}
    </button>
  );
}
