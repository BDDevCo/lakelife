"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { siteUrl } from "@/lib/env";
import { toast } from "@/components/Toast";

function AppleIcon() {
  return (
    <svg width="15" height="18" viewBox="0 0 15 18" fill="currentColor" aria-hidden="true">
      <path d="M12.5 9.6c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8C2.6 4.2 1.1 5.1.3 6.6c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.7 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0-.1-2.5-1-2.5-4zM10.1 2.5c.7-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.2 1.9-1 3 1 .1 2.1-.6 2.8-1.4z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2.1 5.1-4.4 6.7v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.2z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.3-9H4.4v5.7C8 41.2 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.7 28.3c-.4-1.3-.7-2.8-.7-4.3s.3-3 .7-4.3V14H4.4C2.9 17 2 20.4 2 24s.9 7 2.4 10l7.3-5.7z" />
      <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8 6.8 4.4 14l7.3 5.7c1.8-5.2 6.6-8.9 12.3-8.9z" />
    </svg>
  );
}

export function AuthModal({
  onClose,
  initialMode = "signup",
}: {
  onClose: () => void;
  initialMode?: "signup" | "signin";
}) {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<"signup" | "signin">(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);

  async function emailSignIn() {
    if (!email || !password) {
      toast("Enter your email and password.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      toast(error.message);
      return;
    }
    toast("Welcome back!");
    router.push("/portal");
    router.refresh();
  }

  async function ssoSignIn(provider: "google" | "apple") {
    setBusy(true);
    // New customers continue to mobile verification; returning customers go
    // straight to booking (verify/welcome will still catch stragglers).
    const next = mode === "signup" ? "/verify" : "/portal";
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${siteUrl()}/auth/callback?next=${next}` },
    });
    if (error) {
      toast(error.message);
      setBusy(false);
    }
    // On success the browser redirects to the provider; nothing more to do.
  }

  async function emailSignUp() {
    if (!name || !email || !password || !mobile) {
      toast("Please fill in name, email, password and mobile.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${siteUrl()}/auth/callback?next=/verify`,
        data: { full_name: name, phone: mobile },
      },
    });
    setBusy(false);

    if (error) {
      toast(error.message);
      return;
    }

    // Remember the number so the verify screen can pre-fill it.
    try {
      sessionStorage.setItem("ll_pending_phone", mobile);
    } catch {}

    if (data.session) {
      // Email confirmation is OFF — we're logged straight in.
      toast("Account created — email on file. Now verify your mobile.");
      router.push("/verify");
    } else {
      // Email confirmation is ON — they must click the link first.
      toast("Account created! Check your email to confirm, then verify your mobile.");
      onClose();
    }
  }

  return (
    <div
      className="ll-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Create your LakeLife profile"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ll-modal">
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">{mode === "signup" ? "New customer" : "Welcome back"}</span>
            <h3 style={{ fontSize: 22, marginTop: 8 }}>
              {mode === "signup" ? "Create your LakeLife profile" : "Sign in to LakeLife"}
            </h3>
            <div className="mut" style={{ marginTop: 4, fontSize: 13 }}>
              {mode === "signup"
                ? "One account for services, scheduling, photos & billing."
                : "Good to see you again."}
            </div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ll-modal-body">
          <button
            className="ll-sso apple"
            onClick={() => ssoSignIn("apple")}
            disabled={busy}
            style={{ marginBottom: 10 }}
          >
            <AppleIcon /> Continue with Apple
          </button>
          <button className="ll-sso" onClick={() => ssoSignIn("google")} disabled={busy}>
            <GoogleIcon /> Continue with Google
          </button>

          <div className="ll-or">{mode === "signup" ? "or start from scratch" : "or with email"}</div>

          {mode === "signup" && (
            <div className="ll-field">
              <label>Full name</label>
              <input
                placeholder="First & last name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="ll-field">
            <label>{mode === "signup" ? "Email — required, receipts & records" : "Email"}</label>
            <input
              type="email"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="ll-field">
            <label>Password</label>
            <input
              type="password"
              placeholder={mode === "signup" ? "Choose a password" : "Your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {mode === "signup" && (
            <div className="ll-field">
              <label>Mobile — required, we verify by text</label>
              <input
                inputMode="tel"
                placeholder="(260) 555-0100"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
              />
            </div>
          )}

          <button
            className="ll-btn"
            style={{ width: "100%" }}
            onClick={mode === "signup" ? emailSignUp : emailSignIn}
            disabled={busy}
          >
            {busy ? (mode === "signup" ? "Creating…" : "Signing in…") : mode === "signup" ? "Create account" : "Sign in"}
          </button>

          <div style={{ textAlign: "center", marginTop: 14, fontSize: 13 }}>
            {mode === "signup" ? (
              <button
                onClick={() => setMode("signin")}
                style={{ background: "none", border: "none", color: "var(--teal-dark)", fontWeight: 700, cursor: "pointer" }}
              >
                Already have an account? Sign in
              </button>
            ) : (
              <button
                onClick={() => setMode("signup")}
                style={{ background: "none", border: "none", color: "var(--teal-dark)", fontWeight: 700, cursor: "pointer" }}
              >
                New here? Create a profile
              </button>
            )}
          </div>

          {mode === "signup" && (
            <div className="mut" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
              Apple/Google sign-in verifies your email in one tap — Apple&apos;s Hide My
              Email works fine, mail still reaches you. Every account needs a working email
              on file and a text-verified mobile before the first service books.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
