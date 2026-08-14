"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { snoozeTask, dismissTask, addNote, doneNote, type TodayView } from "@/app/park/today-actions";
import { addDays, type Task } from "@/app/park/today-helpers";

/**
 * THE MORNING SCREEN.
 *
 * Tasks come FIRST on a phone, above the money. The money is a status he reads;
 * the tasks are the reason he opened it. On a wide screen they sit side by side
 * with tasks on the left, but the DOM order stays tasks-first so the phone gets
 * the right thing for free.
 *
 * Nothing here writes to the ledger. Every card links somewhere that does.
 */

const URGENCY_PILL: Record<string, string> = {
  overdue: "warn", soon: "warn", whenever: "slate",
};

export function ParkToday({ parkId, view }: { parkId: string; view: TodayView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [noteText, setNoteText] = useState("");
  const [adding, setAdding] = useState(false);

  const dow = new Date(`${view.today}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });

  function act(fn: () => Promise<{ ok: boolean; signal?: string; error?: string }>) {
    start(async () => {
      const res = await fn();
      toast(res.ok ? (res.signal ?? "Done.") : (res.error ?? "Couldn't do that."));
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <div className="mut" style={{ fontSize: 13 }}>{dow} · {view.parkName}</div>

      {/* THE DEAD-MAN LINE. A dead cron and a quiet night look identical, so
          when the check has stopped running that fact outranks everything
          below it — including the reassuring emptiness below it. */}
      {view.liveness.alarm && (
        <div className="ll-card ll-card-pad"
          style={{ marginTop: 10, background: "rgba(200,60,40,.07)" }}>
          <strong style={{ fontSize: 15 }}>{view.liveness.alarm}</strong>
        </div>
      )}

      {/* ---- WHAT THE EVENING CHECK FOUND --------------------------------
          The reconciler computed these every night and threw them away — the
          count went into a column nothing read, and the sentences went
          nowhere. So "3 occupied lots have no bill this month" was detected
          nightly, for as long as it stayed true, and told to no one. */}
      {view.findings.length > 0 && (
        <div className="ll-card ll-card-pad"
          style={{ marginTop: 10, background: "rgba(200,150,40,.07)" }}>
          <strong style={{ fontSize: 15 }}>
            Last night&apos;s check turned {view.findings.length === 1 ? "something" : "some things"} up
          </strong>
          <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
            {view.findings.map((f, i) => (
              <p key={`${f.kind}:${i}`} style={{
                fontSize: 13.5, margin: 0, lineHeight: 1.5,
                fontWeight: f.urgent ? 700 : 400,
              }}>
                {f.urgent ? "⚠️ " : ""}{f.line}
              </p>
            ))}
          </div>
          <p className="mut" style={{ fontSize: 12, marginTop: 9, marginBottom: 0, lineHeight: 1.5 }}>
            Nothing was changed. These are things the check noticed and can&apos;t
            decide for you.
          </p>
        </div>
      )}

      {/* ---- before it's his, there is no money and no occupancy ---------- */}
      {view.preCutover ? (
        <div className="ll-card ll-card-pad" style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 19 }}>{view.preCutover.headline}</strong>
          <p className="mut" style={{ fontSize: 14, marginTop: 6, marginBottom: 12, lineHeight: 1.5 }}>
            {view.preCutover.sub}
          </p>
          <div style={{ display: "grid", gap: 6 }}>
            {view.preCutover.items.map((i) => (
              <div key={i.label} style={{ display: "flex", gap: 10, fontSize: 14 }}>
                <span style={{ width: 18 }}>{i.done ? "✓" : "☐"}</span>
                <span className="mut" style={{ flex: 1 }}>{i.label}</span>
                <strong>{i.value}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="ll-card ll-card-pad" style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 19 }}>{view.money.headline}</strong>
          {view.money.todayLine && (
            <div style={{ fontSize: 14, marginTop: 4 }}>{view.money.todayLine}</div>
          )}
          <div className="mut" style={{ fontSize: 14, marginTop: 10, lineHeight: 1.5 }}>
            {view.money.ledgerLine}
          </div>
          {view.money.arrearsLine && (
            <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
              <strong>{view.money.arrearsLine}</strong>
            </div>
          )}
          {/* Not bold, and not beside the arrears total. A disputed bill used
              to be INSIDE that figure, which made "go and chase this" include
              money a household says they already handed over. */}
          {view.money.disputedLine && (
            <div className="mut" style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.5 }}>
              {view.money.disputedLine}
            </div>
          )}
          <div className="mut" style={{ fontSize: 14, marginTop: 12, lineHeight: 1.5 }}>
            {view.occupancy.main}
            {view.occupancy.sub ? ` ${view.occupancy.sub}` : ""}
          </div>
        </div>
      )}

      {/* ---- needs you --------------------------------------------------- */}
      <section style={{ marginTop: 18 }}>
        {view.tasks.length > 0 && (
          <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Needs you</h2>
        )}
        <div style={{ display: "grid", gap: 10 }}>
          {view.tasks.map((t) => (
            <TaskCard key={t.key} parkId={parkId} task={t} today={view.today}
              busy={busy} onAct={act} />
          ))}
        </div>

        {view.quiet && (
          <div className="ll-card ll-card-pad">
            <strong style={{ fontSize: 16 }}>{view.quiet.headline}</strong>
            {/* Saying what was LOOKED at is the difference between a calm
                screen and one he assumes is broken. */}
            <p className="mut" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>
              {view.quiet.checkedLine}
            </p>
          </div>
        )}

        {/* Proof of life, quietly, whether or not anything needed him. */}
        {!view.liveness.alarm && (
          <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            {view.liveness.line}
          </p>
        )}
      </section>

      {/* ---- his own list ------------------------------------------------ */}
      <section style={{ marginTop: 22 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Your own list</h2>
          {!adding && (
            <button className="ll-btn ghost" style={{ padding: "4px 10px", fontSize: 13 }}
              onClick={() => setAdding(true)}>
              Add one
            </button>
          )}
        </div>

        {adding && (
          <div className="ll-card ll-card-pad" style={{ marginBottom: 10 }}>
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Call the septic people about lot 12…"
              style={{ width: "100%" }}
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="ll-btn" disabled={busy || !noteText.trim()}
                onClick={() => {
                  act(() => addNote(parkId, noteText));
                  setNoteText(""); setAdding(false);
                }}>
                Add it
              </button>
              <button className="ll-btn ghost" onClick={() => { setAdding(false); setNoteText(""); }}>
                Back
              </button>
            </div>
          </div>
        )}

        {view.notes.length > 0 ? (
          <div className="ll-card">
            {view.notes.map((n) => (
              <div key={n.id} style={{
                padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)",
                display: "flex", gap: 10, alignItems: "baseline",
              }}>
                <span style={{ flex: 1, fontSize: 14 }}>{n.body}</span>
                <button className="ll-btn ghost" disabled={busy}
                  style={{ padding: "4px 10px", fontSize: 13 }}
                  onClick={() => act(() => doneNote(parkId, n.id))}>
                  Done
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mut" style={{ fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
            {/* The tax bill and the insurance renewal used to be the examples
                here. 0123 made both schedulable, so pointing him at a note for
                them would send him the long way round for something the
                software now watches. */}
            Anything the app can&apos;t know about — the licence renewal, the
            quote you&apos;re waiting on, what somebody told you in the driveway.
            Yours stay until you tick them; ours go when they&apos;re handled.
          </p>
        )}
      </section>
    </div>
  );
}

function TaskCard({
  parkId, task, today, busy, onAct,
}: {
  parkId: string; task: Task; today: string; busy: boolean;
  onAct: (fn: () => Promise<{ ok: boolean; signal?: string; error?: string }>) => void;
}) {
  return (
    <div className="ll-card ll-card-pad"
      style={{ background: task.urgency === "overdue" ? "rgba(200,60,40,.07)" : undefined }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15, flex: 1 }}>{task.title}</strong>
        <span className={`ll-pill ${URGENCY_PILL[task.urgency] ?? ""}`}>
          {task.urgency === "overdue" ? "overdue" : task.urgency === "soon" ? "soon" : "when you can"}
        </span>
      </div>
      <p className="mut" style={{ fontSize: 13, marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
        {task.detail}
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Link className="ll-btn" href={task.href}
          style={{ textDecoration: "none", padding: "6px 14px", fontSize: 14 }}>
          Sort it
        </Link>

        {/* Snoozing is always allowed; dismissing is not. Money owed and a
            missed notice deadline cannot be told to go away — the software
            must not offer to stop mentioning them. */}
        <button className="ll-btn ghost" disabled={busy}
          style={{ padding: "6px 12px", fontSize: 14 }}
          onClick={() => onAct(() => snoozeTask(parkId, task.key, addDays(today, 7)))}>
          Not this week
        </button>

        {task.canDismiss && (
          <button className="ll-btn ghost" disabled={busy}
            style={{ padding: "6px 12px", fontSize: 14 }}
            onClick={() => {
              const why = window.prompt("Why are you leaving this? (optional)");
              if (why === null) return;
              onAct(() => dismissTask(parkId, task.key, why));
            }}>
            Don&apos;t mention it again
          </button>
        )}
      </div>
    </div>
  );
}
