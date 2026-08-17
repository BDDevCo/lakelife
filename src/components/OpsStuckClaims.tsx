import type { StuckHousehold, ClaimTally } from "@/app/ops/claims-data";

/**
 * WHO IS STUCK GETTING IN.
 *
 * Nobody else can see this. The park owner's roll shows a fact about a CODE —
 * out, expired, used — because a household's repeated failures must not become
 * a durable note about them on their landlord's screen. Ops sees the struggle
 * because ops is who picks up the phone.
 *
 * THE QUIET STATE SAYS WHAT IT CHECKED. "Nothing here" is ambiguous: it reads
 * the same whether everybody got in or the query is broken. So when there is
 * nothing to show, this says what it looked at and what it found — which is
 * also the only way somebody notices the day it silently stops working.
 */
export function OpsStuckClaims({
  stuck, tally,
}: {
  stuck: StuckHousehold[];
  tally: ClaimTally;
}) {
  // Never written to at all — a park module that has not gone live yet, which
  // is a different thing from "everyone sailed through".
  if (tally.empty && stuck.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Getting residents in</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          No slips printed and no invites sent in the last 30 days — nobody has
          started onboarding a park yet. When they do, anyone who gets stuck
          shows up here.
        </p>
      </div>
    );
  }

  const activity =
    `${tally.invitesSent} invited · ${tally.slipsPrinted} slips printed · ` +
    `${tally.claimed} got in` +
    (tally.declined ? ` · ${tally.declined} on paper by choice` : "");

  if (stuck.length === 0) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill ok">Getting residents in</span>
        <p style={{ fontSize: 14, margin: "10px 0 4px" }}>
          Nobody is stuck. {activity}, last 30 days.
        </p>
        <p className="mut" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
          {tally.refused === 0
            ? "No refusals at all."
            : `${tally.refused} attempt${tally.refused === 1 ? "" : "s"} were refused, but everyone since got in or said no thanks.`}
        </p>
      </div>
    );
  }

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ marginTop: 18, borderLeft: "4px solid var(--teal-dark)" }}
    >
      <span className="ll-pill teal">Getting residents in · worth a call</span>
      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>
        {stuck.length === 1
          ? "1 household can't get in"
          : `${stuck.length} households can't get in`}
      </h2>
      <p className="mut" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.55 }}>
        Each has tried more than once and still isn&apos;t in. Their park sees
        none of this — it&apos;s a fact about a person, not about a slip, so it
        stays here. {activity}, last 30 days.
      </p>

      <div style={{ display: "grid", gap: 8 }}>
        {stuck.map((s) => (
          <div
            key={s.renterId}
            style={{
              display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10,
              padding: "9px 12px", background: "var(--sand-light)", borderRadius: 10,
            }}
          >
            <strong style={{ fontSize: 14, flex: "1 1 220px", minWidth: 0 }}>
              {s.parkName} · Lot {s.lotNumber} — {s.displayName}
            </strong>
            <span className="mut" style={{ fontSize: 13 }}>
              {s.attempts} tries · {s.latest}
            </span>
            {/* The one thing ops can DO from here, said plainly. There is no
                button: reissuing is the park office's action on their own
                roll, and quietly reaching into their park from here would be
                a worse habit than one phone call. */}
            {s.reissue && (
              <span className="ll-pill" style={{ fontSize: 11.5 }}>
                a fresh slip fixes this
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
