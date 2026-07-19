"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/Brand";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/components/Toast";

/**
 * Where the "Forgot password?" email link lands. By the time we get here the
 * /auth/callback route has already exchanged the recovery code for a session,
 * so the person is signed in just long enough to set a new password.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [ready, setReady] = useState<"checking" | "ok" | "no-session">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setReady(data.user ? "ok" : "no-session"));
  }, [supabase]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) {
      toast("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      toast("The two passwords don't match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      toast(error.message);
      return;
    }
    toast("Password updated — you're all set. 🌊");
    router.push("/portal");
    router.refresh();
  }

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 440 }}>
        <div className="ll-card ll-card-pad">
          <span className="ll-pill teal">Reset password</span>
          <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>Choose a new password</h2>

          {ready === "checking" && <p className="mut" style={{ fontSize: 14 }}>One moment…</p>}

          {ready === "no-session" && (
            <>
              <p className="mut" style={{ fontSize: 14, marginBottom: 16 }}>
                This reset link has expired or was already used. Head back and tap
                “Forgot password?” again to get a fresh one.
              </p>
              <Link className="ll-btn" href="/">Back to sign in</Link>
            </>
          )}

          {ready === "ok" && (
            <form onSubmit={save}>
              <div className="ll-field">
                <label>New password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="ll-field">
                <label>Confirm new password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Type it again"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <button className="ll-btn" style={{ width: "100%" }} type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save new password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
