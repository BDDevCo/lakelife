"use client";

import { useEffect } from "react";
import { TopBar } from "@/components/Brand";

/**
 * WHAT A FAILED READ LOOKS LIKE, NOW THAT ONE CAN NO LONGER LOOK LIKE A FACT.
 *
 * `my-data.ts` used to answer every question even when it could not read the
 * answer — "your park", "No lot on your account", "Nothing recorded yet",
 * "None held". Those are calm, plausible sentences, and a resident acts on
 * them. Now those reads throw, and this is where the throw lands.
 *
 * THE APP HAD NO ERROR BOUNDARY AT ALL, anywhere, so without this file the
 * honest failure would have been Next's default: "Application error: a
 * server-side exception has occurred." True, and useless to somebody who
 * wants to know whether their rent is paid.
 *
 * TWO THINGS THIS COPY MUST DO AND ONE IT MUST NOT.
 *
 *   It must say the failure is ours, not theirs. The screen it replaces used
 *   to tell people their tenancy did not exist.
 *
 *   It must say their record is untouched. This is a READ that failed; no
 *   payment, balance or deposit is affected, and the fear on the other side of
 *   a broken rent screen is exactly that something has gone missing.
 *
 *   It must NOT quote a figure. Not "you owe nothing", not a cached balance,
 *   not a reassuring number of any kind — the entire reason we are here is
 *   that we could not read one.
 */
export default function RenterHomeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server already logged which read failed, by name. This records that
    // a real person hit it, which is the number worth watching — a fault
    // nobody sees and a fault a resident sees are different problems.
    console.error("[/parks/my] render failed:", error.digest ?? error.message);
  }, [error]);

  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 40, maxWidth: 480 }}>
        <div className="ll-card ll-card-pad">
          <h2 style={{ fontSize: 20, margin: "0 0 6px" }}>
            We couldn&apos;t load your lot
          </h2>
          <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
            Something went wrong at our end, not yours. This is only a problem
            showing you the page &mdash; <strong>nothing about your rent,
            your payments or your deposit has changed.</strong>
          </p>
          <p className="mut" style={{ fontSize: 13.5, lineHeight: 1.6, margin: "10px 0 0" }}>
            Try again in a moment. If it keeps happening, ring the office and
            tell them the page wouldn&apos;t load &mdash; they can see your
            record from their side.
          </p>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={() => reset()}>
              Try again
            </button>
          </div>

          {/* The one string support can act on. Shown small, never explained —
              a reference number people can read out is worth more than an
              apology, and the stack trace behind it stays on the server. */}
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
