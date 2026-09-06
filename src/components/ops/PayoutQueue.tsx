"use client";

/**
 * Payout queue — the automation seam (ops-only). Queued batches are what
 * the ACH export produces today and what a real bank API will execute
 * directly once it's live; exported batches are the trail left behind.
 * No bank numbers ever render here — those stay server-side, decrypted
 * only inside the export route handler.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { markBatchesPaid, markBatchesReturned } from "@/app/ops/payout-actions";
import type { PayoutQueue as PayoutQueueData } from "@/app/ops/payout-data";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * THE DAY THIS HAPPENED, NOT THE DAY THE VIEWER'S LAPTOP THINKS IT WAS.
 *
 * Both values this formats — a batch's `created_at` and a return's
 * `returned_at` — are timestamptz, real instants. Without a timeZone,
 * `toLocaleDateString` renders them in whatever zone the machine is set to,
 * so the same batch reads as a different DAY depending on who opens the
 * screen. That matters here specifically: the batches are written by a cron
 * at 00:00 UTC, which is the far side of midnight from the lakes, and this is
 * the screen somebody reconciles against a bank statement.
 *
 * Pinned to the business's own zone, which is where the work happened and
 * what the bank's own dates will be in. NOT a park's zone — this is the ops
 * console, and a second park in another state does not move LakeLife. The
 * rest of the app pins the same way (book/actions.ts, vendor/open-data.ts).
 */
function prettyDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Indiana/Indianapolis",
  });
}

// Only the two statuses the queue query fetches. A returned batch is NOT a
// row in this table — it gets its own card below, because the thing that
// matters about it is the bank's reason and the phone call it needs, neither
// of which fits in a status column.
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
  const { queuedCount, queuedTotal, exportedCount, exportedTotal, rows, returned } = queue;
  const router = useRouter();
  const [busy, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState("");

  const exportedRows = rows.filter((r) => r.status === "exported");
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ fontSize: 17, margin: "0 0 2px" }}>Payout queue</h3>
          <p className="mut" style={{ fontSize: 13, margin: 0 }}>
            The automation seam — export runs the ACH file and marks these exported until the bank API replaces it.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {queuedCount > 0 && (
            <form method="post" action="/api/ops/payout-export">
              <button className="ll-btn gold" type="submit">Download ACH batch (CSV)</button>
            </form>
          )}
          {/* A RE-DOWNLOAD IS ITS OWN BUTTON NOW. It used to be the same one,
              and the file quietly carried every unpaid earlier batch with it. */}
          {exportedRows.length > 0 && (
            <form method="post" action="/api/ops/payout-export?redownload=1">
              <button className="ll-btn" type="submit">
                Re-download {exportedRows.length} already-exported
              </button>
            </form>
          )}
        </div>
      </div>

      {/* The batches that have been in a file and never closed out. Until one
          is marked paid it can be pulled into another export — which is how a
          crew gets paid twice — so this says so plainly and gives ops the
          control that was missing entirely. */}
      {exportedRows.length > 0 && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 12, background: "rgba(200,150,40,.07)" }}>
          <strong style={{ fontSize: 14 }}>
            {exportedRows.length} {exportedRows.length === 1 ? "batch has" : "batches have"} been
            exported but not marked paid
          </strong>
          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 10px", lineHeight: 1.5 }}>
            Once the bank file has actually gone up, tick them here. Anything left
            unticked can be pulled into a later export — which pays that crew twice.
          </p>
          <div style={{ display: "grid", gap: 5 }}>
            {exportedRows.map((r) => (
              <label key={r.id} style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                <span>{r.payee} — {money(r.net)} · {prettyDate(r.created_at)}</span>
              </label>
            ))}
          </div>
          <button
            className="ll-btn"
            style={{ marginTop: 10 }}
            disabled={busy || picked.size === 0}
            onClick={() =>
              start(async () => {
                const res = await markBatchesPaid([...picked]);
                toast(res.ok ? (res.signal ?? "Marked paid.") : (res.error ?? "Couldn't do that."));
                if (res.ok) { setPicked(new Set()); router.refresh(); }
              })
            }
          >
            {busy ? "Closing…" : `Mark ${picked.size || ""} paid`.trim()}
          </button>

          {/* THE OTHER THING THAT HAPPENS TO A BANK FILE.
              A payout can come back three to five business days after it looked
              final, and until this button existed there was no way to say so —
              the batch stayed 'exported' forever and the crew's pay stayed
              stamped with its batch_id, which every re-batch query filters out.
              So the money was unreachable through any path in the product.
              Same selection as Mark paid: these are the two ways a file ends. */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 700, marginBottom: 5 }}>
              …or the bank sent one back
            </label>
            <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.5 }}>
              Their pay goes straight back in the queue for the next run — so fix the
              crew&apos;s bank details before it goes out again, or it bounces a second time.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="ll-input"
                style={{ flex: "1 1 240px", minWidth: 0 }}
                placeholder="What the bank gave back — e.g. R02 account closed"
                value={why}
                maxLength={300}
                onChange={(e) => setWhy(e.target.value)}
              />
              <button
                className="ll-btn"
                disabled={busy || picked.size === 0 || !why.trim()}
                onClick={() =>
                  start(async () => {
                    const res = await markBatchesReturned([...picked], why);
                    toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't do that."));
                    if (res.ok) { setPicked(new Set()); setWhy(""); router.refresh(); }
                  })
                }
              >
                {busy ? "Recording…" : `Record ${picked.size || ""} returned`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WHAT CAME BACK, AND WHO IS STILL WAITING ON IT. The action's success
          message is the only other place the "fix their details" instruction
          appears, and Toast.tsx clears that after 3800ms. This stays. */}
      {returned.length > 0 && (
        <div className="ll-card ll-card-pad" style={{ marginTop: 12, background: "rgba(190,60,60,.07)" }}>
          <strong style={{ fontSize: 14 }}>
            {returned.length === 1 ? "A payout came back from the bank" : `${returned.length} payouts came back from the bank`}
          </strong>
          <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 10px", lineHeight: 1.5 }}>
            The money is already back in the queue for the next run. It will go to the
            same account and bounce again unless somebody rings them first.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {returned.map((r) => (
              <div key={r.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 700 }}>{r.payee}</span> — {money(r.net)} ·{" "}
                {prettyDate(r.returnedAt)}
                <br />
                <span className="mut">{r.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
