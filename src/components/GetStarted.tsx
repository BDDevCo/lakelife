"use client";

import { useEffect, useState } from "react";
import { AuthModal } from "@/components/AuthModal";
import { toast } from "@/components/Toast";

export function GetStarted({ configured }: { configured: boolean }) {
  const [open, setOpen] = useState(false);

  // Surface an OAuth error passed back on the URL (?auth_error=1).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_error")) {
      toast("Sign-in didn't complete. Please try again.");
    }
  }, []);

  function start() {
    if (!configured) {
      toast("Almost there — add your Supabase keys to .env.local to enable sign-up.");
      return;
    }
    setOpen(true);
  }

  return (
    <>
      <button
        className="ll-chip"
        style={{
          cursor: "pointer",
          background: "var(--sun)",
          color: "var(--ink)",
          borderColor: "var(--sun)",
          fontWeight: 800,
        }}
        onClick={start}
      >
        New here? Create a profile →
      </button>
      {open && <AuthModal onClose={() => setOpen(false)} />}
    </>
  );
}
