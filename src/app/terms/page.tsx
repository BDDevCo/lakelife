import type { Metadata } from "next";
import { TopBar } from "@/components/Brand";
import { TermsBody } from "@/components/TermsBody";
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

        <TermsBody />

        <p className="mut" style={{ fontSize: 13 }}>
          Questions? <a href="mailto:hello@lakelife.ai">hello@lakelife.ai</a> — a human reads it.
        </p>
      </main>
    </>
  );
}
