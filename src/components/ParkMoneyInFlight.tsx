"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { markBankPaymentCleared, recordBankReturn, type InFlightPayment } from "@/app/park/clearing-actions";
import {
  RETURN_REASONS, inFlightSummary, whatToDoAfterReturn,
} from "@/app/park/clearing-helpers";
import { money } from "@/lib/allocations";
import { prettyMonth } from "@/app/park/ledger-helpers";

/**
 * MONEY ASKED FOR AND NOT LANDED — and the two things that end it.
 *
 * This screen is the outlet the bank rail never had. Five surfaces already
 * explain money that is on its way; until this panel nothing anywhere could
 * say it arrived, so "$542.53 is on its way from your bank" was a sentence
 * with no ending. Both writes here are one-way at the database (0155, 0191),
 * so both are confirmed before they go.
 *
 * IT DOES NOT RENDER WHEN THERE IS NOTHING IN FLIGHT. An empty card on this
 * screen every month for a park whose rent all arrives as cheques is clutter
 * that teaches the reader to skip the whole column. A FAILED READ still
 * renders, because "nothing is on its way" is the reassuring way to be wrong
 * about money in flight.
 */
export function ParkMoneyInFlight({
  parkId,
  rows,
}: {
  parkId: string;
  rows: InFlightPayment[] | null;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  /** Which row is mid-decision, and which of the two it is. */
  const [open, setOpen] = useState<{ id: string; what: "landed" | "returned" } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  if (rows === null) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <span className="ll-pill slate">Money on its way</span>
        <p style={{ fontSize: 14, margin: "10px 0 0", lineHeight: 1.55 }}>
          We couldn&apos;t read what&apos;s still clearing. This is blank
          because the question went unanswered, not because nothing is on its
          way — so don&apos;t read the arrears figure as complete until it
          loads.
        </p>
      </div>
    );
  }

  if (rows.length === 0) return null;

  const summary = inFlightSummary({ rows, money });
  const anyStuck = rows.some((r) => r.kind === "stuck");

  function act(key: string, run: () => Promise<{ ok: boolean; error?: string; signal?: string }>) {
    setBusy(key);
    start(async () => {
      const res = await run();
      setBusy(null);
      if (!res.ok) { toast.err(res.error ?? "That didn't work."); return; }
      setOpen(null);
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  /** The code for a row: the picked one, or what was typed for an unlisted one. */
  const codeFor = (id: string) => {
    const picked = codes[id] ?? "";
    return picked === "OTHER" ? (typed[id] ?? "").trim().toUpperCase() : picked;
  };

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ marginTop: 18, borderLeft: anyStuck ? "4px solid var(--gold)" : undefined }}
    >
      <span className={`ll-pill ${anyStuck ? "gold" : "slate"}`}>Money on its way</span>
      <h2 style={{ fontSize: 16, margin: "10px 0 4px" }}>
        {rows.length === 1 ? "1 bank payment hasn't landed yet" : `${rows.length} bank payments haven't landed yet`}
      </h2>
      {summary && (
        <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
          {summary}
        </p>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((r) => {
          const who = [r.lotNumber ? `Lot ${r.lotNumber}` : null, r.payerName].filter(Boolean).join(" · ");
          const picked = codes[r.id] ?? "";
          const ready = picked === "OTHER" ? /^R\d{2}$/.test(codeFor(r.id)) : picked !== "";
          return (
            <div
              key={r.id}
              style={{
                padding: "11px 13px",
                borderRadius: 10,
                background: r.kind === "stuck" ? "var(--sand-light)" : "transparent",
                border: r.kind === "stuck" ? "none" : "1px solid var(--line)",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                <strong style={{ fontSize: 14, flex: "1 1 160px", minWidth: 0 }}>
                  {money(r.amountCents)}
                  {who ? ` — ${who}` : ""}
                </strong>
                <span className="mut" style={{ fontSize: 12.5 }}>
                  {r.periodMonth ? `${prettyMonth(r.periodMonth)} rent` : "on their account"}
                  {r.reference ? ` · ${r.reference}` : ""}
                </span>
              </div>
              <div className="mut" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
                {r.said}
              </div>

              {open?.id === r.id && open.what === "landed" ? (
                <div style={{ marginTop: 9 }}>
                  <div style={{ fontSize: 12.5, marginBottom: 6, lineHeight: 1.5 }}>
                    Only if you can see it in the park&apos;s account. This is
                    recorded once and can&apos;t be unsaid — it puts the money
                    on the bill and stops the household being chased for it.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      className="ll-btn"
                      style={{ fontSize: 13, padding: "7px 12px" }}
                      disabled={busy === r.id}
                      onClick={() => act(r.id, () => markBankPaymentCleared(parkId, r.id))}
                    >
                      {busy === r.id ? "Recording…" : "Yes, it's in the account"}
                    </button>
                    <button
                      className="ll-btn ghost"
                      style={{ fontSize: 13, padding: "7px 12px" }}
                      disabled={busy === r.id}
                      onClick={() => setOpen(null)}
                    >
                      Not yet
                    </button>
                  </div>
                </div>
              ) : open?.id === r.id && open.what === "returned" ? (
                <div style={{ marginTop: 9 }}>
                  <div style={{ fontSize: 12.5, marginBottom: 6, lineHeight: 1.5 }}>
                    What did the bank say? The code is on their notice.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <select
                      value={picked}
                      onChange={(e) => setCodes((c) => ({ ...c, [r.id]: e.target.value }))}
                      style={{ flex: "1 1 260px", minWidth: 0 }}
                    >
                      <option value="">Pick what the bank said…</option>
                      {RETURN_REASONS.map((reason) => (
                        <option key={reason.code} value={reason.code}>
                          {reason.code} — {reason.said}
                        </option>
                      ))}
                      <option value="OTHER">A code that isn&apos;t on this list</option>
                    </select>
                    {picked === "OTHER" && (
                      <input
                        value={typed[r.id] ?? ""}
                        onChange={(e) => setTyped((t) => ({ ...t, [r.id]: e.target.value }))}
                        placeholder="e.g. R24"
                        maxLength={3}
                        style={{ width: 90 }}
                      />
                    )}
                  </div>
                  {/* WHAT IT WILL MEAN, BEFORE IT IS RECORDED. The one that
                      earns this: a return saying the household denied the
                      authorisation must not be answered by debiting them
                      again, and nothing about the words "returned" says so. */}
                  {ready && (
                    <div style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
                      {whatToDoAfterReturn(codeFor(r.id))}
                    </div>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    <button
                      className="ll-btn"
                      style={{ fontSize: 13, padding: "7px 12px" }}
                      disabled={busy === r.id || !ready}
                      onClick={() => act(r.id, () => recordBankReturn(parkId, r.id, codeFor(r.id)))}
                    >
                      {busy === r.id ? "Recording…" : "Record the return"}
                    </button>
                    <button
                      className="ll-btn ghost"
                      style={{ fontSize: 13, padding: "7px 12px" }}
                      disabled={busy === r.id}
                      onClick={() => setOpen(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  <button
                    className="ll-btn ghost"
                    style={{ fontSize: 12.5, padding: "5px 10px" }}
                    onClick={() => setOpen({ id: r.id, what: "landed" })}
                  >
                    It landed
                  </button>
                  <button
                    className="ll-btn ghost"
                    style={{ fontSize: 12.5, padding: "5px 10px" }}
                    onClick={() => setOpen({ id: r.id, what: "returned" })}
                  >
                    The bank sent it back
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mut" style={{ fontSize: 12, margin: "12px 0 0", lineHeight: 1.5 }}>
        None of this is arrears and nobody is being chased for it. Rent settles
        to the park&apos;s own account, so the park&apos;s own statement is
        what says it arrived.
      </p>
    </div>
  );
}
