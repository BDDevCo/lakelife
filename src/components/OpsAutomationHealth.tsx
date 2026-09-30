import type { AutomationVerdict } from "@/app/ops/automation-health";

/**
 * IS THE MACHINE STILL RUNNING?
 *
 * The panel above this one answers "did the texts arrive". Nothing on this
 * console answered "did anything happen at all" — the nightly's only report is
 * an email, and a missing email is byte-identical to a quiet night.
 *
 * ABSENCE IS THE ALARM. Every branch that is not a finished, clean, recent run
 * renders as a warning, including the branch where the lookup itself failed.
 */
export function OpsAutomationHealth({ verdict }: { verdict: AutomationVerdict }) {
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
        {alarm ? "Automation · needs a look" : "Automation"}
      </span>

      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
        {alarm
          ? "The nightly run can't be shown as healthy"
          : "The nightly run is finishing"}
      </h2>

      <p style={{ fontSize: 14, margin: "0 0 8px", lineHeight: 1.55 }}>
        {alarm ? verdict.alarm : verdict.line}
      </p>

      {/* WHAT THIS PANEL CANNOT SEE, said out loud rather than implied away.
          The heartbeat is the stamp the run's LAST step leaves; the twenty-six
          steps before it report only into the digest email. */}
      <p className="mut" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.55 }}>
        This reads the record the nightly writes on its last step, just before
        the digest email. It can tell you the run reached the end — it can&apos;t
        tell you which earlier step failed. That only goes out in the digest.
      </p>
    </div>
  );
}
