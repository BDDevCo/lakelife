import type { SmsHealth } from "@/app/ops/sms-health";
import { smsErrorIsFixable } from "@/lib/sms-errors";

/**
 * WHETHER THE TEXTS ARE ARRIVING.
 *
 * The panel that would have caught a month of silence. It leads with the only
 * number that matters — how many were DELIVERED — because "81 sent" was the
 * comforting half of a sentence whose second half was "and none arrived".
 */
export function OpsSmsHealth({ health }: { health: SmsHealth }) {
  if (!health.configured) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Texts</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          Twilio isn&apos;t configured, so nothing is being texted at all. That&apos;s a
          setting, not a fault.
        </p>
      </div>
    );
  }

  // COULD NOT ASK ≠ ALL WELL. Rendered as a warning, never as silence.
  if (!health.window) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18, borderLeft: "4px solid var(--warn)" }}>
        <span className="ll-pill warn">Texts · unknown</span>
        <p style={{ fontSize: 14, margin: "10px 0 0", lineHeight: 1.55 }}>
          We couldn&apos;t reach Twilio to check whether texts are arriving.
          {health.error ? ` (${health.error})` : ""} Assume nothing until this
          answers.
        </p>
      </div>
    );
  }

  const { sent, delivered, failed } = health.window;
  const allFailing = sent > 0 && delivered === 0;

  if (sent === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Texts</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          No texts sent recently, so there&apos;s nothing to judge. This panel
          reads Twilio&apos;s own delivery log, not ours.
        </p>
      </div>
    );
  }

  return (
    <div
      className="ll-card ll-card-pad"
      style={{
        marginTop: 18,
        borderLeft: `4px solid ${allFailing ? "var(--warn)" : "var(--teal-dark)"}`,
      }}
    >
      <span className={`ll-pill ${allFailing ? "warn" : "ok"}`}>
        {allFailing ? "Texts · nothing is arriving" : "Texts"}
      </span>

      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
        {/* DELIVERED FIRST. "81 sent" was the half of the sentence that hid a
            month of failure. */}
        {delivered} of {sent} delivered
      </h2>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.55 }}>
        {allFailing
          ? "Every text in this window failed at the carrier. Anything the app says it texted — booking confirmations, crew dispatch, reminders — did not arrive."
          : `${failed} failed.`}{" "}
        Straight from Twilio&apos;s delivery log.
      </p>

      {health.reasons.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
          {health.reasons.map((r) => (
            <li key={r.code}>
              <strong>{r.count}</strong> — {r.text}
              {smsErrorIsFixable(r.code) && (
                <span className="ll-pill" style={{ fontSize: 11.5, marginLeft: 6 }}>
                  fixable
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
