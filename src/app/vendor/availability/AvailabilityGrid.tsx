"use client";

/**
 * The vendor's next few working days as a tap-to-toggle grid. Each row is a
 * day; the four columns are the crew's time slots. Tap an Open slot to block
 * it, tap a Blocked slot to reopen it. A slot holding a LakeLife job shows
 * "LL job" and is locked — dispatch moves those, not the vendor.
 *
 * Optimistic: a tapped cell flips instantly, then we call the server and let
 * router.refresh() reconcile. If the server says no (e.g. it's really booked),
 * we roll the cell back and toast why.
 */

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setSlot } from "./actions";
import { toast } from "@/components/Toast";

export type SlotStatus = "open" | "blocked" | "booked";

// Re-exported for existing importers; the VALUE lives in ./slots (a neutral
// module) because a client-module value export is only a proxy to the
// server page that also needs it.
import { SLOT_TIMES } from "./slots";
export { SLOT_TIMES } from "./slots";

export interface DayRow {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Thu 16"
  slots: Record<string, SlotStatus>; // slot -> status
}

export function AvailabilityGrid({ days }: { days: DayRow[] }) {
  const router = useRouter();
  // Optimistic overrides keyed by `${date}|${slot}`, cleared when fresh
  // server data arrives (new `days` reference after router.refresh()).
  const [pending, setPending] = useState<Record<string, SlotStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setPending({});
  }, [days]);

  async function tap(date: string, slot: string, status: SlotStatus) {
    if (status === "booked") return; // locked
    const key = `${date}|${slot}`;
    if (busy) return;
    const next: SlotStatus = status === "blocked" ? "open" : "blocked";

    setPending((p) => ({ ...p, [key]: next })); // optimistic
    setBusy(key);
    const res = await setSlot(date, slot, next === "blocked");
    setBusy(null);

    if (!res.ok) {
      setPending((p) => {
        const copy = { ...p };
        delete copy[key];
        return copy;
      });
      toast(res.error ?? "Couldn't update that slot.");
      return;
    }
    router.refresh();
  }

  const cols = `64px repeat(${SLOT_TIMES.length}, minmax(60px, 1fr))`;

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 6, minWidth: 340 }}>
          {/* header row */}
          <div />
          {SLOT_TIMES.map((s) => (
            <div key={s} style={headerCellStyle}>
              {s}
            </div>
          ))}

          {/* one row per working day */}
          {days.map((day) => (
            <Fragment key={day.date}>
              <div style={dayLabelStyle}>{day.label}</div>
              {SLOT_TIMES.map((slot) => {
                const status = pending[`${day.date}|${slot}`] ?? day.slots[slot] ?? "open";
                const locked = status === "booked";
                return (
                  <button
                    key={slot}
                    type="button"
                    disabled={locked}
                    aria-label={`${day.label} ${slot}: ${LABELS[status]}`}
                    aria-pressed={status === "blocked"}
                    onClick={() => tap(day.date, slot, status)}
                    style={cellStyle(status)}
                  >
                    {LABELS[status]}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 16 }}>
        <LegendItem status="booked" label="LL job (locked)" />
        <LegendItem status="open" label="Open to bookings" />
        <LegendItem status="blocked" label="Blocked" />
      </div>
    </div>
  );
}

const LABELS: Record<SlotStatus, string> = {
  open: "Open",
  blocked: "Blocked",
  booked: "LL job",
};

const headerCellStyle: React.CSSProperties = {
  textAlign: "center",
  fontSize: 12,
  fontWeight: 800,
  color: "var(--sub)",
  paddingBottom: 2,
  letterSpacing: "0.03em",
};

const dayLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 14,
  fontWeight: 800,
  color: "var(--text)",
  paddingRight: 4,
};

function cellStyle(status: SlotStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    minHeight: 48,
    borderRadius: 10,
    border: "1.5px solid var(--line)",
    fontWeight: 700,
    fontSize: 14,
    width: "100%",
    lineHeight: 1.1,
    transition: "all .12s",
  };
  if (status === "booked") {
    return {
      ...base,
      background: "#e0f0f3",
      borderColor: "#bfe0e6",
      color: "var(--teal-dark)",
      cursor: "not-allowed",
    };
  }
  if (status === "blocked") {
    return {
      ...base,
      color: "var(--sub)",
      background:
        "repeating-linear-gradient(45deg, #f2f5f6, #f2f5f6 6px, #e7edee 6px, #e7edee 12px)",
      cursor: "pointer",
    };
  }
  return { ...base, background: "#fff", color: "var(--teal-dark)", cursor: "pointer" };
}

function LegendItem({ status, label }: { status: SlotStatus; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5 }} className="mut">
      <span style={{ ...cellStyle(status), width: 20, minHeight: 20, height: 20, borderRadius: 6 }} />
      {label}
    </span>
  );
}
