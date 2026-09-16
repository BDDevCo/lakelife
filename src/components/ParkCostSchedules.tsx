"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  saveCostSchedule, setCostScheduleActive, type CostScheduleRow,
} from "@/app/park/cost-actions";
import {
  COST_CATEGORY_LABEL, SCHEDULABLE_CATEGORIES, coveredSpanWords, editingReminderLine,
} from "@/app/park/cost-helpers";
import { ordinal } from "@/app/park/today-helpers";
// A day a person reads is words — never "2027-01-01" beside a checkbox.
import { dayInWords } from "@/app/park/park-helpers";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * BILLS THAT COME ROUND AGAIN.
 *
 * Migration 0114 created the table and /park/today has read it since; nothing
 * has ever written a row. The reminder mechanism existed entirely in the
 * reader, so the list was empty for every park and always would be.
 *
 * What it stores is the SHAPE of a bill — which one, roughly when, roughly how
 * much — and never the amount that gets billed. That number is always read off
 * a real invoice by a person. The hint exists so a wrong invoice is noticeable,
 * not so it can be used.
 *
 * AND, SINCE 0170, WHAT THE BILL COVERS. Indiana bills property tax in
 * arrears and LaGrange sewer's bill dated the 5th is for the previous month,
 * so a reminder that named the due period called December's sewer "January"
 * and the seller's 2026 tax "2027". The checkbox is the owner's word on it,
 * per bill; nothing infers it.
 *
 * `cutoverOn` is the park's go-live date, or null for a park with no
 * handover. The hint under the checkbox names it only when it is set — a
 * sentence about "before you went live" on a park that never went live
 * anywhere would be quoting a dial nobody set.
 */
