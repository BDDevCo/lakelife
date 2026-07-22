"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPropertyNickname } from "@/app/profile/property-actions";
import { toast } from "@/components/Toast";

/**
 * Compact inline nickname control: shows the current nickname ("The Cabin")
 * with a subtle edit affordance; expands to a small input + Save. Saving an
 * empty value clears the nickname.
 */
export function NicknameEditor({ propertyId, nickname }: { propertyId: string; nickname: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(nickname ?? "");
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const clean = value.trim();
      const res = await setPropertyNickname(propertyId, clean);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save that nickname.");
        return;
      }
      toast(clean ? "Nickname saved. 🌊" : "Nickname cleared.");
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {nickname && (
          <b style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--ink)" }}>{nickname}</b>
        )}
        <button
          onClick={() => { setValue(nickname ?? ""); setEditing(true); }}
          style={{
            background: "none", border: "none", padding: 0, minHeight: 44, cursor: "pointer",
            fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, color: "var(--teal-dark)",
          }}
        >
          ✎ nickname
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save(); }}
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={40}
        placeholder="e.g. The Cabin"
        autoFocus
        aria-label="Property nickname"
        style={{
          padding: "9px 12px", border: "1.5px solid var(--line)", borderRadius: 10,
          fontSize: 15, fontWeight: 700, fontFamily: "inherit", color: "var(--text)",
          background: "#fff", minHeight: 44, width: 200, maxWidth: "100%",
        }}
      />
      <button type="submit" className="ll-btn sm" disabled={pending} style={{ minHeight: 44 }}>
        {pending ? "Saving…" : "Save"}
      </button>
      <button type="button" className="ll-btn ghost sm" onClick={() => setEditing(false)} disabled={pending} style={{ minHeight: 44 }}>
        Cancel
      </button>
    </form>
  );
}
