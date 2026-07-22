"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setActiveProperty } from "@/app/profile/property-actions";
import type { PropertySummary } from "@/app/profile/data";

export function PropertySwitcher({
  properties,
  activeId,
}: {
  properties: PropertySummary[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function change(id: string) {
    if (id === activeId) return;
    setBusy(true);
    await setActiveProperty(id);
    router.refresh();
    setBusy(false);
  }

  const label = (p: PropertySummary) => {
    const base = `${p.address ?? "Property"}${p.lake ? ` · ${p.lake}` : ""}`;
    return p.nickname ? `${p.nickname} — ${base}` : base;
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {properties.length > 0 && (
        <select
          value={activeId ?? ""}
          disabled={busy}
          onChange={(e) => change(e.target.value)}
          aria-label="Choose property"
          style={{
            padding: "8px 12px", border: "1.5px solid var(--line)", borderRadius: 10,
            fontSize: 16, fontWeight: 700, fontFamily: "inherit", background: "#fff",
            color: "var(--text)", maxWidth: 320,
          }}
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{label(p)}</option>
          ))}
        </select>
      )}
      <Link
        href="/profile/setup?new=1"
        style={{ fontSize: 13.5, fontWeight: 700, color: "var(--teal-dark)", textDecoration: "none" }}
      >
        + Add a property
      </Link>
    </div>
  );
}
