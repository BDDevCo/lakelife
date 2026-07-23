/**
 * Shared body of the terms of service — the plain-English structure that both
 * the full /terms page and the at-the-moment-of-service agree modal render.
 * Server-safe (no "use client"): plain presentational JSX with no hooks or
 * client-only APIs, so it drops into a server page or a client modal alike.
 */
export function TermsBody() {
  return (
    <>
      <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>What LakeLife is</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          LakeLife is a <b>third-party administrator</b>: we run the booking, scheduling,
          photo-verification, and payment rails that connect lake homeowners with independent
          local crews. The services themselves — mowing, winterizing, hauling, storing — are
          performed by those independent crews, not by LakeLife.
        </p>
      </div>

      <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Who you&apos;re agreeing with</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          When a job is booked, the service agreement is <b>between the homeowner and the
          crew</b> — both sides accept these shared terms as the rules of that relationship.
          LakeLife administers it: one all-in price, photo-verified completion, payment released
          only after the work is done.
        </p>
      </div>

      <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>What LakeLife verifies</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          Every active crew has <b>insurance on file</b> (a certificate of insurance, re-validated
          yearly; storage crews additionally carry custody coverage) and a <b>W-9 with a valid
          EIN or SSN</b> on file before they can be routed work. Verification of documents is the
          extent of LakeLife&apos;s role — crews are independent businesses responsible for their
          own work.
        </p>
      </div>
    </>
  );
}
