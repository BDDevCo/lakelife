"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { addWorker, setWorkerActive, type Worker } from "@/app/vendor/workers-actions";

/**
 * YOUR CREW — the vendor's own list of people, and nothing more than that.
 *
 * WHY IT ASKS AT ALL, said on the screen rather than assumed: LakeLife pays one
 * bank account per company, so a tip lands with the office no matter who earned
 * it. Without names the owner has a lump sum and no way to split it. That is
 * the entire pitch, and a crew who doesn't want to give us names should be able
 * to read the page and decline knowing exactly what they're declining.
 *
 * IT IS OPTIONAL AND IT SAYS SO. A vendor with an empty list keeps everything
 * they have today: tips attributed by truck where we routed one, "Crew not
 * recorded" where we didn't. Nothing is withheld from them for not filling it
 * in, because a roster held under pressure is a roster nobody keeps current.
 */
export function CrewRoster({ workers }: { workers: Worker[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [name, setName] = useState("");

  const active = workers.filter((w) => w.active);
  const inactive = workers.filter((w) => !w.active);

  return (
    <div className="wrap" style={{ paddingTop: 24, maxWidth: 720 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Your crew</h1>
      <p className="mut" style={{ fontSize: 13.5, marginBottom: 16, lineHeight: 1.6 }}>
        Add the people who work with you. On a finished job you can tap who was
        there, and your statement will show which tips belong to whom — we pay
        one account, so the split is yours to make and this is what makes it
        possible. <b>Entirely optional.</b> Leave it empty and nothing changes.
      </p>

      <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
        <div className="ll-field" style={{ maxWidth: 320 }}>
          <label>Add someone</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Fred"
            maxLength={60}
          />
          <button
            className="ll-btn"
            style={{ marginTop: 8, minHeight: 44 }}
            disabled={busy || !name.trim()}
            onClick={() =>
              start(async () => {
                const res = await addWorker(name);
                toast(res.ok ? (res.signal ?? "Added.") : (res.error ?? "Couldn't add that."));
                if (res.ok) { setName(""); router.refresh(); }
              })
            }
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        <p className="mut" style={{ fontSize: 12, margin: "10px 0 0", lineHeight: 1.5 }}>
          A first name is plenty — it&apos;s what your customer sees if we ever
          put a name on a message, and it&apos;s all we need to split a tip.
        </p>
      </div>

      {active.length === 0 && inactive.length === 0 ? (
        <p className="mut" style={{ fontSize: 14 }}>
          Nobody on the list yet. Tips will show against your truck where we
          routed one, and as &ldquo;crew not recorded&rdquo; where we didn&apos;t.
        </p>
      ) : (
        <div className="ll-card" style={{ overflow: "hidden" }}>
          {active.map((w, i) => (
            <Row key={w.id} worker={w} first={i === 0} busy={busy} start={start} router={router} />
          ))}
          {inactive.length > 0 && (
            <div style={{ borderTop: "1px solid var(--line)", padding: "10px 14px 4px" }}>
              <span className="mut" style={{ fontSize: 12, fontWeight: 700 }}>No longer with you</span>
              <p className="mut" style={{ fontSize: 11.5, margin: "2px 0 0", lineHeight: 1.45 }}>
                Kept, not deleted — last season&apos;s statement still needs to say
                who did the work.
              </p>
            </div>
          )}
          {inactive.map((w) => (
            <Row key={w.id} worker={w} first={false} busy={busy} start={start} router={router} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  worker, first, busy, start, router,
}: {
  worker: Worker;
  first: boolean;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
        borderTop: first ? "none" : "1px solid var(--line)",
        opacity: worker.active ? 1 : 0.6,
      }}
    >
      <span style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>{worker.name}</span>
      <button
        className="ll-btn ghost sm"
        style={{ minHeight: 40 }}
        disabled={busy}
        onClick={() =>
          start(async () => {
            const res = await setWorkerActive(worker.id, !worker.active);
            toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't do that."));
            if (res.ok) router.refresh();
          })
        }
      >
        {worker.active ? "Remove" : "Add back"}
      </button>
    </div>
  );
}
