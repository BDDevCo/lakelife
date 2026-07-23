"use client";

/**
 * Payout queue — the automation seam (ops-only). Queued batches are what
 * the ACH export produces today and what a real bank API will execute
 * directly once it's live; exported batches are the trail left behind.
 * No bank numbers ever render here — those stay server-side, decrypted
 * only inside the export route handler.
 */

import type { PayoutQueue as PayoutQueueData } from "@/app/ops/payout-data";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function prettyDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_PILL: Record<string, { tone: string; label: string }> = {
  queued: { tone: "gold", label: "queued" },
  exported: { tone: "teal", label: "exported" },
};

const KIND_LABEL: Record<string, string> = {
  early: "early pull",
  monthly: "month-end",
  referral: "referral",
};

const EMPTY_COPY =
  "Nothing queued — payouts batch themselves at month-end, early pulls land here the moment a crew taps.";

export function PayoutQueue({ queue }: { queue: PayoutQueueData }) {
  const { queuedCount, queuedTotal, exportedCount, exportedTotal, rows } = queue;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Payout queue</h3>
          <p className="mut" style={{ fontSize: 13, margin: 0 }}>
            The automation seam — export runs the ACH file and marks these exported until the bank API replaces it.
          </p>
        </div>
        {(queuedCount > 0 || rows.some((r) => r.status === "exported")) && (
          <form method="post" action="/api/ops/payout-export">
            <button className="ll-btn gold" type="submit">
              {queuedCount > 0 ? "Download ACH batch (CSV)" : "Re-download exported batch (CSV)"}
            </button>
          </form>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mut" style={{ fontSize: 13.5, padding: "10px 2px 2px" }}>{EMPTY_COPY}</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0" }}>
            <span className="ll-pill gold">{queuedCount} queued · {money(queuedTotal)}</span>
            <span className="ll-pill teal">{exportedCount} exported · {money(exportedTotal)}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--sub)" }}>
                  <th style={{ padding: "6px 8px" }}>Payee</th>
                  <th style={{ padding: "6px 8px" }}>Kind</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Net</th>
                  <th style={{ padding: "6px 8px" }}>Status</th>
                  <th style={{ padding: "6px 8px" }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pill = STATUS_PILL[r.status] ?? { tone: "slate", label: r.status };
                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "7px 8px", fontWeight: 700 }}>{r.payee}</td>
                      <td style={{ padding: "7px 8px" }}>{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td style={{ padding: "7px 8px", textAlign: "right" }}>{money(r.net)}</td>
                      <td style={{ padding: "7px 8px" }}>
                        <span className={`ll-pill ${pill.tone}`}>{pill.label}</span>
                      </td>
                      <td style={{ padding: "7px 8px" }}>{prettyDate(r.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
