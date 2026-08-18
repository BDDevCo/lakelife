"use client";

import { useEffect } from "react";
import { TopBar } from "@/components/Brand";

/**
 * THE CATCH-ALL, so an honest failure never lands on "Application error".
 *
 * `/parks/my` has its own boundary with copy written for a resident checking
 * their rent. This one covers every other route, and exists because the app
 * had NO boundary at all until today: the moment a loader started throwing
 * instead of guessing, the honest outcome became Next's default page, which
 * says "a server-side exception has occurred" and nothing a person can use.
 *
 * IT MUST NOT GUESS EITHER. The failure that brings somebody here is a read
 * that could not be trusted, so this page states no balance, no job, no
 * status — only that the fault is ours and that nothing was changed by it.
 * A reassuring number here would be the same bug wearing a different coat.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server logged WHICH read failed, by name. This records that somebody
    // actually hit it — the rate is the number worth watching.
    console.error("[app] render failed:", error.digest ?? error.message);
  }, [error]);

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 40, maxWidth: 480 }}>
        <div className="ll-card ll-card-pad">
          <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>
            We couldn&apos;t load this page
          </h2>
          <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
            Something went wrong at our end, not yours. Nothing you were part
            way through has been lost &mdash; if a payment or a booking had
            gone through, you would have seen it confirmed.
          </p>
          {/* The old wording promised "nothing has been changed, charged or
              cancelled" for ANY error landing here. True of a failed read,
              which is what this page was built for — but an action that throws
              AFTER a write reaches the same boundary, and then it is false.
              A page that exists to stop the software asserting what it cannot
              check must not do it in its own copy. */}
          <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, margin: "10px 0 0" }}>
            Try again in a moment.{" "}
            {error.digest
              ? "If it keeps happening, get in touch and quote the reference below."
              : "If it keeps happening, get in touch and tell us what you were doing."}
          </p>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={() => reset()}>
              Try again
            </button>
          </div>

          {error.digest && (
            <p className="mut" style={{ fontSize: 11.5, margin: "12px 0 0" }}>
              Reference {error.digest}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
