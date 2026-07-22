"use client";

/**
 * The crew's onboarding checklist — shown whenever a vendor isn't 'active' yet.
 * Simple, tap-first steps (insurance, W-9, work, lakes, daily capacity, and an
 * optional home base). There is NO human approval gate anymore: the moment the
 * required steps clear, the crew flips THEMSELVES live with one button. Big tap
 * targets for wet gloves.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Stepper, ToggleChips } from "@/components/wizard-controls";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { toast } from "@/components/Toast";
import {
  uploadVendorDoc,
  setServiceTypes,
  setDailyCapacity,
  setServiceLakes,
  setBaseLocation,
  finishOnboarding,
} from "@/app/vendor/onboarding-actions";
import { activationGaps } from "@/app/vendor/onboarding-helpers";
import type { MyVendor } from "@/app/vendor/data";

function prettyDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Today (YYYY-MM-DD) in lake time — the yardstick for COI expiry. */
function lakeToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }).format(new Date());
}

/** Shared step number/checkmark badge, matching the existing step cards. */
function StepBadge({ num, done }: { num: number; done: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
        display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
        background: done ? "var(--teal)" : "var(--line)",
        color: done ? "#fff" : "var(--sub)",
      }}
    >
      {done ? "✓" : num}
    </span>
  );
}

