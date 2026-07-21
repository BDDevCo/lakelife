"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { setPreferredCrew } from "@/app/ops/dispatch-actions";
import type { ActiveVendor } from "@/app/ops/data";

/**
 * Small ops control to pick a property's preferred crew — the crew that gets
 * first right of refusal at auto-dispatch. Shows the current pick as a star
 * pill and a dropdown of active crews. No customer price or margin here (rule 1).
 */
export function PreferredCrew({
  propertyId,
  current,
  currentCompany,
  crews,
}: {
  propertyId: string | null;
  current: string | null;
  currentCompany: string | null;
  crews: ActiveVendor[];
}) {
  const router = useRouter();
  const [value, setValue] = useState<string>(current ?? "");
  const [busy, setBusy] = useState(false);

  if (!propertyId) return null;

  async function save(next: string) {
    if (busy) return;
    setValue(next);
    setBusy(true);
    const res = await setPreferredCrew(propertyId as string, next || null);
    setBusy(false);
    if (!res.ok) {
      setValue(current ?? "");
      return toast(res.error ?? "Couldn't set the preferred crew.");
    }
    toast(next ? "Preferred crew set — they'll get first dibs. ⭐" : "Preferred crew cleared.");
    router.refresh();
  }

  const selectStyle: React.CSSProperties = {
    padding: "7px 10px", border: "1.5px solid var(--line)", borderRadius: 9,
    fontSize: 13, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {current && (
        <span className="ll-pill gold" title="Preferred crew for this property">
          ⭐ {currentCompany ?? "Preferred crew"}
        </span>
      )}
      <select value={value} onChange={(e) => save(e.target.value)} disabled={busy} style={selectStyle} aria-label="Preferred crew">
        <option value="">No preferred crew</option>
        {crews.map((v) => (
          <option key={v.id} value={v.id}>
            {v.company ?? "Crew"}{v.coi_ok ? "" : " — COI expired"}
          </option>
        ))}
      </select>
    </div>
  );
}
