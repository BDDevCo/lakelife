import type { CrewCoverage as Coverage } from "@/app/ops/crews-data";

/**
 * WHICH WORK CAN NOBODY DO — the question the dispatch board cannot ask.
 *
 * The dispatch board lists jobs that failed to find a crew. That is the right
 * question once a job exists and the wrong one before then: it cannot fire
 * until somebody has already booked work nobody can take, and for protective
 * work in January that is the moment it is too late to do anything about it.
 *
 * This is the same fact asked early. It counts crews who could EVER take the
 * work — capability, insurance, standing, geography — using dispatch's own
 * rule (`canEverDo`), so this card and the router cannot disagree.
 *
 * FIXTURES DO NOT COUNT, exactly as dispatch will not route to them. That is
 * the entire point: production holds three vendors and all three are test
 * accounts, so today the honest answer for every service on every lake is
 * ZERO — and until this card existed, nothing anywhere said so.
 */
export function CrewCoverage({ coverage }: { coverage: Coverage }) {
  const { holes, pairs, liveCrews, orphanServices } = coverage;
  const covered = pairs - holes.length;
  const allDark = pairs > 0 && covered === 0;
  const protectiveHoles = holes.filter((h) => h.protective);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Who can do the work</h3>
          <p className="mut" style={{ fontSize: 13, margin: 0 }}>
            Crews who could ever take a job — not who is free on a given day.
            Test accounts are not counted, because nothing will route to them.
          </p>
        </div>
        <span className={`ll-pill ${allDark ? "red" : holes.length ? "warn" : "ok"}`}>
          {covered} of {pairs} covered
        </span>
      </div>

      {pairs === 0 ? (
        <p className="mut" style={{ fontSize: 13.5, padding: "10px 2px 2px" }}>
          No active services on any lake yet, so there is nothing to cover.
        </p>
      ) : allDark ? (
        /* THE STATE THE PLATFORM IS ACTUALLY IN, said plainly rather than as a
           row of empty cells. "0 of 48" invites a reader to hunt for which
           ones; the answer is all of them, and the cause is one fact. */
        <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, background: "var(--alarm-bg)" }}>
          <strong style={{ fontSize: 14 }}>
            No crew can take any job, anywhere.
          </strong>
          <p style={{ fontSize: 13, margin: "6px 0 0", lineHeight: 1.55 }}>
            {liveCrews === 0
              ? "There are no live crews at all — every vendor on the platform is a test account, and dispatch will not route to one. Until a real crew is onboarded and activated, every booking becomes a job that sits waiting for somebody who does not exist."
              : `${liveCrews} live ${liveCrews === 1 ? "crew" : "crews"}, and none of them is set up for any service on any lake — check their service list, their lakes, and whether their certificate is in date.`}
          </p>
        </div>
      ) : holes.length === 0 ? (
        <p style={{ fontSize: 13.5, padding: "10px 2px 2px" }}>
          Every active service has somebody on every lake.
        </p>
      ) : (
        <>
          {protectiveHoles.length > 0 && (
            /* Protective work is the half that hurts. 0053 stops the nightly
               auto-cancelling it, so an uncovered protective service does not
               quietly go away — it waits, and somebody's pipe bursts or
               somebody's drive stays blocked. */
            <p style={{ fontSize: 13, margin: "12px 0 0", lineHeight: 1.5, color: "var(--danger)" }}>
              {protectiveHoles.length} of these {protectiveHoles.length === 1 ? "is" : "are"} protective
              work, which the nightly will never cancel on its own. It waits for a crew instead.
            </p>
          )}
          <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
            {holes.map((h) => (
              <div key={`${h.service}-${h.lakeId}`} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13.5, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>{h.service}</span>
                <span className="mut">on {h.lakeName}</span>
                {h.protective && <span className="ll-pill warn">protective</span>}
                <span className="mut" style={{ marginLeft: "auto" }}>nobody</span>
              </div>
            ))}
          </div>
        </>
      )}

      {orphanServices.length > 0 && !allDark && (
        <p className="mut" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
          Nobody anywhere does: {orphanServices.join(", ")}. A service with no crew on
          any lake is one nobody can buy, however it is priced.
        </p>
      )}
    </div>
  );
}
