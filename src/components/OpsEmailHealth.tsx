import type { EmailVerdict } from "@/app/ops/email-health";

/**
 * IS EMAIL LANDING?
 *
 * The panel above this one answers the same question for texts by reading
 * TWILIO'S log, independently of anything we store. There is no equivalent to
 * read for email: our receipts are the only copy. So this panel leads with the
 * one comparison that does not depend on trusting a single writer —
 * ACCEPTED VERSUS CONFIRMED DELIVERED — because those two numbers are written
 * by two different things, and the gap between them is the whole story.
 *
 * ABSENCE IS THE ALARM. Every branch that is not a confirmed delivery renders
 * as a warning, including "no receipts at all" and including "we could not
 * look". A clean sheet here has to be earned by an arithmetic somebody can
 * read, never by an empty table.
 */
export function OpsEmailHealth({ verdict }: { verdict: EmailVerdict }) {
  const alarm = verdict.alarm !== null;

  return (
    <div
      className="ll-card ll-card-pad"
      style={{
        marginTop: 18,
        borderLeft: `4px solid ${alarm ? "var(--warn)" : "var(--teal-dark)"}`,
      }}
    >
      <span className={`ll-pill ${alarm ? "warn" : "ok"}`}>
        {alarm ? "Email · needs a look" : "Email"}
      </span>

      {/* THE FACT THAT HAS TO BE ON THE SCREEN. Delivered first: "81 sent" was
          the comforting half of a sentence whose other half was "and none
          arrived", and this is the same sentence for the other channel. */}
      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
        {verdict.state === "unreadable"
          ? "Email delivery couldn't be checked"
          : `${verdict.delivered} of ${verdict.accepted} confirmed delivered`}
      </h2>

      <p style={{ fontSize: 14, margin: "0 0 8px", lineHeight: 1.55 }}>
        {alarm ? verdict.alarm : verdict.line}
      </p>

      {verdict.reasons.length > 0 && (
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
          {verdict.reasons.map((r) => (
            <li key={r.text}>
              <strong>{r.count}</strong> — {r.text}
            </li>
          ))}
        </ul>
      )}

      {/* THE WORDS WE DO NOT UNDERSTAND, NAMED. Resend's event names are not
          written down anywhere in this project, so anything unrecognised is
          counted as still waiting — never as delivered — and printed here so
          the list can be corrected from what actually arrives. */}
      {verdict.unknownStatuses.length > 0 && (
        <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.55 }}>
          {verdict.unknownStatuses.length === 1 ? "One status" : `${verdict.unknownStatuses.length} statuses`}{" "}
          on these receipts {verdict.unknownStatuses.length === 1 ? "is" : "are"} not in the list this
          product understands — {verdict.unknownStatuses.join(", ")}. They are counted as still
          waiting, never as delivered. Add them to lib/email-delivery.ts once it is clear what they mean.
        </p>
      )}

      {/* WHAT THIS PANEL CANNOT SEE. The texts panel has Twilio's own log as a
          second opinion; this one has nothing of the kind, and saying so is
          the difference between a measurement and a reassurance. */}
      <p className="mut" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
        This reads our own receipts — the row each send files, and the verdict
        the webhook writes onto it. There is no second copy to check it against,
        so &ldquo;{verdict.verdicts} of {verdict.accepted} have a verdict at
        all&rdquo; is the number that says whether this panel can be believed.
      </p>
    </div>
  );
}
