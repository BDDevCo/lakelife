"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { renewAgreement, type RenewalPreview } from "@/app/park/renew-actions";

/**
 * WRITING THE NEXT AGREEMENTS, a cycle at a time.
 *
 * At a three-month cap this is the park's main recurring job — nineteen
 * households, four times a year. Doing it one screen-hop at a time is how it
 * stops getting done, and a lapsed tenancy stops being billed silently.
 *
 * So the whole cycle is one list with a button per row, and the common case —
 * renew at the same rent — is a single tap with nothing to type.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ParkRenewals({
  parkId, rows,
}: { parkId: string; rows: RenewalPreview[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [rent, setRent] = useState("");

  if (rows.length === 0) return null;

  function renew(r: RenewalPreview, newRent?: string) {
    start(async () => {
      const res = await renewAgreement(parkId, r.reservationId, { newRent });
      toast(res.ok ? (res.signal ?? "Written.") : (res.error ?? "Couldn't write that."));
      if (res.ok) { setEditing(null); setRent(""); router.refresh(); }
    });
  }

  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Agreements to write</h2>
      <p className="mut" style={{ fontSize: 13, marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
        These run out soon and have nothing behind them. When one lapses the rent
        stops being billed — quietly, with no error.
      </p>

      <div className="ll-card">
        {rows.map((r) => (
          <div key={r.reservationId}
            style={{ padding: "11px 14px", borderTop: "1px solid rgba(0,0,0,.06)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ minWidth: 62 }}>Lot {r.lotNumber}</strong>
              <span style={{ flex: 1 }}>{r.renterName ?? "—"}</span>
              <span className="mut" style={{ fontSize: 13 }}>ends {r.priorEnd}</span>
              {r.quotedAmount != null && (
                <span className="mut" style={{ fontSize: 13 }}>{money(r.quotedAmount)}</span>
              )}
            </div>

            {r.plan.ok ? (
              <>
                <div className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                  Next one runs {r.plan.start} to {r.plan.end}
                  {r.plan.depositDue
                    ? " — new chain, so a deposit is due."
                    : " — consecutive, so no new deposit."}
                </div>

                {/* Said out loud past a year of consecutive short agreements.
                    Not advice — the length of a chain is a fact he should be
                    looking at, and a court would look at it too. */}
                {r.chainNote && (
                  <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                    {r.chainNote}
                  </div>
                )}

                {editing === r.reservationId ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                      <span className="mut">New rent</span>
                      <input value={rent} inputMode="decimal" autoFocus
                        onChange={(e) => setRent(e.target.value)}
                        placeholder={r.quotedAmount?.toFixed(2) ?? ""}
                        style={{ marginTop: 4, width: 120 }} />
                    </label>
                    <button className="ll-btn" disabled={busy}
                      onClick={() => renew(r, rent)}>Write it</button>
                    <button className="ll-btn ghost" disabled={busy}
                      onClick={() => { setEditing(null); setRent(""); }}>Back</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {/* The common case is one tap and nothing typed. */}
                    <button className="ll-btn" disabled={busy}
                      style={{ padding: "6px 14px", fontSize: 14 }}
                      onClick={() => renew(r)}>
                      Renew at the same rent
                    </button>
                    <button className="ll-btn ghost" disabled={busy}
                      style={{ padding: "6px 12px", fontSize: 14 }}
                      onClick={() => { setEditing(r.reservationId); setRent(""); }}>
                      Renew at a new rent
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                {r.refusalText}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
