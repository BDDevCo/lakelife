"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { quoteCancellation, cancelRequest, type CancelQuoteView } from "@/app/requests/actions";
import { toast } from "@/components/Toast";

/**
 * Fee-aware cancel: asks the server what cancelling costs RIGHT NOW, then
 * confirms with the customer before doing it. Free cancels say so plainly;
 * late cancels show the policy note + the exact fee on the button. The quote
 * carries no crew or margin info — only the customer-facing fee.
 */
export function CancelRequestButton({ jobId, serviceName }: { jobId: string; serviceName: string }) {
  const router = useRouter();
  const [quote, setQuote] = useState<CancelQuoteView | null>(null);
  const [pending, startTransition] = useTransition();

  function openConfirm() {
    startTransition(async () => {
      const q = await quoteCancellation(jobId);
      if (!q.allowed) {
        toast(q.policyNote);
        return;
      }
      setQuote(q);
    });
  }

  function confirmCancel() {
    startTransition(async () => {
      const res = await cancelRequest(jobId);
      if (res.ok) {
        toast(
          res.feeCharged
            ? `Cancelled — $${res.feeCharged.toFixed(2)} late fee applied.`
            : "Cancelled — no charge. 🌊",
        );
      } else {
        toast(res.error ?? "Couldn't cancel that.");
      }
      setQuote(null);
      router.refresh();
    });
  }

  return (
    <>
      <button className="ll-btn ghost sm" onClick={openConfirm} disabled={pending} style={{ minHeight: 44 }}>
        {pending && !quote ? "One sec…" : "Cancel"}
      </button>

      {quote && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Cancel ${serviceName}`}
          onClick={() => { if (!pending) setQuote(null); }}
          style={{
            position: "fixed", inset: 0, zIndex: 60, background: "rgba(10, 36, 48, 0.45)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            className="ll-card ll-card-pad"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 400, width: "100%", textAlign: "left" }}
          >
            <span className={`ll-pill ${quote.free ? "teal" : "warn"}`}>
              {quote.free ? "Free to cancel" : "Late cancellation"}
            </span>
            <h3 style={{ fontSize: 17, margin: "10px 0 6px" }}>Cancel {serviceName}?</h3>
            <p style={{ fontSize: 14, margin: "0 0 14px" }}>
              {quote.free ? "Cancel this request? No charge." : quote.policyNote}
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="ll-btn ghost" onClick={() => setQuote(null)} disabled={pending} style={{ minHeight: 44 }}>
                Keep it
              </button>
              <button
                className="ll-btn"
                onClick={confirmCancel}
                disabled={pending}
                style={{ minHeight: 44, ...(quote.free ? {} : { background: "var(--danger, #b23c2e)" }) }}
              >
                {pending
                  ? "Cancelling…"
                  : quote.free
                    ? "Yes, cancel"
                    : `Cancel & pay $${quote.fee.toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
