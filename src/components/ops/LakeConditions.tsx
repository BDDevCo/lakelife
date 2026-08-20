"use client";

/**
 * Editable per-lake season dates (ops only). Ice-out and the estimated hard
 * freeze are entered by hand; the pull deadline is derived live (hard freeze
 * minus an 8-day safety buffer, rule 7) and shown read-only. Saving reflows
 * the customer booking calendar, which reads these dates.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateLakeConditions } from "@/app/ops/actions";
import { toast } from "@/components/Toast";
import type { LakeCondition } from "@/app/ops/data";

/** Hard freeze (yyyy-mm-dd) minus 8 days, formatted "Mon D". "—" if empty/invalid. */
function pullDeadlineLabel(hardFreeze: string): string {
  if (!hardFreeze) return "—";
  const d = new Date(hardFreeze + "T12:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  d.setDate(d.getDate() - 8);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LakeConditions({ lakes }: { lakes: LakeCondition[] }) {
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {lakes.map((lake) => (
          <LakeCard key={lake.id} lake={lake} />
        ))}
      </div>
      <p className="mut" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.5 }}>
        How this drives scheduling: spring water-work opens the customer calendar only after each
        lake&apos;s confirmed ice-out; fall pier &amp; lift removals block after the pull deadline
        (hard freeze minus an 8-day safety buffer).
      </p>
    </>
  );
}

function LakeCard({ lake }: { lake: LakeCondition }) {
  const router = useRouter();
  const [iceOut, setIceOut] = useState(lake.ice_out_actual ?? "");
  const [hardFreeze, setHardFreeze] = useState(lake.hard_freeze_est ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await updateLakeConditions(lake.id, {
        iceOut: iceOut || null,
        hardFreeze: hardFreeze || null,
      });
      if (res.ok) {
        toast("Saved — the booking calendar will reflect these dates.");
        router.refresh();
      } else {
        toast(res.error ?? "Couldn't save.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ll-card ll-card-pad">
      {/* A SCRATCH LAKE LOOKED EXACTLY LIKE A REAL ONE HERE.
          0124 fenced fixtures off every public surface and deliberately left
          them in this editor — somebody has to be able to set a scratch lake's
          dates — but with nothing marking them. A card for a fixture sat
          between Big Long and Pretty looking identical, and the six date
          fields that gate the whole spring water calendar are typed by hand,
          once a year, from memory. The real ice-out goes into the wrong card
          and the lake that needed it stays provisional: its pull reminder
          never fires and a pier is left in the ice. `is_fixture` was already
          loaded onto this view model and read by nothing. */}
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 800, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {lake.name}
        {lake.is_fixture && <span className="ll-pill slate" style={{ fontSize: 11 }}>Test lake</span>}
      </h3>
      {lake.is_fixture && (
        <div className="mut" style={{ fontSize: 12.5, marginTop: 2 }}>
          Not a real lake — nothing here reaches a customer.
        </div>
      )}
      <div className="mut" style={{ fontSize: 13, marginTop: 2 }}>
        {lake.active_properties} active properties
      </div>

      <div className="ll-field" style={{ marginTop: 14 }}>
        <label>Ice-out (actual)</label>
        <input type="date" value={iceOut} onChange={(e) => setIceOut(e.target.value)} />
      </div>

      <div className="ll-field">
        <label>Est. hard freeze</label>
        <input type="date" value={hardFreeze} onChange={(e) => setHardFreeze(e.target.value)} />
      </div>

      <div style={{ marginTop: 6, fontSize: 13 }}>
        <span className="mut">Pull deadline:</span>{" "}
        <b style={{ color: "var(--warn)" }}>{pullDeadlineLabel(hardFreeze)}</b>
      </div>

      <button className="ll-btn sm" style={{ marginTop: 14 }} onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
