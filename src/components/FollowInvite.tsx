"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimByInvite } from "@/app/parks/invite-actions";

/**
 * THE ONE TAP THAT ISN'T ONE.
 *
 * She followed a link and signed in. Asking her to now press a button labelled
 * "yes, really" would be asking her to confirm the thing she already did — so
 * this runs the claim on arrival and shows her lot.
 *
 * IT IS NOT A GET. The claim attaches an account to a household file, and a
 * link that mutates on load is a link a mail scanner or a link preview can
 * fire. So it happens here, after the page is in her hands, in a POST — and
 * StrictMode's double-render is guarded, because two calls would make the
 * second one report "already set up" about her own first one.
 */
export function FollowInvite({ token }: { token: string }) {
  const router = useRouter();
  const [said, setSaid] = useState<{ ok: boolean; message: string; reissuable?: boolean } | null>(null);
  const [busy, start] = useTransition();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    start(async () => {
      const res = await claimByInvite(token);
      setSaid(res);
      if (res.ok) {
        router.push("/parks/my");
        router.refresh();
      }
    });
  }, [token, router]);

  if (busy || !said) {
    return (
      <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>Finding your lot…</h2>
        <p className="mut" style={{ fontSize: 14, margin: 0 }}>This takes a second.</p>
      </div>
    );
  }

  if (said.ok) {
    // The push has already happened; this is only what shows during the hop.
    return (
      <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>You&apos;re all set 🌊</h2>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
      <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>We couldn&apos;t open your lot</h2>
      <p role="status" style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>
        {said.message}
      </p>
      {said.reissuable && (
        <p className="mut" style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.55 }}>
          Nothing is wrong at your end — a new one takes the office a moment.
        </p>
      )}
    </div>
  );
}
