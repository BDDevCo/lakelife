"use client";

/**
 * The crew's onboarding checklist — shown whenever a vendor isn't 'active' yet.
 * Three dead-simple steps (insurance, W-9, what work you do); when all three are
 * done we tell them LakeLife is reviewing. Big tap targets for wet gloves.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToggleChips } from "@/components/wizard-controls";
import { toast } from "@/components/Toast";
import { uploadVendorDoc, setServiceTypes } from "@/app/vendor/onboarding-actions";
import type { MyVendor } from "@/app/vendor/data";

function prettyDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function VendorOnboarding({
  vendor,
  activeServices,
}: {
  vendor: MyVendor;
  activeServices: string[];
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
  const allDone = coiDone && w9Done && servicesDone;

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>
        {vendor.company ? `Welcome, ${vendor.company}` : "Welcome to LakeLife"}
      </h1>
      <p className="mut" style={{ fontSize: 14, marginBottom: 18 }}>
        Three quick things and you&apos;re ready for jobs. Do them in any order.
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
      </div>

      <div style={{ marginTop: 18 }}>
        {allDone ? (
          <div
            className="ll-card ll-card-pad"
            style={{ textAlign: "center", borderColor: "var(--teal)" }}
          >
            <span className="ll-pill ok">All set</span>
            <p style={{ fontSize: 16, fontWeight: 700, margin: "10px 0 4px" }}>
              You&apos;re all set — LakeLife is reviewing.
            </p>
            <p className="mut" style={{ fontSize: 14 }}>
              You&apos;ll get a text when jobs start routing to you. 🌊
            </p>
          </div>
        ) : (
          <div className="ll-card ll-card-pad" style={{ background: "var(--warn-bg, transparent)" }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--warn)", margin: 0 }}>
              No insurance on file, no jobs — it&apos;s how we keep every dock covered.
            </p>
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
