"use client";

import { useEffect, useState } from "react";

/**
 * THE TOAST — with the prototype's gold tick, for the things that went right.
 *
 * lakelife.html:940 puts a gold ✓ before every toast, because in the
 * prototype every toast is good news. The app's are not: ninety-odd call
 * sites hand this `res.error ?? "Couldn't …"`, and a tick on "Couldn't send
 * that" is a lie in the one place a person is guaranteed to look.
 *
 * So the tick is earned, not assumed. `toast.ok()` draws it; `toast.err()`
 * never can; bare `toast()` is neutral and draws nothing — which means a
 * success nobody has marked yet is merely tick-less, and a failure nobody has
 * marked can never wear one. The safe direction on every unmarked site.
 */
type Kind = "ok" | "err" | "info";

function fire(message: string, kind: Kind) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ll-toast", { detail: { message, kind } }));
}

/** Fire a toast from anywhere: toast("Saved!"). Neutral — no tick. */
export function toast(message: string) { fire(message, "info"); }
/** Something went right. Draws the prototype's gold ✓. */
toast.ok = (message: string) => fire(message, "ok");
/** Something went wrong. Can never draw a tick. */
toast.err = (message: string) => fire(message, "err");

/** Mount once (in the root layout or a page) to display toasts. */
export function ToastHost() {
  const [cur, setCur] = useState<{ message: string; kind: Kind } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function onToast(e: Event) {
      const d = (e as CustomEvent<{ message: string; kind: Kind } | string>).detail;
      setCur(typeof d === "string" ? { message: d, kind: "info" } : d);
      clearTimeout(timer);
      timer = setTimeout(() => setCur(null), 3800);
    }
    window.addEventListener("ll-toast", onToast);
    return () => {
      window.removeEventListener("ll-toast", onToast);
      clearTimeout(timer);
    };
  }, []);

  if (!cur) return null;
  return (
    <div className="ll-toast" role="status" aria-live="polite">
      {cur.kind === "ok" && <span className="tick" aria-hidden="true">✓</span>}
      <span>{cur.message}</span>
    </div>
  );
}
