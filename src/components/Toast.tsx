"use client";

import { useEffect, useState } from "react";

/** Fire a toast from anywhere: toast("Saved!"). */
export function toast(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ll-toast", { detail: message }));
}

/** Mount once (in the root layout or a page) to display toasts. */
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function onToast(e: Event) {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 3800);
    }
    window.addEventListener("ll-toast", onToast);
    return () => {
      window.removeEventListener("ll-toast", onToast);
      clearTimeout(timer);
    };
  }, []);

  if (!msg) return null;
  return (
    <div className="ll-toast" role="status" aria-live="polite">
      {msg}
    </div>
  );
}
