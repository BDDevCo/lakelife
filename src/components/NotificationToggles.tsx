"use client";

import { useState } from "react";
import { NOTIF_DEFS } from "@/lib/notifications";
import { setNotif } from "@/app/profile/notif-actions";
import { toast } from "@/components/Toast";

export function NotificationToggles({ initial }: { initial: Record<string, boolean> }) {
  const [states, setStates] = useState<Record<string, boolean>>(initial);

  async function toggle(type: string) {
    const next = !states[type];
    setStates((s) => ({ ...s, [type]: next })); // optimistic
    const res = await setNotif(type, next);
    if (!res.ok) {
      setStates((s) => ({ ...s, [type]: !next })); // revert
      toast("Couldn't update that preference.");
    }
  }

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 18, marginBottom: 4 }}>Notifications</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 12 }}>
        How LakeLife keeps you posted. Receipts are always on.
      </p>
      {NOTIF_DEFS.map((n) => (
        <div
          key={n.type}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            gap: 12, padding: "10px 0", borderBottom: "1px solid var(--line)",
          }}
        >
          <div>
            <div style={{ fontWeight: 800, fontSize: 13.5 }}>{n.label}</div>
            <div className="mut" style={{ fontSize: 12 }}>{n.channel}{n.locked ? " · always on" : ""}</div>
          </div>
          {n.locked ? (
            <span className="ll-pill slate">Required</span>
          ) : (
            <button
              role="switch"
              aria-checked={states[n.type]}
              aria-label={n.label}
              onClick={() => toggle(n.type)}
              style={{
                width: 44, height: 26, borderRadius: 99, border: "none", flexShrink: 0,
                background: states[n.type] ? "var(--teal)" : "#cdd9dd",
                position: "relative", cursor: "pointer", transition: "background .15s",
              }}
            >
              <span
                style={{
                  position: "absolute", top: 3, left: states[n.type] ? 21 : 3,
                  width: 20, height: 20, borderRadius: 99, background: "#fff",
                  transition: "left .15s", boxShadow: "0 1px 2px rgba(0,0,0,.2)",
                }}
              />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
