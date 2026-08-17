"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { saveParkProfile } from "@/app/park/actions";
import type { ParkProfileInput } from "@/app/park/park-helpers";

/**
 * The setup interview. Every park runs differently, so each answer becomes a
 * DIAL in the database (rule 8) — not an assumption baked into our code.
 *
 * The 55+ question is not a filter. It gates whether the application may ask
 * for age AT ALL: in an all-ages park there is no legitimate purpose for a
 * date of birth, and collecting one leaves a familial-status exposure sitting
 * in the record forever. The copy says so, because the person answering is
 * making a legal declaration about their own property and should know it.
 */

const UTILITIES = [
  { value: "water", label: "Water" },
  { value: "sewer", label: "Sewer" },
  { value: "electric", label: "Electric" },
  { value: "trash", label: "Trash" },
  { value: "wifi", label: "Wi-Fi" },
  { value: "lawn", label: "Lawn care" },
  { value: "snow", label: "Snow removal" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ParkSetup({ parkId, initial }: { parkId: string; initial: ParkProfileInput }) {
  const router = useRouter();
  const [form, setForm] = useState<ParkProfileInput>(initial);
  const [seasonal, setSeasonal] = useState(!!initial.seasonOpen);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof ParkProfileInput>(k: K, v: ParkProfileInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function toggleUtility(u: string) {
    setForm((f) => ({
      ...f,
      includedUtilities: f.includedUtilities.includes(u)
        ? f.includedUtilities.filter((x) => x !== u)
        : [...f.includedUtilities, u],
    }));
  }

  function save() {
    // Turning "seasonal" off means year-round — send blanks so the engine
    // reads it that way, rather than leaving stale dates behind.
    const payload: ParkProfileInput = seasonal
      ? form
      : { ...form, seasonOpen: "", seasonClose: "" };
    startTransition(async () => {
      const res = await saveParkProfile(parkId, payload);
      if (!res.ok) { toast(res.error ?? "Couldn't save."); return; }
      toast(res.signal ?? "Saved.");
      router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48, maxWidth: 680 }}>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>How your park runs</h2>
      <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
        These answers set up the rest of the system. You can change any of them later.
      </p>

      <Section title="The basics">
        <label className="ll-field" style={{ fontSize: 13, display: "block", marginBottom: 12 }}>
          <span className="mut">Park name</span>
          <input value={form.name}
            onChange={(e) => set("name", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, display: "block", marginBottom: 12 }}>
          <span className="mut">Address</span>
          <input value={form.address}
            onChange={(e) => set("address", e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <div style={{ fontSize: 13 }}>
          <span className="mut">What kind of park is it?</span>
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            {[
              { v: "mh", l: "Mobile homes" },
              { v: "rv", l: "RVs" },
              { v: "mixed", l: "Both" },
            ].map((o) => (
              <Chip key={o.v} label={o.l} on={form.parkType === o.v} onClick={() => set("parkType", o.v)} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Who can live here">
        <Toggle
          label="This is 55+ housing"
          checked={form.ageRestricted}
          onChange={(v) => set("ageRestricted", v)}
        />
        <p className="mut" style={{ fontSize: 13, marginTop: 8 }}>
          Only turn this on if your park is legally 55+ housing. It decides whether we
          ask applicants their age at all — in an all-ages park we never will, because
          there&apos;s no good reason to have it on file. Claiming the 55+ exemption also
          means keeping occupancy records and running the periodic survey; we&apos;ll hold
          the records for you, but the claim is yours and your attorney&apos;s, not ours.
        </p>

        <div style={{ marginTop: 16 }}>
          <Toggle
            label="I approve each applicant before they move in"
            checked={form.approvalRequired}
            onChange={(v) => set("approvalRequired", v)}
          />
          <p className="mut" style={{ fontSize: 13, marginTop: 8 }}>
            Applications land on your rent roll and wait for you. Nothing is held until
            you say yes.{" "}
            <strong>We don&apos;t screen anyone or recommend a decision</strong> — the call
            is always yours.
          </p>
        </div>
      </Section>

      <Section title="When you're open">
        <Toggle
          label="We close for part of the year"
          checked={seasonal}
          onChange={setSeasonal}
        />
        {seasonal && (
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            <MonthDay label="Opens" value={form.seasonOpen} onChange={(v) => set("seasonOpen", v)} />
            <MonthDay label="Closes" value={form.seasonClose} onChange={(v) => set("seasonClose", v)} />
          </div>
        )}
        {!seasonal && (
          <p className="mut" style={{ fontSize: 13, marginTop: 8 }}>Open year-round.</p>
        )}
      </Section>

      <Section title="What's included in the rent">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {UTILITIES.map((u) => (
            <Chip
              key={u.value}
              label={u.label}
              on={form.includedUtilities.includes(u.value)}
              onClick={() => toggleUtility(u.value)}
            />
          ))}
        </div>
      </Section>

      <Section title="House rules">
        <textarea
          rows={6} value={form.houseRules}
          onChange={(e) => set("houseRules", e.target.value)}
          placeholder="Quiet hours, pets, guest parking, anything you tell people when they move in."
        />
        <p className="mut" style={{ fontSize: 13, marginTop: 8 }}>
          Shown to renters on your park page and when they apply. We display these —
          we don&apos;t enforce them.
        </p>
      </Section>

      <button className="ll-btn" onClick={save} disabled={pending} style={{ marginTop: 4 }}>
        Save park setup
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>{title}</h3>
      {children}
    </div>
  );
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 14px", borderRadius: 999, fontSize: 14, fontWeight: 600, cursor: "pointer",
        border: `2px solid ${on ? "var(--teal)" : "var(--line)"}`,
        background: on ? "var(--teal-wash)" : "transparent",
        color: on ? "var(--teal-dark)" : "var(--sub)",
      }}
    >
      {label}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** A (month, day) pair — a season boundary is not a date in any one year, so
 *  there is deliberately no year here. */
function MonthDay({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [m, d] = value ? value.split("-") : ["", ""];
  const emit = (month: string, day: string) =>
    onChange(month && day ? `${month.padStart(2, "0")}-${day.padStart(2, "0")}` : "");

  return (
    <div style={{ fontSize: 13 }}>
      <span className="mut">{label}</span>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <select value={m ? String(Number(m)) : ""} onChange={(e) => emit(e.target.value, d)}>
          <option value="">Month</option>
          {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
        </select>
        <select value={d ? String(Number(d)) : ""} onChange={(e) => emit(m, e.target.value)}>
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>
  );
}
