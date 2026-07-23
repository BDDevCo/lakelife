import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { TOS_VERSION } from "@/lib/tos";

/**
 * The user agreement page. The plain-English structure below states the
 * platform's actual posture; the attorney's full text replaces the body
 * and bumps TOS_VERSION — the acceptance rails re-prompt everyone.
 */

export const metadata: Metadata = {
  title: "Terms of service | LakeLife",
  description: "How LakeLife works: a third-party administrator connecting lake homeowners with independent, insured local crews.",
};

export default function TermsPage() {
  return (
    <>
      <TopBar />
      <main className="wrap" style={{ paddingTop: 32, paddingBottom: 48, maxWidth: 680 }}>
        <div className="ll-eyebrow">The agreement</div>
        <h1 style={{ fontSize: 28, margin: "6px 0 8px" }}>Terms of service</h1>
        <p className="mut" style={{ fontSize: 13, marginBottom: 18 }}>
          Version {TOS_VERSION} · beta. The plain-English structure below is the deal; the full
          agreement text is being finalized and will replace this page — you&apos;ll be asked to
          accept it when it does.
        </p>

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

        <p className="mut" style={{ fontSize: 13 }}>
          Questions? <a href="mailto:hello@lakelife.ai">hello@lakelife.ai</a> — a human reads it.
        </p>
      </main>
    </>
  );
}
