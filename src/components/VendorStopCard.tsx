"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { navUrl } from "@/lib/navlink";
import { uploadJobPhoto, completeJob, submitFlag, getJobPhotoUrls } from "@/app/vendor/actions";
import { toast } from "@/components/Toast";
import type { VendorStop } from "@/app/vendor/data";

const FLAG_TYPES: Array<{ value: string; label: string; countField?: string; countLabel?: string }> = [
  { value: "pier", label: "Pier has more/fewer sections than the profile", countField: "pier_sections", countLabel: "Correct number of sections" },
  { value: "lift", label: "Extra boat lift on site", countField: "boat_lifts", countLabel: "Correct number of boat lifts" },
  { value: "toys", label: "Water toys / jet skis not in the profile", countField: "jet_skis", countLabel: "Correct number of jet skis" },
  { value: "lawn", label: "Lawn is larger than the profile" },
  { value: "other", label: "Something else (describe below)" },
];

export function VendorStopCard({ stop, index, truckLabel }: { stop: VendorStop; index: number; truckLabel?: string | null }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState(stop.photo_count);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(stop.status === "complete" || stop.status === "paid");
  const [completing, setCompleting] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);

  const min = stop.min_photos;
  const enough = count >= min;

  function navigate() {
    if (stop.lat == null || stop.lng == null) {
      toast("No map location on file for this stop.");
      return;
    }
    window.open(navUrl(stop.lat, stop.lng, stop.address ?? "Stop"), "_blank");
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let latest = count;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await uploadJobPhoto(stop.id, fd);
      if (!res.ok) {
        toast(res.error ?? "Photo failed to upload.");
        continue;
      }
      latest = res.photoCount ?? latest + 1;
    }
    setCount(latest);
    setThumbs(await getJobPhotoUrls(stop.id));
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (latest < min) toast(`${min - latest} more photo${min - latest === 1 ? "" : "s"} needed to close this job.`);
  }

  async function markComplete() {
    if (completing) return;
    setCompleting(true);
    const res = await completeJob(stop.id);
    if (!res.ok) {
      toast(res.error ?? "Couldn't complete this job.");
      if (res.photoCount != null) setCount(res.photoCount);
      setCompleting(false);
      return;
    }
    setDone(true);
    toast("Job complete — payout released. 🌊");
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ opacity: done ? 0.6 : 1 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div
          style={{
            flexShrink: 0, width: 30, height: 30, borderRadius: 99, background: "var(--teal)",
            color: "#fff", fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {index + 1}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{stop.service_name ?? "Service"}</div>
            {truckLabel && <span className="ll-pill slate" style={{ fontSize: 11 }}>{truckLabel}</span>}
          </div>
          {stop.legs && stop.legs.length > 1 && (
            <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>
              🧊 This visit: {stop.legs.join(" · ")}
            </div>
          )}
          <div className="mut" style={{ fontSize: 13 }}>{stop.address ?? "Address on file"}</div>
          <div className="mut" style={{ fontSize: 12.5 }}>
            {[stop.lake_name, stop.facts, stop.owner_name ? `owner: ${stop.owner_name}` : null].filter(Boolean).join(" · ")}
          </div>

          {/* Gate code — only present for today's jobs (rule 3) */}
          {stop.gate_code && (
            <div style={{ marginTop: 8, padding: "8px 11px", background: "var(--sun-soft)", border: "1px solid #ecd9ad", borderRadius: 10, fontSize: 13, color: "#7a5a1e" }}>
              🔑 Gate / door code: <b style={{ fontFamily: "var(--font-display)", letterSpacing: ".08em" }}>{stop.gate_code}</b>
              <span className="mut" style={{ display: "block", fontSize: 11 }}>Shown only today, for this job.</span>
            </div>
          )}
        </div>
      </div>

      {done ? (
        <div style={{ marginTop: 12 }}>
          <span className="ll-pill ok">Done ✓ · payout released</span>
        </div>
      ) : (
        <>
          {/* photo requirement */}
          <div
            className={enough ? "" : undefined}
            style={{ marginTop: 12, fontSize: 12.5, fontWeight: 700, color: enough ? "var(--ok)" : "var(--warn)" }}
          >
            📷 {count} / {min} photo{min === 1 ? "" : "s"} {enough ? "— ready to complete" : "— required to complete"}
          </div>
          {thumbs.length > 0 && (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {thumbs.map((u, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={u} alt="Job photo" style={{ width: 52, height: 40, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />
              ))}
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            style={{ display: "none" }}
            onChange={(e) => onFiles(e.target.files)}
          />

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <button className="ll-btn ghost sm" onClick={navigate}>Navigate ➤</button>
            <button className="ll-btn ghost sm" onClick={() => setFlagOpen(true)}>Flag item</button>
            <button className="ll-btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Add photos"}
            </button>
            <button className="ll-btn gold sm" onClick={markComplete} disabled={!enough || completing}>
              {completing ? "Completing…" : "Mark complete"}
            </button>
          </div>
        </>
      )}

      {flagOpen && (
        <FlagModal
          address={stop.address ?? "this stop"}
          onClose={() => setFlagOpen(false)}
          onSubmit={async (type, note, proposed) => {
            const res = await submitFlag(stop.id, type, note, proposed);
            if (!res.ok) { toast(res.error ?? "Couldn't send that flag."); return; }
            setFlagOpen(false);
            toast("Sent — the owner sees it in Approvals, and Ops has a copy.");
          }}
        />
      )}
    </div>
  );
}

function FlagModal({
  address,
  onClose,
  onSubmit,
}: {
  address: string;
  onClose: () => void;
  onSubmit: (type: string, note: string, proposed: Record<string, unknown> | null) => Promise<void>;
}) {
  const [type, setType] = useState(FLAG_TYPES[0].value);
  const [note, setNote] = useState("");
  const [countVal, setCountVal] = useState("");
  const [lawn, setLawn] = useState("large");
  const [busy, setBusy] = useState(false);
  const def = FLAG_TYPES.find((f) => f.value === type)!;

  async function send() {
    setBusy(true);
    let proposed: Record<string, unknown> | null = null;
    if (def.countField && countVal.trim()) proposed = { [def.countField]: Number(countVal) };
    if (type === "lawn") proposed = { lawn_band: lawn };
    await onSubmit(type, note, proposed);
    setBusy(false);
  }

  const selectStyle: React.CSSProperties = {
    width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
    borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ll-modal" style={{ maxWidth: 440 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill warn">Flag for owner approval</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{address}</h3>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ll-modal-body">
          <div className="ll-field">
            <label>What did you find?</label>
            <select value={type} onChange={(e) => setType(e.target.value)} style={selectStyle}>
              {FLAG_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          {def.countField && (
            <div className="ll-field">
              <label>{def.countLabel}</label>
              <input inputMode="numeric" value={countVal} onChange={(e) => setCountVal(e.target.value)} placeholder="e.g. 12" />
            </div>
          )}
          {type === "lawn" && (
            <div className="ll-field">
              <label>Correct lawn size</label>
              <select value={lawn} onChange={(e) => setLawn(e.target.value)} style={selectStyle}>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>
          )}
          <div className="ll-field">
            <label>Note to the owner</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Counted 12 sections including the end platform" />
          </div>
          <p className="mut" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 12 }}>
            This goes to the owner as an approval request, with a copy to Ops. Nothing
            reprices until the owner approves.
          </p>
          <button className="ll-btn gold" style={{ width: "100%" }} onClick={send} disabled={busy}>
            {busy ? "Sending…" : "Send to owner & Ops"}
          </button>
        </div>
      </div>
    </div>
  );
}
