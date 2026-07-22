"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { updatePlatformSettings } from "@/app/ops/settings-actions";

/**
 * Ops pricing dials (Phase C): the margin floor and surge cap the dispatch
 * engine enforces on every assignment. Whole-percent inputs; the server
 * clamps and stores fractions. Changes apply to future assignments only.
 */
export function PlatformSettingsCard({ settings }: { settings: { marginFloorPct: number; surgeCapPct: number } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [floor, setFloor] = useState(String(settings.marginFloorPct));
  const [cap, setCap] = useState(String(settings.surgeCapPct));

  function save() {
    startTransition(async () => {
      const res = await updatePlatformSettings(Number(floor), Number(cap));
      if (res.ok) {
        toast("Dials saved.");
        router.refresh();
      } else {
        toast(res.error ?? "Couldn't save the dials.");
      }
    });
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 18, margin: "0 0 4px" }}>Pricing dials</h3>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Set once — the machine enforces them on every assignment. Changes apply to future assignments only.
      </p>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Margin floor %</span>
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={60}
            step="1"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Surge cap %</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step="1"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            style={{ width: "100%", fontSize: 16, minHeight: 44, marginTop: 6 }}
          />
        </label>
      </div>

      <button className="ll-btn gold" onClick={save} disabled={pending} style={{ marginTop: 14, minHeight: 44 }}>
        {pending ? "Saving…" : "Save dials"}
      </button>
    </div>
  );
}
