"use client";

/**
 * The interactive half of the crew's job page: navigate, photos, mark
 * complete, flag for owner approval, and the in-portal Make-It-Right choices.
 *
 * Everything money-shaped and everything secret is decided on the server —
 * this file receives a job ID, a photo count, and plain words. It never sees a
 * customer price (rule 1), a gate code cipher (rule 3), or a dispute token.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { navUrl } from "@/lib/navlink";
import { toast } from "@/components/Toast";
import { uploadJobPhoto, completeJob, submitFlag } from "@/app/vendor/actions";
import { crewCureJob } from "@/app/vendor/job-detail-actions";
import { FlagModal } from "@/components/VendorStopCard";
import { photoGateLabel } from "@/lib/job-view";

/**
 * Turn-by-turn to this one stop — the same device-aware link the Today card
 * uses (Apple Maps on an iPhone, Google Maps everywhere else).
 */
export function CrewNavigateButton({
  lat,
  lng,
  address,
}: {
  lat: number | null;
  lng: number | null;
  address: string | null;
}) {
  function go() {
    if (lat == null || lng == null) {
      toast("No map location on file for this stop.");
      return;
    }
    window.open(navUrl(lat, lng, address ?? "Stop"), "_blank");
  }

  return <button className="ll-btn ghost sm" onClick={go}>Navigate ➤</button>;
}

/**
 * Photos + complete + flag. RULE 2 is enforced on the SERVER (completeJob
 * refuses below the minimum), so the button stays live and the refusal is
 * shown honestly — a greyed-out button teaches a crew nothing.
 */
export function CrewJobActions({
  jobId,
  address,
  photoCount,
  minPhotos,
  status,
  isCorrection,
}: {
  jobId: string;
  address: string | null;
  photoCount: number;
  minPhotos: number;
  status: string;
  isCorrection: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState(photoCount);
  const [uploading, setUploading] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [done, setDone] = useState(status === "complete" || status === "paid");
  const [flagOpen, setFlagOpen] = useState(false);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let latest = count;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await uploadJobPhoto(jobId, fd);
      if (!res.ok) {
        toast(res.error ?? "Photo failed to upload.");
        continue;
      }
      latest = res.photoCount ?? latest + 1;
    }
    setCount(latest);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    router.refresh(); // the gallery above is server-rendered from signed URLs
    if (latest < minPhotos) {
      const need = minPhotos - latest;
      toast(`${need} more photo${need === 1 ? "" : "s"} needed to close this job.`);
    }
  }

  async function markComplete() {
    if (completing) return;
    setCompleting(true);
    const res = await completeJob(jobId);
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

  const enough = minPhotos <= 0 || count >= minPhotos;

  return (
    <div className="ll-card ll-card-pad">
      <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Proof of work</h3>
      <p style={{ fontSize: 13, fontWeight: 700, color: enough ? "var(--ok)" : "var(--warn)", margin: "0 0 2px" }}>
        📷 {photoGateLabel(count, minPhotos)}
      </p>
      <p className="mut" style={{ fontSize: 12, margin: "0 0 12px" }}>
        {isCorrection
          ? "This is the free make-it-right visit — photos are still required before it can be closed."
          : "No photos, no completion, no payout. The photos are what settle a question months later."}
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        style={{ display: "none" }}
        onChange={(e) => onFiles(e.target.files)}
      />

      {done ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="ll-pill ok">Done ✓</span>
          <button className="ll-btn ghost sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Add more photos"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="ll-btn sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Uploading…" : "Add photos"}
          </button>
          <button className="ll-btn ghost sm" onClick={() => setFlagOpen(true)}>
            Flag something
          </button>
          <button className="ll-btn gold sm" onClick={markComplete} disabled={completing}>
            {completing ? "Completing…" : "Mark complete"}
          </button>
        </div>
      )}

      {!done && (
        <p className="mut" style={{ fontSize: 11.5, margin: "10px 0 0", lineHeight: 1.5 }}>
          Flagging a profile correction changes nothing and bills nothing until the homeowner
          approves it.
        </p>
      )}

      {flagOpen && (
        <FlagModal
          address={address ?? "this stop"}
          onClose={() => setFlagOpen(false)}
          onSubmit={async (type, note, proposed) => {
            const res = await submitFlag(jobId, type, note, proposed);
            if (!res.ok) {
              toast(res.error ?? "Couldn't send that flag.");
              return;
            }
            setFlagOpen(false);
            toast("Sent — the owner sees it in Approvals, and Ops has a copy.");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function nextSevenDays(today: string): { iso: string; label: string }[] {
  const start = new Date(`${today}T12:00:00`);
  const out: { iso: string; label: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ iso, label: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) });
  }
  return out;
}

/**
 * The three cures, in the portal instead of only in a text message. The
 * dispute is found server-side from the job id — this component never holds a
 * token, and never learns what the customer paid or was refunded.
 */
export function CrewMakeItRight({
  jobId,
  today,
  canFix,
  canVerify,
  canTalk,
}: {
  jobId: string;
  today: string;
  canFix: boolean;
  canVerify: boolean;
  canTalk: boolean;
}) {
  const router = useRouter();
  const days = nextSevenDays(today);
  const [date, setDate] = useState(days[0]?.iso ?? today);
  const [busy, setBusy] = useState<null | "fix" | "verify" | "talk">(null);

  if (!canFix && !canVerify && !canTalk) return null;

  async function choose(choice: "fix" | "verify" | "talk") {
    if (busy) return;
    setBusy(choice);
    const res = await crewCureJob(jobId, choice, choice === "fix" ? date : undefined);
    setBusy(null);
    if (!res.ok) {
      toast(res.error ?? "That didn't take — give it another tap in a minute.");
      router.refresh();
      return;
    }
    toast(
      choice === "fix"
        ? "Booked — the customer knows you're coming back, no charge. 🌊"
        : choice === "verify"
          ? "Sent — the customer is looking at your photos now."
          : "Opened — we've passed your message to the customer. They'll come back to you.",
    );
    router.refresh();
  }

  const selectStyle: React.CSSProperties = {
    width: "100%", padding: "11px 13px", border: "1.5px solid var(--line)",
    borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <h4 style={{ fontSize: 14, margin: "0 0 8px" }}>How do you want to handle it?</h4>

      {canFix && (
        <div style={{ marginBottom: 12 }}>
          <label className="mut" style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 6 }}>
            Come back and put it right — free, and photos are still required
          </label>
          <select value={date} onChange={(e) => setDate(e.target.value)} style={selectStyle} aria-label="Return visit day">
            {days.map((d) => (
              <option key={d.iso} value={d.iso}>{d.label}</option>
            ))}
          </select>
          <button
            className="ll-btn gold sm"
            style={{ marginTop: 8 }}
            onClick={() => choose("fix")}
            disabled={busy != null}
          >
            {busy === "fix" ? "Booking…" : "Book the free return visit"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {canVerify && (
          <button className="ll-btn ghost sm" onClick={() => choose("verify")} disabled={busy != null}>
            {busy === "verify" ? "Sending…" : "It was done right — send my photos"}
          </button>
        )}
        {canTalk && (
          <button className="ll-btn ghost sm" onClick={() => choose("talk")} disabled={busy != null}>
            {busy === "talk" ? "Opening…" : "Talk it through"}
          </button>
        )}
      </div>

      <p className="mut" style={{ fontSize: 11.5, margin: "10px 0 0", lineHeight: 1.5 }}>
        Whichever you pick, it goes to the customer right away. Doing nothing is the one choice
        that costs you — the window closes on its own.
      </p>
    </div>
  );
}
