"use client";

/**
 * "My trucks" — a contractor's self-serve fleet list on the Availability tab
 * (docs/fleet-routing-design.md). A truck is a `crew_units` row: its own
 * name + phone (the morning route text lands straight on the driver, no new
 * login), a jobs-per-day capacity, and working hours. Money, liability, and
 * standing never move here — that all stays on the vendor (CLAUDE.md).
 *
 * Load-bearing invariant: a vendor with zero trucks is on the LEGACY
 * single-route, count-based-capacity path — this card is purely additive.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { addTruck, updateTruck, setTruckActive, type TruckInput } from "@/app/vendor/trucks-actions";
import type { MyTruck } from "@/app/vendor/trucks-types";

const HOURS_START = Array.from({ length: 24 }, (_, i) => i); // 0..23
const HOURS_END = Array.from({ length: 24 }, (_, i) => i + 1); // 1..24

/** 7 -> "7am", 17 -> "5pm", 0 -> "12am", 24 -> "12am" (end-of-day midnight). */
function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  if (hh === 0) return "12am";
  if (hh === 12) return "12pm";
  return hh < 12 ? `${hh}am` : `${hh - 12}pm`;
}

/** Never show the full number in the list — last 4 digits only. */
function maskPhone(phone: string | null): string {
  if (!phone) return "No phone on file";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "•••• " + digits;
}

export function MyTrucks({ trucks: initialTrucks }: { trucks: MyTruck[] }) {
  const router = useRouter();
  const [trucks, setTrucks] = useState<MyTruck[]>(initialTrucks);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Re-sync to server truth whenever fresh data arrives (after refresh).
  useEffect(() => {
    setTrucks(initialTrucks);
    setEditingId(null);
    setAdding(false);
  }, [initialTrucks]);

  function saved(message: string) {
    setEditingId(null);
    setAdding(false);
    toast(message);
    router.refresh();
  }

  function toggleActive(truck: MyTruck) {
    if (busyId) return;
    setBusyId(truck.id);
    startTransition(async () => {
      const res = await setTruckActive(truck.id, !truck.active);
      setBusyId(null);
      if (!res.ok) {
        toast(res.error ?? "Couldn't update that truck.");
        return;
      }
      toast(truck.active ? "Truck turned off." : "Truck turned back on. 🌊");
      router.refresh();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>My trucks 🚚</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 14px" }}>
        Running more than one crew? Give each truck its own name — every truck gets its own morning
        route text sent straight to that driver, and your daily job capacity is the sum of every
        truck&apos;s capacity.
      </p>

      {trucks.length === 0 && !adding && (
        <p className="mut" style={{ fontSize: 14, margin: "0 0 14px" }}>
          One crew, one truck? You&apos;re all set — trucks are for contractors running multiple crews.
        </p>
      )}

      {trucks.length > 0 && (
        <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
          {trucks.map((truck) =>
            editingId === truck.id ? (
              <TruckForm
                key={truck.id}
                initial={truck}
                saveLabel="Save truck"
                pending={pending}
                onCancel={() => setEditingId(null)}
                onSave={(input) =>
                  startTransition(async () => {
                    const res = await updateTruck(truck.id, input);
                    if (!res.ok) {
                      toast(res.error ?? "Couldn't save that truck.");
                      return;
                    }
                    saved("Truck updated. 🌊");
                  })
                }
              />
            ) : (
              <TruckRow
                key={truck.id}
                truck={truck}
                busy={busyId === truck.id}
                onEdit={() => setEditingId(truck.id)}
                onToggleActive={() => toggleActive(truck)}
              />
            ),
          )}
        </div>
      )}

      {adding ? (
        <TruckForm
          initial={null}
          defaultName={`Truck ${trucks.length + 1}`}
          saveLabel="Add truck"
          pending={pending}
          onCancel={() => setAdding(false)}
          onSave={(input) =>
            startTransition(async () => {
              const res = await addTruck(input);
              if (!res.ok) {
                toast(res.error ?? "Couldn't add that truck.");
                return;
              }
              saved("Truck added. 🌊");
            })
          }
        />
      ) : (
        <button className="ll-btn ghost sm" onClick={() => setAdding(true)} style={{ minHeight: 44 }}>
          + Add a truck
        </button>
      )}
    </div>
  );
}

function TruckRow({
  truck,
  busy,
  onEdit,
  onToggleActive,
}: {
  truck: MyTruck;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
        padding: "10px 12px",
        border: "1px solid var(--line)",
        borderRadius: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{truck.name}</div>
        <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>
          {maskPhone(truck.phone)} · {truck.capacity} jobs/day · {hourLabel(truck.workStart)}–
          {hourLabel(truck.workEnd)}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`ll-pill ${truck.active ? "ok" : "slate"}`}>{truck.active ? "Active" : "Off"}</span>
        <button className="ll-btn ghost sm" onClick={onEdit} disabled={busy} style={{ minHeight: 40 }}>
          Edit
        </button>
        <button className="ll-btn ghost sm" onClick={onToggleActive} disabled={busy} style={{ minHeight: 40 }}>
          {truck.active ? "Turn off" : "Turn on"}
        </button>
      </div>
    </div>
  );
}

function TruckForm({
  initial,
  defaultName,
  saveLabel,
  pending,
  onSave,
  onCancel,
}: {
  initial: MyTruck | null;
  defaultName?: string;
  saveLabel: string;
  pending: boolean;
  onSave: (input: TruckInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? defaultName ?? "Truck 1");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 3));
  const [workStart, setWorkStart] = useState(initial?.workStart ?? 7);
  const [workEnd, setWorkEnd] = useState(initial?.workEnd ?? 17);

  function submit() {
    if (!name.trim()) {
      toast("Give the truck a name.");
      return;
    }
    const capacityNum = Math.floor(Number(capacity));
    if (!Number.isFinite(capacityNum) || capacityNum < 1 || capacityNum > 20) {
      toast("Capacity should be a whole number of jobs, 1 to 20.");
      return;
    }
    if (workEnd <= workStart) {
      toast("End time needs to be later than the start time.");
      return;
    }
    onSave({ name, phone, capacity: capacityNum, workStart, workEnd });
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <label className="ll-field" style={{ display: "block", margin: 0 }}>
          <span className="mut" style={{ fontSize: 13 }}>Truck name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Truck 2 — Mike"
            maxLength={60}
            style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
          />
        </label>

        <label className="ll-field" style={{ display: "block", margin: 0 }}>
          <span className="mut" style={{ fontSize: 13 }}>Crew phone (optional — route text lands here)</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(260) 555-0100"
            style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
          />
        </label>

        <label className="ll-field" style={{ display: "block", margin: 0 }}>
          <span className="mut" style={{ fontSize: 13 }}>Capacity (jobs/day)</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            step="1"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label className="ll-field" style={{ display: "block", margin: 0 }}>
            <span className="mut" style={{ fontSize: 13 }}>Start</span>
            <select
              value={workStart}
              onChange={(e) => setWorkStart(Number(e.target.value))}
              style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
            >
              {HOURS_START.map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
          <label className="ll-field" style={{ display: "block", margin: 0 }}>
            <span className="mut" style={{ fontSize: 13 }}>End</span>
            <select
              value={workEnd}
              onChange={(e) => setWorkEnd(Number(e.target.value))}
              style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
            >
              {HOURS_END.map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button className="ll-btn gold" onClick={submit} disabled={pending} style={{ flex: 1, minHeight: 48 }}>
          {pending ? "Saving…" : saveLabel}
        </button>
        <button className="ll-btn ghost" onClick={onCancel} disabled={pending} style={{ minHeight: 48 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
