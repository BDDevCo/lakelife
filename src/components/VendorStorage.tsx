"use client";

/**
 * "Winter storage" — an active crew's opt-in storage capability. Two things
 * live here: how much boat (in feet) they can hold and what kind of space it
 * is, plus the garagekeepers/bailee insurance gate (a standard COI excludes
 * property in the vendor's custody, so storage jobs need this second policy
 * on file — storage-schema design, owner-approved 2026-07-22). This is NOT
 * part of onboarding: storage is an active-crew opt-in, so it lives on the
 * availability page instead of the onboarding checklist.
 *
 * CLAUDE.md rule 1: this card shows only the crew's own capacity/types/doc
 * status — no customer price, no margin, anywhere.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { setStorageSettings } from "@/app/vendor/availability/actions";
import { uploadVendorDoc } from "@/app/vendor/onboarding-actions";

/** Today (YYYY-MM-DD) in lake time — same yardstick as the COI expiry check. */
function lakeToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date());
}

function prettyDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function VendorStorage({
  capacityFeet,
  storageTypes,
  garagekeepersUrl,
  garagekeepersExpiry,
}: {
  capacityFeet: number;
  storageTypes: string[];
  garagekeepersUrl: string | null;
  garagekeepersExpiry: string | null;
}) {
  const router = useRouter();
  const [feet, setFeet] = useState<string>(String(capacityFeet));
  const [types, setTypes] = useState<string[]>(storageTypes);
  const [pending, startTransition] = useTransition();

  function toggleType(t: string) {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function save() {
    const n = Math.floor(Number(feet));
    if (!Number.isFinite(n) || n < 0) {
      toast("Enter a whole number of feet, 0 or more.");
      return;
    }
    startTransition(async () => {
      const res = await setStorageSettings({ capacityFeet: n, types });
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Storage settings saved. 🌊");
      router.refresh();
    });
  }

  const today = lakeToday();
  let pillClass: string;
  let pillText: string;
  if (!garagekeepersExpiry) {
    pillClass = "warn";
    pillText = "Bailee/garagekeepers insurance required before storage jobs unlock";
  } else if (garagekeepersExpiry <= today) {
    pillClass = "warn";
    pillText = `Garagekeepers insurance expired ${prettyDate(garagekeepersExpiry)}`;
  } else {
    pillClass = "teal";
    pillText = `Garagekeepers on file through ${prettyDate(garagekeepersExpiry)}`;
  }

  return (
    <div className="ll-card ll-card-pad">
      <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Winter storage</h2>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Set your capacity and keep your garagekeepers policy current — both have to be
        on file before storage & winterization jobs route to you.
      </p>

      <span className={`ll-pill ${pillClass}`}>{pillText}</span>

      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        <label className="ll-field" style={{ display: "block" }}>
          <span className="mut" style={{ fontSize: 13 }}>Storage capacity (feet)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step="1"
            value={feet}
            onChange={(e) => setFeet(e.target.value)}
            placeholder="0"
            style={{ display: "block", marginTop: 6, fontSize: 16, minHeight: 48, width: "100%" }}
          />
        </label>
        <p className="mut" style={{ fontSize: 12, margin: 0 }}>0 = no storage right now.</p>

        <div>
          <span className="mut" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
            Storage types
          </span>
          <div style={{ display: "flex", gap: 18 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={types.includes("outdoor")}
                onChange={() => toggleType("outdoor")}
                style={{ width: 18, height: 18 }}
              />
              Outdoor lot
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={types.includes("indoor")}
                onChange={() => toggleType("indoor")}
                style={{ width: 18, height: 18 }}
              />
              Indoor building
            </label>
          </div>
        </div>
      </div>

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 14, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save storage settings"}
      </button>

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
        <GaragekeepersUpload
          done={!!garagekeepersUrl}
          doneNote={garagekeepersExpiry ? `Expires ${prettyDate(garagekeepersExpiry)}` : undefined}
          onDone={() => router.refresh()}
        />
      </div>
    </div>
  );
}

function GaragekeepersUpload({
  done,
  doneNote,
  onDone,
}: {
  done: boolean;
  doneNote?: string;
  onDone: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expiry, setExpiry] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast("Pick a file first.");
      return;
    }
    if (!expiry) {
      toast("Add the policy's expiry date.");
      return;
    }
    const form = new FormData();
    form.set("file", file);
    form.set("expiry", expiry);
    startTransition(async () => {
      const res = await uploadVendorDoc("garagekeepers", form);
      if (!res.ok) {
        toast(res.error ?? "Upload failed.");
        return;
      }
      toast("Garagekeepers insurance saved.");
      if (fileRef.current) fileRef.current.value = "";
      setExpiry("");
      onDone();
    });
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0, flex: 1 }}>Garagekeepers / bailee insurance</h3>
        {done && <span className="ll-pill ok">On file ✓</span>}
      </div>

      {done && doneNote && (
        <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>{doneNote}</p>
      )}

      <label className="ll-field" style={{ display: "block" }}>
        <span className="mut" style={{ fontSize: 13 }}>
          {done ? "Replace file (PDF or photo)" : "Upload file (PDF or photo)"}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
        />
      </label>

      <label className="ll-field" style={{ display: "block", marginTop: 10 }}>
        <span className="mut" style={{ fontSize: 13 }}>Expiry date</span>
        <input
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
        />
      </label>

      <button
        className="ll-btn gold"
        onClick={submit}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Uploading…" : done ? "Replace file" : "Upload"}
      </button>
    </div>
  );
}
