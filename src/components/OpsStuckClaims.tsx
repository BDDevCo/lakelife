import type { StuckHousehold, ClaimTally } from "@/app/ops/claims-data";
import { quietClaimState, type QuietPark } from "@/app/ops/claims-quiet";

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
 *
 * It did not do that well enough. The quiet state read "nobody has started
 * onboarding a park yet" while a real park sat on the console, because it was
 * deciding from the claim log alone and the claim log does not know whether a
 * park exists. And a FAILED tally read arrived as that same sentence, so the
 * most reassuring words on the screen were also what a broken query looked
 * like. Both are now the three states they always were — see claims-quiet.ts.
 */
export function OpsStuckClaims({
  stuck, tally, parks,
}: {
  stuck: StuckHousehold[];
  tally: ClaimTally;
  /** The parks on the platform, so the quiet state can name what it found. */
  parks: readonly QuietPark[];
}) {
  // WE COULD NOT LOOK. Its own state, ahead of every sentence that reports a
  // finding, because a read that did not happen has no findings to report.
  if (!tally.checked) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Getting residents in</span>
        <p style={{ fontSize: 14, margin: "10px 0 0", lineHeight: 1.55 }}>
          We couldn&apos;t check who is getting in — the claim log didn&apos;t
          read. This card is blank because the question went unanswered, not
          because the answer was nobody.
        </p>
      </div>
    );
  }

  // Nothing in the log, and nobody stuck. What that MEANS depends on whether
  // any park is set up and has anybody on its roll — facts this card used to
  // guess at from the claim log alone, and guess wrong.
  if (tally.empty && stuck.length === 0) {
    const quiet = quietClaimState({ checked: true, parks });
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Getting residents in</span>
        <p className="mut" style={{ fontSize: 13.5, margin: "10px 0 0", lineHeight: 1.55 }}>
          {quiet.kind === "unchecked" ? "" : quiet.said}
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
            : tally.refusedUnattributed === tally.refused
              // Every refusal named no household. "Everyone since got in" would
              // be a claim about people this log cannot identify — the wrong
              // sentence, and the reassuring one.
              ? `${tally.refused} attempt${tally.refused === 1 ? " was" : "s were"} refused with no household to trace ${tally.refused === 1 ? "it" : "them"} to — a wrong lot number, or a slip held against the wrong park.`
              : tally.refusedUnattributed > 0
                ? `${tally.refused} attempts were refused. ${tally.refusedUnattributed} of those named no household — a wrong lot number, or a slip held against the wrong park — and everyone else got in or said no thanks.`
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
      <h2 style={{ fontSize: 16, margin: "10px 0 4px" }}>
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