export function ParkCostSchedules({
  parkId, rows, cutoverOn = null,
}: { parkId: string; rows: CostScheduleRow[]; cutoverOn?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [cadence, setCadence] = useState("monthly");
  const [dueMonth, setDueMonth] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [typical, setTypical] = useState("");
  const [label, setLabel] = useState("");
  const [coversPrior, setCoversPrior] = useState(false);
  /**
   * The row being EDITED, or null when adding. The write path is the same
   * either way — saveCostSchedule finds the park's row for the category and
   * updates it — so the only thing edit mode changes on screen is that the
   * category cannot be switched (that would create a second reminder, not
   * move this one) and the copy says what pressing Save does.
   */
  const [editing, setEditing] = useState<CostScheduleRow | null>(null);
  const [busy, start] = useTransition();

  function reset() {
    setCategory(""); setCadence("monthly"); setDueMonth("");
    setDueDay(""); setTypical(""); setLabel(""); setCoversPrior(false);
    setEditing(null); setOpen(false);
  }

  // THE EDIT DOOR. The Haven's two schedules predate the checkbox; without
  // this the only way to tick it was to switch a reminder off and retype it.
  function edit(r: CostScheduleRow) {
    setCategory(r.category);
    setCadence(r.cadence);
    setDueMonth(r.dueMonth == null ? "" : String(r.dueMonth));
    setDueDay(String(r.dueDay));
    setTypical(r.typicalAmount == null ? "" : String(r.typicalAmount));
    setLabel(r.label ?? "");
    setCoversPrior(r.coversPriorPeriod);
    setEditing(r);
    setOpen(true);
  }

  function save() {
    start(async () => {
      const res = await saveCostSchedule(parkId, {
        category, cadence, dueMonth, dueDay, typicalAmount: typical, label,
        coversPriorPeriod: coversPrior,
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
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Bills that come round again</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.55 }}>
        Tell us the shape of a bill — monthly, quarterly, or once a year — and
        it goes on your morning screen when it&apos;s due. We never guess the
        amount; you read that off the invoice.
      </p>

      <div className="ll-card">
        {rows.length === 0 ? (
          <div className="ll-card-pad">
            <p className="mut" style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>
              {/* SAYS WHAT IT CHECKED. An empty list that just says "none" is
                  indistinguishable from one that never looked. */}
              No reminders set up. Sewer every month, trash every quarter, the
              property tax once a year — tell us roughly when each one lands and
              it&apos;ll be waiting for you on the day.
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
              <span className="mut" style={{ minWidth: 190 }}>
                {/* "the 5" reads like a truncated number; "the 5th" is a date.
                    A flagged bill says what it covers, in the row, so he can
                    see the box took without opening the form. */}
                {r.cadence === "monthly"
                  ? `monthly, around the ${ordinal(r.dueDay)}`
                  : r.cadence === "annual"
                    ? `every ${MONTHS[(r.dueMonth ?? 1) - 1]}, around the ${ordinal(r.dueDay)}`
                    : `every 3 months from ${MONTHS[(r.dueMonth ?? 1) - 1]}, around the ${ordinal(r.dueDay)}`}
                {r.coversPriorPeriod ? `, for the ${coveredSpanWords(r.cadence)} before` : ""}
              </span>
              <span className="mut" style={{ flex: 1, minWidth: 150 }}>
                {r.typicalAmount != null
                  ? `usually about ${money(r.typicalAmount)}`
                  : "amount unknown — that's fine"}
              </span>
              <button className="ll-btn ghost" disabled={busy} onClick={() => edit(r)}>
                Edit
              </button>
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
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Which bill</span>
              {/* LOCKED WHILE EDITING. saveCostSchedule finds the row by
                  category, so changing it here would add a second reminder
                  and leave this one exactly as it was. */}
              <select value={category} disabled={editing != null}
                      onChange={(e) => setCategory(e.target.value)}>
                <option value="">Pick one…</option>
                {SCHEDULABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{COST_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </label>

            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">How often</span>
              <select value={cadence} onChange={(e) => { setCadence(e.target.value); setDueMonth(""); }}>
                <option value="monthly">Every month</option>
                <option value="quarterly">Every three months</option>
                <option value="annual">Once a year</option>
              </select>
            </label>

            {/* WHICH MONTH only exists for the two cadences that need it. Shown
                for a monthly bill it would be a question with no answer. */}
            {cadence !== "monthly" && (
              <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                <span className="mut">{cadence === "annual" ? "Which month" : "First one lands in"}</span>
                <select value={dueMonth} onChange={(e) => setDueMonth(e.target.value)}>
                  <option value="">Pick a month…</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </label>
            )}

            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Roughly what day it lands</span>
              <input inputMode="numeric" value={dueDay} placeholder="5"
                     onChange={(e) => setDueDay(e.target.value)} />
            </label>

            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">What it usually comes to (optional)</span>
              <input inputMode="decimal" value={typical} placeholder="1,430.00"
                     onChange={(e) => setTypical(e.target.value)} />
            </label>

            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Call it something (optional)</span>
              <input value={label} placeholder="LaGrange County sewer"
                     onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>

          {/* WHAT THE BILL COVERS (0170). A plain label around the box — not a
              .ll-field, whose caption rule would style the sentence as a
              12.5px heading. */}
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={coversPrior}
              onChange={(e) => setCoversPrior(e.target.checked)} />
            This bill is for the time before it&apos;s due — like a tax bill for
            last year, or a sewer bill for last month&apos;s service.
          </label>
          {coversPrior && (
            <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0", lineHeight: 1.5 }}>
              The reminder will name the {coveredSpanWords(cadence)} the bill
              covers as well as the day it&apos;s due.
              {/* Only for a park that has a go-live date — the sentence quotes
                  it, and a park with none has no "before" to speak of. */}
              {cutoverOn && (
                <>
                  {" "}A bill for time from before you went live on {dayInWords(cutoverOn)} is
                  never asked for — if the park changed hands, that belongs on the closing statement.
                </>
              )}
            </p>
          )}

          <p className="mut" style={{ fontSize: 12, margin: "4px 0 12px", lineHeight: 1.5 }}>
            The property tax and the insurance come once a year — set those to
            &ldquo;once a year&rdquo; and they&apos;ll be one reminder each,
            not twelve.{" "}
            {/* 0114's column comment, on screen. This is the one field a reader
                could misunderstand, so it says so where the field is. */}
            The amount is only so the reminder can say what to expect — it is
            never billed to anyone. The day is a rough one; the 28th is as late
            as it goes so every month has it.
          </p>

          {editing && (
            <p className="mut" style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.5 }}>
              {editingReminderLine(editing.category, editing.active)}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={save} disabled={busy || !category}>
              {busy ? "Saving…" : editing ? "Save the changes" : "Save the reminder"}
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
