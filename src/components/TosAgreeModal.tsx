"use client";

/**
 * The moment-of-service agree modal: shown when a server action reports
 * needsTos (the signed-in user hasn't accepted the current TOS_VERSION yet).
 * A quick scroll-and-agree over the shared TermsBody — "I agree" retries the
 * SAME request with tosAccepted=true, stamping acceptance and pushing the
 * original request through in one motion. "Not now" just closes this overlay;
 * whatever triggered it (a booking modal, go-live) stays exactly as it was.
 */

import Link from "next/link";
import { TermsBody } from "@/components/TermsBody";

export function TosAgreeModal({
  open,
  busy,
  onAgree,
  onClose,
  agreeLabel = "I agree — book it 🌊",
}: {
  open: boolean;
  busy?: boolean;
  onAgree: () => void;
  onClose: () => void;
  agreeLabel?: string;
}) {
  if (!open) return null;

  return (
    <div
      className="ll-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="One quick thing — the ground rules"
      style={{ zIndex: 110 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ll-modal" style={{ maxWidth: 480 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill teal">Before we lock this in</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>One quick thing — the ground rules 🌊</h3>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ll-modal-body">
          <div
            style={{
              maxHeight: "40vh",
              overflowY: "auto",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: "12px 14px",
              marginBottom: 16,
            }}
          >
            <TermsBody />
            <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>
              Read the{" "}
              <Link href="/terms" target="_blank" rel="noopener noreferrer">
                full terms of service
              </Link>
              .
            </p>
          </div>

          <button className="ll-btn gold" style={{ width: "100%" }} onClick={onAgree} disabled={busy}>
            {busy ? "Working…" : agreeLabel}
          </button>
          <button
            className="ll-btn ghost"
            style={{ width: "100%", marginTop: 8 }}
            onClick={onClose}
            disabled={busy}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
