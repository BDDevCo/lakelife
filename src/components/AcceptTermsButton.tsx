"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptTos } from "@/app/portal/tos-actions";

/**
 * THE BUTTON THAT HAS TO SAY WHAT HAPPENED.
 *
 * This was a bare `<form action={acceptTos}>` with a submit button. On a failed
 * write the action returned, the page re-rendered identically, and somebody who
 * had just tapped "I agree" was left looking at the same card — no message, no
 * spinner, nothing to distinguish "it worked and the page looks the same"
 * from "it silently didn't". On a phone at the lake, on a bad connection, that
 * is the shape most likely to happen and the worst one to be in.
 *
 * Now: it says "Recording…" while it works, navigates on success, and prints
 * the reason it could not, with the button still there to try again.
 *
 * WHY THE NAVIGATION IS HERE and not a server redirect: a redirect cannot carry
 * a sentence. The moment the action needed to report a failure it also needed
 * to stop redirecting on success, or the two paths would disagree about who is
 * in charge of what happens next.
 */
export function AcceptTermsButton({
  next,
  label,
}: {
  next: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 6 }}>
      <button
        className="ll-btn"
        type="button"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await acceptTos();
            if (!res.ok) {
              setError(res.error ?? "We couldn't record that just now. Try once more.");
              return;
            }
            // Local paths only. `next` comes from our own gates, never from a
            // query string, but the check costs nothing and keeps it that way.
            const to = next.startsWith("/") ? next : "/portal";

            // PUSHING TO THE PAGE YOU ARE ALREADY ON IS A NO-OP, and inside a
            // transition that means `isPending` never clears: the button sits
            // on "Recording…" for ever while the write has, in fact, succeeded.
            //
            // Every gate hits this. The crew's `next` is /vendor and the crew
            // gate renders AT /vendor; the resident's is /parks/my, likewise;
            // the park owner's is /park, which is where most of them land. So
            // the shape somebody actually meets is: tap "I agree", watch it
            // hang, reload, and find themselves through — or tap again and file
            // a SECOND acceptance, which is append-only and cannot be removed.
            //
            // `refresh()` is the right verb when we are already there: it
            // re-runs the server component, the layout re-asks the ledger, and
            // the gate is replaced by the page underneath it.
            if (to === window.location.pathname) router.refresh();
            else router.push(to);
          })
        }
      >
        {busy ? "Recording…" : label}
      </button>

      {error && (
        <p
          role="alert"
          style={{ fontSize: 13.5, lineHeight: 1.6, margin: "10px 0 0", color: "var(--warn)" }}
        >
          {error} Nothing has been recorded yet — your agreement isn&apos;t on
          file until this goes through.
        </p>
      )}
    </div>
  );
}
