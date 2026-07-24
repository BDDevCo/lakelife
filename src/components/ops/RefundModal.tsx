"use client";

/**
 * OPS: issue a refund on a paid/complete job (docs/refunds-design.md).
 * Loads a live preview via quoteRefund (refundable remaining, suggested crew
 * clawback, whether the crew's payout is still loose or already batched),
 * then submits via issueRefund. Every dollar shown here is ops-only (rule 1
 * lives on the OTHER side of this — the crew never sees these numbers, only
 * their own adjustment row in Earnings).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { quoteRefund, issueRefund } from "@/app/ops/refund-actions";
import { toast } from "@/components/Toast";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

interface Quote {
  refundable: number;
  capturedCash: number;
  alreadyRefunded: number;
  suggestedClawback: number;
  vendorCost: number;
  crewPaidOut: boolean;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
  borderRadius: 10, fontSize: 16, fontFamily: "inherit", color: "var(--text)", background: "#fff",
};

export function RefundModal({
  jobId,
  serviceName,
  address,
  onClose,
}: {
  jobId: string;
  serviceName?: string | null;
  address?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  // One key per modal open: a timed-out submit the ops user retries lands
  // exactly once server-side (refunds.idempotency_key unique).
  const [idempotencyKey] = useState(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `rk_${Math.random().toString(36).slice(2)}`));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);

  const [amount, setAmount] = useState("");
  const [clawback, setClawback] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await quoteRefund(jobId);
      if (!alive) return;
      if (!res.ok || res.refundable == null) {
        setLoadError(res.error ?? "Couldn't load refund details.");
        setLoading(false);
        return;
      }
      const q: Quote = {
        refundable: res.refundable,
        capturedCash: res.capturedCash ?? 0,
        alreadyRefunded: res.alreadyRefunded ?? 0,
        suggestedClawback: res.suggestedClawback ?? 0,
        vendorCost: res.vendorCost ?? 0,
        crewPaidOut: !!res.crewPaidOut,
      };
      setQuote(q);
      setAmount(q.refundable > 0 ? q.refundable.toFixed(2) : "");
      setClawback(q.suggestedClawback.toFixed(2));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Quantize to whole cents so the preview matches what the server stores.
  const amountNum = Math.round((Number(amount) || 0) * 100) / 100;
  const clawbackNum = Math.round((Number(clawback) || 0) * 100) / 100;
  const amountValid = !!quote && quote.refundable > 0 && Number.isFinite(amountNum) && amountNum > 0 && amountNum <= quote.refundable;
  const clawbackValid = !!quote && Number.isFinite(clawbackNum) && clawbackNum >= 0 && clawbackNum <= quote.vendorCost;
  const canSubmit = !loading && !!quote && amountValid && clawbackValid && reason.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const res = await issueRefund({ jobId, amount: amountNum, clawback: clawbackNum, reason: reason.trim(), idempotencyKey });
    if (!res.ok) {
      setError(res.error ?? "Couldn't issue the refund.");
      setBusy(false);
      return;
    }
    toast(`Refunded ${money.format(res.refunded ?? amountNum)} — customer notified. 🌊`);
    router.refresh();
    onClose();
  }

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill warn">Refund</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{serviceName ?? "Service"}</h3>
            {address && <div className="mut" style={{ fontSize: 13 }}>{address}</div>}
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ll-modal-body">
          {loading ? (
            <p className="mut" style={{ fontSize: 14 }}>Loading refund details…</p>
          ) : loadError ? (
            <p style={{ color: "var(--danger)", fontSize: 14 }}>{loadError}</p>
          ) : !quote ? null : quote.refundable <= 0 ? (
            <p className="mut" style={{ fontSize: 14 }}>
              This invoice is already fully refunded — nothing left to send back.
            </p>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 14 }}>
                <div>Captured <b>{money.format(quote.capturedCash)}</b></div>
                {quote.alreadyRefunded > 0 && (
                  <div className="mut">Already refunded {money.format(quote.alreadyRefunded)}</div>
                )}
                <div className="mut">Refundable now up to <b>{money.format(quote.refundable)}</b></div>
              </div>

              <div className="ll-field">
                <label>Refund amount</label>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {!amountValid && amount !== "" && (
                  <p style={{ color: "var(--warn)", fontSize: 12, marginTop: 6 }}>
                    Amount must be between $0.01 and {money.format(quote.refundable)}.
                  </p>
                )}
              </div>

              <div className="ll-field">
                <label>Crew clawback</label>
                <input inputMode="decimal" value={clawback} onChange={(e) => setClawback(e.target.value)} />
                <p className="mut" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  0 = goodwill, up to the crew&apos;s full cut ({money.format(quote.vendorCost)}) for crew-fault.
                  Suggested {money.format(quote.suggestedClawback)}.{" "}
                  {quote.crewPaidOut
                    ? "Crew already paid out — this nets against their next batch."
                    : "Crew payout still open — this reduces it directly."}
                </p>
                {!clawbackValid && clawback !== "" && (
                  <p style={{ color: "var(--warn)", fontSize: 12, marginTop: 6 }}>
                    Clawback must be between $0 and {money.format(quote.vendorCost)}.
                  </p>
                )}
              </div>

              <div className="ll-field">
                <label>Reason (required — this is the audit trail)</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
                />
              </div>

              {error && (
                <p style={{ color: "var(--danger)", fontSize: 13, marginBottom: 10 }}>{error}</p>
              )}

              <button className="ll-btn gold" style={{ width: "100%" }} onClick={submit} disabled={!canSubmit}>
                {busy ? "Refunding…" : `Refund ${amountValid ? money.format(amountNum) : "$0.00"}`}
              </button>
              <p className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 10 }}>
                The customer gets an SMS + email receipt. The crew is only ever told their own
                adjustment — never the customer&apos;s refund amount.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
