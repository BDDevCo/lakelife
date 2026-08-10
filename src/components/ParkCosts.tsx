"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { previewCostSplit, recordCost, removeCost, type CostRow } from "@/app/park/cost-actions";
import {
  COST_CATEGORY_LABEL, allocationSummary,
  type CostCategory, type CostAllocation,
} from "@/app/park/cost-helpers";
import type { recoveryByCategory } from "@/app/park/cost-helpers";

/**
 * WHAT THE PARK PAYS, AND WHAT COMES BACK.
 *
 * The screen's job is to make one number impossible to miss: what the park is
 * STILL CARRYING after recovery. That is the number the proforma is betting on
 * and the one that quietly drifts — a vacancy, an uncategorised bill, a month
 * nobody split.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CATEGORIES: CostCategory[] = [
  "water", "sewer", "trash", "common_electric", "grounds", "other",
];

export function ParkCosts({
  parkId, rows, summary, fees, recoveredByFee,
}: {
  parkId: string;
  rows: CostRow[];
  summary: ReturnType<typeof recoveryByCategory>;
  /** The fee section, rendered by the server page. */
  fees?: React.ReactNode;
  /**
   * TRUE when a live fee already covers these costs. Without this the summary
   * shouts "still yours" at a park that recovers everything through a flat
   * grounds fee — technically true of the per-bill split, and completely
   * misleading about the business.
   */
  recoveredByFee?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<CostCategory>("water");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<CostAllocation | null>(null);

  const amountNum = () => Number(amount.replace(/[$,\s]/g, ""));

  function doPreview() {
    start(async () => {
      const res = await previewCostSplit(parkId, category, from, to, amountNum());
      if (!res.ok || !res.preview) { toast(res.error ?? "Couldn't work that out."); return; }
      setPreview(res.preview.allocation);
    });
  }

  function save() {
    start(async () => {
      const res = await recordCost(parkId, category, from, to, amountNum(), note);
      if (!res.ok) { toast(res.error ?? "Couldn't save that."); return; }
      toast(res.signal ?? "Saved.");
      setOpen(false); setPreview(null); setAmount(""); setNote("");
      router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Costs &amp; fees</h1>
      <p className="mut" style={{ marginTop: 0, lineHeight: 1.5, maxWidth: 640 }}>
        What the park pays, and what it charges. Enter your bills here and the
        fee below gets checked against them — that comparison is the only
        honest answer to &ldquo;is my grounds fee set right?&rdquo;
      </p>

      {/* ---- THE NUMBER THAT MATTERS: what is still yours. --------------- */}
      {summary.lines.length > 0 && (
        <section className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gap: 3, fontVariantNumeric: "tabular-nums" }}>
            <Row label="you paid" value={money(summary.paid)} />
            <Row label="passed on" value={money(summary.recovered)} />
            <Row
              label={recoveredByFee ? "covered by your fee below" : summary.net < 0 ? "still yours" : "net"}
              value={money(Math.abs(summary.net))}
              strong
            />
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 12 }}>
            {summary.lines.map((l) => (
              <div key={l.category}
                style={{ display: "flex", gap: 10, padding: "4px 0", flexWrap: "wrap", fontSize: 14 }}>
                <span style={{ flex: 1 }}>{COST_CATEGORY_LABEL[l.category]}</span>
                <span className="mut">{money(l.paid)} paid</span>
                <span className="mut">{money(l.recovered)} back</span>
                <span style={{ minWidth: 92, textAlign: "right", fontWeight: 700 }}>
                  {l.net < 0 ? `−${money(Math.abs(l.net))}` : money(l.net)}
                </span>
              </div>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 13, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
            {recoveredByFee ? (
              <>
                You recover these through a flat fee rather than splitting each
                bill, so &ldquo;back&rdquo; reads zero here on purpose. Whether
                the fee actually covers them is the line below.
              </>
            ) : (
              <>
                A category showing the full amount as &ldquo;still yours&rdquo; is
                one you haven&apos;t passed on — grounds and lighting are often
                deliberate, water and trash usually aren&apos;t.
              </>
            )}
          </p>
        </section>
      )}

      {!open ? (
        <button className="ll-btn" style={{ marginTop: 16 }} onClick={() => setOpen(true)}>
          Enter a bill
        </button>
      ) : (
        <section className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 17, margin: "0 0 12px" }}>Enter a bill</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What for</span>
              <select value={category}
                onChange={(e) => { setCategory(e.target.value as CostCategory); setPreview(null); }}
                style={{ marginTop: 4 }}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{COST_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Period from</span>
              <input type="date" value={from}
                onChange={(e) => { setFrom(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">to</span>
              <input type="date" value={to}
                onChange={(e) => { setTo(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What it cost</span>
              <input value={amount} inputMode="decimal" placeholder="380.00"
                onChange={(e) => { setAmount(e.target.value); setPreview(null); }} style={{ marginTop: 4 }} />
            </label>
          </div>

          <label className="ll-field" style={{ fontSize: 13, marginTop: 12 }}>
            <span className="mut">Which bill (so you can find it later)</span>
            <input value={note} placeholder="March water — Wolcottville Utilities, acct 4471"
              onChange={(e) => setNote(e.target.value)} style={{ marginTop: 4 }} />
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button className="ll-btn ghost" onClick={doPreview}
              disabled={busy || !from || !to || !amount}>
              {busy ? "Working…" : "Show me the split"}
            </button>
            <button className="ll-btn ghost" onClick={() => { setOpen(false); setPreview(null); }}>
              Cancel
            </button>
          </div>

          {preview && (
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 16 }}>
                {allocationSummary(preview, category)}
              </p>
              {preview.shares.length > 0 && (
                <>
                  <div style={{ display: "grid", gap: 2, fontVariantNumeric: "tabular-nums", marginBottom: 12 }}>
                    <Row label="you paid" value={money(amountNum())} />
                    <Row label="passed on" value={money(preview.allocated)} />
                    <Row label="you carry" value={money(preview.parkAbsorbs)} strong />
                  </div>
                  <button className="ll-btn" onClick={save} disabled={busy}>
                    Save it and split it
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---- the bills themselves ---------------------------------------- */}
      {rows.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 10px" }}>Bills</h2>
          <div className="ll-card">
            {rows.map((r) => (
              <div key={r.id}
                style={{ padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ minWidth: 170 }}>{COST_CATEGORY_LABEL[r.category]}</strong>
                <span className="mut" style={{ minWidth: 170 }}>
                  {r.periodStart} → {r.periodEnd}
                </span>
                <span style={{ flex: 1 }}>{money(r.amountPaid)}</span>
                <span className="mut">
                  {money(r.allocatedTotal)} across {r.lots} {r.lots === 1 ? "lot" : "lots"}
                </span>
                <button className="ll-btn ghost" disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const res = await removeCost(parkId, r.id);
                      toast(res.ok ? (res.signal ?? "Removed.") : (res.error ?? "Couldn't remove that."));
                      router.refresh();
                    })
                  }>
                  Remove
                </button>
              </div>
            ))}
          </div>
          {rows.some((r) => r.sourceNote) && (
            <p className="mut" style={{ fontSize: 13, marginTop: 10 }}>
              Every bill keeps the note you typed, so a resident asking &ldquo;what
              is this $20?&rdquo; has an answer with a date on it.
            </p>
          )}
        </section>
      )}

      {fees}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 110, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
