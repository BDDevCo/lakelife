import { TERMS_SECTIONS, runText, type Run } from "@/lib/terms-content";

/**
 * Shared body of the terms of service — the plain-English structure that both
 * the full /terms page and the at-the-moment-of-service agree modal render.
 * Server-safe (no "use client"): plain presentational JSX with no hooks or
 * client-only APIs, so it drops into a server page or a client modal alike.
 *
 * THE WORDS ARE NOT HERE ANY MORE. They live in `@/lib/terms-content`, and the
 * acceptance ledger snapshots them from the same place, so what is recorded is
 * by construction what was on screen. This file decides only how they look.
 */
export function TermsBody() {
  return (
    <>
      {TERMS_SECTIONS.map((section) => (
        <div className="ll-card ll-card-pad" key={section.heading} style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>{section.heading}</h3>
          <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            {section.body.map((run: Run, i: number) =>
              typeof run === "string"
                ? run
                : <b key={i}>{runText(run)}</b>,
            )}
          </p>
        </div>
      ))}
    </>
  );
}
