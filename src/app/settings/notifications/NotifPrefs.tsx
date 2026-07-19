"use client";

import { useState } from "react";
import { NOTIF_DEFS } from "@/lib/notifications";
import { channelsFor, CHANNEL_LABEL, type Channel, type NotifPrefState } from "@/lib/notif-prefs";
import { setNotifPref } from "./actions";
import { toast } from "@/components/Toast";

export function NotifPrefs({ initial }: { initial: NotifPrefState }) {
  const [states, setStates] = useState<NotifPrefState>(initial);

  async function toggle(type: string, channel: Channel) {
    const cur = states[type]?.[channel] ?? true;
    const next = !cur;
    // optimistic
    setStates((s) => ({ ...s, [type]: { ...s[type], [channel]: next } }));
    const res = await setNotifPref(type, channel, next);
    if (!res.ok) {
      // revert
      setStates((s) => ({ ...s, [type]: { ...s[type], [channel]: cur } }));
      toast(res.error ?? "Couldn't update that preference.");
    }
  }

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 18, marginBottom: 4 }}>Notifications</h3>
      <p className="mut" style={{ fontSize: 13, marginBottom: 4 }}>
        Choose how LakeLife reaches you for each kind of update.
      </p>
      <p className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Receipts &amp; invoices always send by email so you never miss a charge. 🌊
      </p>

      {NOTIF_DEFS.map((n) => {
        const channels = channelsFor(n);
        return (
          <div
            key={n.type}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "12px 0",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 13.5 }}>{n.label}</div>
              <div className="mut" style={{ fontSize: 12 }}>{n.channel}</div>
            </div>

            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              {n.locked ? (
                <>
                  {channels.map((ch) => (
                    <Chip key={ch} label={CHANNEL_LABEL[ch]} on locked />
                  ))}
                  <span className="ll-pill slate">always on</span>
                </>
              ) : (
                channels.map((ch) => (
                  <Chip
                    key={ch}
                    label={CHANNEL_LABEL[ch]}
                    on={states[n.type]?.[ch] ?? true}
                    onClick={() => toggle(n.type, ch)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chip({
  label,
  on,
  locked,
  onClick,
}: {
  label: string;
  on: boolean;
  locked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={locked}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 11px",
        borderRadius: 99,
        fontSize: 12.5,
        fontWeight: 800,
        cursor: locked ? "default" : "pointer",
        border: `1.5px solid ${on ? "var(--teal)" : "var(--line)"}`,
        background: on ? "var(--teal)" : "transparent",
        color: on ? "#fff" : "var(--sub)",
        opacity: locked ? 0.7 : 1,
        transition: "background .15s, border-color .15s, color .15s",
      }}
    >
      <span aria-hidden style={{ fontSize: 11 }}>{on ? "✓" : "○"}</span>
      {label}
    </button>
  );
}
