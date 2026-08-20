import Link from "next/link";
import type { NeedsYou } from "@/app/vendor/needs-you-data";

/**
 * "IS ANYTHING WAITING ON ME?" — the question a crew had no screen for.
 *
 * An open dispute freezing their pay, and a lake they have been paused off,
 * were each visible only on their own screen, reachable only by somebody who
 * already knew to go and look. The notice for both was a text, on a channel
 * that has delivered nothing since 19 July.
 *
 * QUIET WHEN THERE IS NOTHING, which is why it renders null rather than an
 * empty card reading "all clear". A crew opens this page every morning; a
 * permanent card that is usually empty stops being read, and then it is not
 * there on the morning it matters. Same reasoning as VendorDocs above it.
 */
export function VendorNeedsYou({ data, today }: { data: NeedsYou; today: string }) {
  const { held, pausedLakes, checkFailed } = data;
  if (held.length === 0 && pausedLakes.length === 0 && !checkFailed) return null;

  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : null;
  const closed = (iso: string | null) => !!iso && iso.slice(0, 10) < today;

  return (
    <div className="ll-card ll-card-pad" style={{ borderLeft: "3px solid var(--sun)", marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Waiting on you</h2>

        {checkFailed && (
          <p className="mut" style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.5 }}>
            We couldn&apos;t check this just now, so this list may be incomplete. Your
            route below is unaffected. Reload in a moment.
          </p>
        )}

        {held.map((h) => (
          <div key={h.disputeId} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {h.service ?? "A job"}{h.where ? ` · ${h.where}` : ""}
            </div>
            <p style={{ fontSize: 13, margin: "4px 0 0", lineHeight: 1.5, color: "var(--ink-warn)" }}>
              The customer flagged this one, so your pay for it is on hold.
              {h.respondBy &&
                (closed(h.respondBy)
                  ? " Your window to answer has closed — it's with our team now."
                  : ` Answer by ${day(h.respondBy)}.`)}
            </p>
            {/* The same three one-tap links the text carries — already minted on
                the dispute. With no token there is nothing to link to, and
                saying so beats rendering a dead button. */}
            {h.token ? (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <Link className="ll-btn sm" href={`/d/${h.token}/fix`}>Make it right</Link>
                <Link className="ll-btn ghost sm" href={`/d/${h.token}/verify`}>It was done right</Link>
                <Link className="ll-btn ghost sm" href={`/d/${h.token}/talk`}>Talk it through</Link>
              </div>
            ) : (
              <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
                Open the job to answer this one.
              </p>
            )}
          </div>
        ))}

        {pausedLakes.map((p) => (
          <div key={p.lake} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{p.lake} is paused</div>
            <p className="mut" style={{ fontSize: 13, margin: "4px 0 0", lineHeight: 1.5 }}>
              You&apos;re not being offered work on {p.lake} at the moment. It comes back on{" "}
              {new Date(p.liftsOn + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })} —
              nothing to do, and your other lakes are unaffected.
            </p>
          </div>
        ))}
    </div>
  );
}