export function VendorOnboarding({
  vendor,
  activeServices,
  lakes = [],
}: {
  vendor: MyVendor;
  activeServices: string[];
  lakes?: { id: string; name: string }[];
}) {
  const router = useRouter();

  // Paused accounts get one message and nothing to do.
  if (vendor.status === "suspended") {
    return (
      <div className="wrap" style={{ paddingTop: 24, maxWidth: 480 }}>
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <span className="ll-pill slate">Paused</span>
          <h2 style={{ fontSize: 22, margin: "12px 0 6px" }}>Your crew account is paused</h2>
          <p className="mut" style={{ fontSize: 15 }}>
            Call LakeLife dispatch and we&apos;ll get you sorted. No jobs will route while
            your account is paused.
          </p>
        </div>
      </div>
    );
  }

  const coiDone = !!vendor.coi_url;
  const w9Done = !!vendor.w9_url;
  const servicesDone = vendor.service_types.length > 0;
  const lakesDone = vendor.service_lakes.length > 0;
  const capacityDone = vendor.daily_capacity >= 1;
  const baseDone = vendor.base_lat != null;

  const today = lakeToday();
  const gaps = activationGaps(
    {
      coi_url: vendor.coi_url,
      coi_expiry: vendor.coi_expiry,
      w9_url: vendor.w9_url,
      service_types: vendor.service_types,
      service_lakes: vendor.service_lakes,
      daily_capacity: vendor.daily_capacity,
    },
    today,
  );
  const readyToGoLive = gaps.length === 0;
  const coiFlagged = gaps.some((g) => /insurance|COI/i.test(g));

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>
        {vendor.company ? `Welcome, ${vendor.company}` : "Welcome to LakeLife"}
      </h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
        A few quick things and you can flip yourself live. Do them in any order.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <DocStep
          num={1}
          title="Insurance (COI)"
          kind="coi"
          done={coiDone}
          doneNote={vendor.coi_expiry ? `Expires ${prettyDate(vendor.coi_expiry)}` : undefined}
          onDone={() => router.refresh()}
        />
        <DocStep
          num={2}
          title="W-9"
          kind="w9"
          done={w9Done}
          onDone={() => router.refresh()}
        />
        <ServiceStep
          num={3}
          done={servicesDone}
          activeServices={activeServices}
          selected={vendor.service_types}
          onDone={() => router.refresh()}
        />
        <LakeStep
          num={4}
          done={lakesDone}
          lakes={lakes}
          selectedIds={vendor.service_lakes}
          onDone={() => router.refresh()}
        />
        <CapacityStep
          num={5}
          done={capacityDone}
          initial={vendor.daily_capacity}
          onDone={() => router.refresh()}
        />
        <BaseStep
          num={6}
          done={baseDone}
          onDone={() => router.refresh()}
        />
      </div>

      <div style={{ marginTop: 18 }}>
        {readyToGoLive ? (
          <GoLiveCard onDone={() => router.refresh()} />
        ) : (
          <div className="ll-card ll-card-pad">
            <span className="ll-pill warn">Almost there</span>
            <p style={{ fontSize: 16, fontWeight: 700, margin: "10px 0 2px" }}>
              A few things left before you can go live
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 8 }}>
              {gaps.map((g) => (
                <li key={g} style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 14 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 20, height: 20, borderRadius: 999, flex: "0 0 auto", marginTop: 1,
                      border: "1.5px solid var(--line)", background: "#fff",
                    }}
                  />
                  <span>{g}</span>
                </li>
              ))}
            </ul>
            {coiFlagged && (
              <p style={{ fontSize: 13, fontWeight: 700, color: "var(--warn)", margin: "12px 0 0" }}>
                No insurance on file, no jobs — it&apos;s how we keep every dock covered.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DocStep({
  num,
  title,
  kind,
  done,
  doneNote,
  onDone,
}: {
  num: number;
  title: string;
  kind: "coi" | "w9";
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
    if (kind === "coi" && !expiry) {
      toast("Add the COI's expiry date.");
      return;
    }
    const form = new FormData();
    form.set("file", file);
    if (kind === "coi") form.set("expiry", expiry);
    startTransition(async () => {
      const res = await uploadVendorDoc(kind, form);
      if (!res.ok) {
        toast(res.error ?? "Upload failed.");
        return;
      }
      toast(`${title} saved.`);
      if (fileRef.current) fileRef.current.value = "";
      setExpiry("");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          aria-hidden
          style={{
            width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
            display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
            background: done ? "var(--teal)" : "var(--line)",
            color: done ? "#fff" : "var(--sub)",
          }}
        >
          {done ? "✓" : num}
        </span>
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>{title}</h3>
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

      {kind === "coi" && (
        <label className="ll-field" style={{ display: "block", marginTop: 10 }}>
          <span className="mut" style={{ fontSize: 13 }}>Expiry date</span>
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
          />
        </label>
      )}

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

function ServiceStep({
  num,
  done,
  activeServices,
  selected,
  onDone,
}: {
  num: number;
  done: boolean;
  activeServices: string[];
  selected: string[];
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [pending, startTransition] = useTransition();

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      toast("Tap at least one kind of work.");
      return;
    }
    startTransition(async () => {
      const res = await setServiceTypes(picked);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Work types saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          aria-hidden
          style={{
            width: 26, height: 26, borderRadius: 999, flex: "0 0 auto",
            display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800,
            background: done ? "var(--teal)" : "var(--line)",
            color: done ? "#fff" : "var(--sub)",
          }}
        >
          {done ? "✓" : num}
        </span>
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>What work do you do?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
        Tap everything your crew handles.
      </p>

      {activeServices.length === 0 ? (
        <p className="mut" style={{ fontSize: 14 }}>No services set up yet — call dispatch.</p>
      ) : (
        <ToggleChips options={activeServices} selected={picked} onToggle={toggle} />
      )}

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function LakeStep({
  num,
  done,
  lakes,
  selectedIds,
  onDone,
}: {
  num: number;
  done: boolean;
  lakes: { id: string; name: string }[];
  selectedIds: string[];
  onDone: () => void;
}) {
  const nameById = new Map(lakes.map((l) => [l.id, l.name]));
  const idByName = new Map(lakes.map((l) => [l.name, l.id]));
  const initialNames = selectedIds
    .map((id) => nameById.get(id))
    .filter((n): n is string => !!n);

  const [picked, setPicked] = useState<string[]>(initialNames);
  const [pending, startTransition] = useTransition();

  function toggle(name: string) {
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function save() {
    if (picked.length === 0) {
      toast("Tap at least one lake you service.");
      return;
    }
    const ids = picked
      .map((n) => idByName.get(n))
      .filter((id): id is string => !!id);
    startTransition(async () => {
      const res = await setServiceLakes(ids);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Lakes saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>Which lakes do you service?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
        Tap every lake your crew works.
      </p>

      {lakes.length === 0 ? (
        <p className="mut" style={{ fontSize: 14 }}>No lakes set up yet — call dispatch.</p>
      ) : (
        <ToggleChips options={lakes.map((l) => l.name)} selected={picked} onToggle={toggle} />
      )}

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 12, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function CapacityStep({
  num,
  done,
  initial,
  onDone,
}: {
  num: number;
  done: boolean;
  initial: number;
  onDone: () => void;
}) {
  const [n, setN] = useState<number>(initial >= 1 ? initial : 1);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setDailyCapacity(n);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save.");
        return;
      }
      toast("Daily capacity saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>How many jobs a day?</h3>
        {done && <span className="ll-pill ok">Saved ✓</span>}
      </div>

      <Stepper
        label="Jobs per day"
        value={n}
        onChange={setN}
        min={1}
        max={20}
        hint="The most stops we'll route to your crew in one day."
      />

      <button
        className="ll-btn gold"
        onClick={save}
        disabled={pending}
        style={{ marginTop: 4, width: "100%", minHeight: 48 }}
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function BaseStep({
  num,
  done,
  onDone,
}: {
  num: number;
  done: boolean;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSelect(sel: { address: string; lat: number | null; lng: number | null; placeId: string | null }) {
    const { lat, lng } = sel;
    if (lat == null || lng == null) return;
    startTransition(async () => {
      const res = await setBaseLocation(lat, lng);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save your home base.");
        return;
      }
      toast("Home base saved.");
      onDone();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StepBadge num={num} done={done} />
        <h3 style={{ fontSize: 18, margin: 0, flex: 1 }}>Where&apos;s home base?</h3>
        {done ? (
          <span className="ll-pill ok">Saved ✓</span>
        ) : (
          <span className="ll-pill slate">Optional</span>
        )}
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "0 0 10px" }}>
        Optional — sharpens which nearby jobs reach you. You can add it later. {pending ? "Saving…" : "🌊"}
      </p>

      <AddressAutocomplete value={value} onChange={setValue} onSelect={handleSelect} />
    </div>
  );
}

function GoLiveCard({ onDone }: { onDone: () => void }) {
  const [pending, startTransition] = useTransition();

  function go() {
    startTransition(async () => {
      const res = await finishOnboarding();
      if (!res.ok) {
        toast(res.error ?? "Couldn't go live — try again.");
        return;
      }
      onDone();
    });
  }

  return (
    <div
      className="ll-card ll-card-pad"
      style={{ textAlign: "center", borderColor: "var(--teal)" }}
    >
      <span className="ll-pill ok">Ready</span>
      <p style={{ fontSize: 18, fontWeight: 800, margin: "10px 0 4px" }}>
        You&apos;re ready to go live 🌊
      </p>
      <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>
        Flip yourself on and jobs start routing to your crew — no waiting on us.
      </p>
      <button
        className="ll-btn gold"
        onClick={go}
        disabled={pending}
        style={{ width: "100%", minHeight: 48 }}
      >
        {pending ? "Going live…" : "Go live — start getting jobs"}
      </button>
    </div>
  );
}
