"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  saveCostSchedule, setCostScheduleActive, type CostScheduleRow,
} from "@/app/park/cost-actions";
import { COST_CATEGORY_LABEL, SCHEDULABLE_CATEGORIES } from "@/app/park/cost-helpers";
import { ordinal } from "@/app/park/today-helpers";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * BILLS THAT ARRIVE EVERY MONTH.
 *
 * Migration 0114 created the table and /park/today has read it since; nothing
 * has ever written a row. The reminder mechanism existed entirely in the
 * reader, so the list was empty for every park and always would be.
 *
 * What it stores is the SHAPE of a bill — which one, roughly when, roughly how
 * much — and never the amount that gets billed. That number is always read off
 * a real invoice by a person. The hint exists so a wrong invoice is noticeable,
 * not so it can be used.
 */
export function ParkCostSchedules({
  parkId, rows,
}: { parkId: string; rows: CostScheduleRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [dueDay, setDueDay] = useState("");
  const [typical, setTypical] = useState("");
  const [label, setLabel] = useState("");
  const [busy, start] = useTransition();

  function reset() {
    setCategory(""); setDueDay(""); setTypical(""); setLabel(""); setOpen(false);
  }

  function save() {
    start(async () => {
      const res = await saveCostSchedule(parkId, {
        category, dueDay, typicalAmount: typical, label,
      });
      toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't save that."));
      if (res.ok) { reset(); router.refresh(); }
    });
  }

  function toggle(r: CostScheduleRow) {
    start(async () => {
      const res = await setCostScheduleActive(parkId, r.id, !r.active);
      toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't change that."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Bills that arrive every month</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
        Tell us the shape of a bill and it goes on your morning screen when
        it&apos;s due. We never guess the amount — you read that off the invoice.
      </p>

      <div className="ll-card">
        {rows.length === 0 ? (
          <div className="ll-card-pad">
            <p className="mut" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
              {/* SAYS WHAT IT CHECKED. An empty list that just says "none" is
                  indistinguishable from one that never looked. */}
              No monthly reminders set up. If a bill like sewer or trash lands
              every month, tell us roughly when and it&apos;ll be waiting for you
              on the day.
            </p>
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.id} style={{
              padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)",
              display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline",
              opacity: r.active ? 1 : 0.55,
            }}>
              <strong style={{ minWidth: 170 }}>
                {r.label || COST_CATEGORY_LABEL[r.category]}
              </strong>
              <span className="mut" style={{ minWidth: 140 }}>
                {/* "the 5" reads like a truncated number; "the 5th" is a date. */}
                around the {ordinal(r.dueDay)}
              </span>
              <span className="mut" style={{ flex: 1, minWidth: 150 }}>
                {r.typicalAmount != null
                  ? `usually about ${money(r.typicalAmount)}`
                  : "amount unknown — that's fine"}
              </span>
              <button className="ll-btn ghost" disabled={busy} onClick={() => toggle(r)}>
                {r.active ? "Switch off" : "Switch on"}
              </button>
            </div>
          ))
        )}
      </div>

      {!open ? (
        <button className="ll-btn ghost" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
          Remind me about a bill
        </button>
      ) : (
        <div className="ll-card ll-card-pad" style={{ marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ margin: 0 }}>
              <span>Which bill</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Pick one…</option>
                {SCHEDULABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{COST_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </label>

            <label className="ll-field" style={{ margin: 0 }}>
              <span>Roughly what day it lands</span>
              <input inputMode="numeric" value={dueDay} placeholder="5"
                     onChange={(e) => setDueDay(e.target.value)} />
            </label>

            <label className="ll-field" style={{ margin: 0 }}>
              <span>What it usually comes to (optional)</span>
              <input inputMode="decimal" value={typical} placeholder="1,430.00"
                     onChange={(e) => setTypical(e.target.value)} />
            </label>

            <label className="ll-field" style={{ margin: 0 }}>
              <span>Call it something (optional)</span>
              <input value={label} placeholder="LaGrange County sewer"
                     onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>

          <p className="mut" style={{ fontSize: 12, margin: "4px 0 12px", lineHeight: 1.5 }}>
            {/* 0114's column comment, on screen. This is the one field a reader
                could misunderstand, so it says so where the field is. */}
            The amount is only so the reminder can say what to expect — it is
            never billed to anyone. The day is a rough one; the 28th is as late
            as it goes so every month has it.
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={save} disabled={busy || !category}>
              {busy ? "Saving…" : "Save the reminder"}
            </button>
            <button className="ll-btn ghost" onClick={reset} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
