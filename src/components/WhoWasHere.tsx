"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { getWhoWasHere, setJobWorkers, type Worker } from "@/app/vendor/workers-actions";

/**
 * WHO WAS HERE — the driveway picker.
 *
 * DESIGNED AROUND ONE FACT: the person using this is standing outside at four
 * o'clock, on a phone, wanting to leave. Every decision follows from that.
 *
 *   IT IS NOT ON THE COMPLETION PATH. It saves on its own, and `Mark complete`
 *   never waits for it or fails because of it. The photo gate is the only gate
 *   this product has, and a second one would be a way to stop a crew going
 *   home dressed up as a way to help an owner split a tip.
 *
 *   IT LOADS ONLY WHEN OPENED. Nothing is fetched for it on the day view,
 *   which is the screen a crew opens at 6:55am with two bars of signal.
 *
 *   IT DEFAULTS TO WHOEVER CAME LAST TIME. Weekly mowing is the same two
 *   people at the same house all summer. Nobody builds a list from scratch at
 *   the end of a long day; they confirm one. If we can't guess, it opens empty
 *   rather than pre-ticking something plausible and wrong.
 *
 *   IT IS INVISIBLE TO A VENDOR WITH NO ROSTER. Not disabled, not nagging —
 *   absent. A crew who has chosen not to give us names should not meet a
 *   reminder of that choice on every job.
 */
export function WhoWasHere({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [roster, setRoster] = useState<Worker[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, start] = useTransition();

  function openPicker() {
    setOpen(true);
    if (loaded) return;
    start(async () => {
      const view = await getWhoWasHere(jobId);
      setRoster(view.roster);
      // Already recorded wins over the suggestion — a crew that has answered
      // must never have their answer quietly replaced by a guess.
      setPicked(new Set(view.selected.length > 0 ? view.selected : view.suggested));
      setLoaded(true);
    });
  }

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
    // SAVE ON EVERY TAP. No "save" button to forget, and the record survives
    // whatever happens to the visit next — a job that ends up held or
    // rescheduled still knows who turned up.
    start(async () => {
      const res = await setJobWorkers(jobId, [...next]);
      if (!res.ok) toast(res.error ?? "Couldn't note that.");
    });
  }

  if (!open) {
    return (
      <button
        className="ll-btn ghost sm"
        onClick={openPicker}
        style={{ minHeight: 40 }}
      >
        Who was here?
      </button>
    );
  }

  if (loaded && roster.length === 0) {
    // No roster: say why once, on the screen they deliberately opened, and
    // point at the page. Never on the card itself.
    return (
      <p className="mut" style={{ fontSize: 12.5, margin: "8px 0 0", lineHeight: 1.5 }}>
        No names on your crew list yet — add them under <b>Crew</b> and you can
        tag who was on each job, so your statement shows whose tips are whose.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 10, width: "100%" }}>
      <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Who was here? <span style={{ opacity: 0.75 }}>Tap to change — saves as you go.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {roster.map((w) => {
          const on = picked.has(w.id);
          return (
            <button
              key={w.id}
              className={`ll-btn ${on ? "gold" : "ghost"} sm`}
              style={{ minHeight: 44 }}
              disabled={busy}
              onClick={() => toggle(w.id)}
            >
              {on ? "✓ " : ""}{w.name}
            </button>
          );
        })}
      </div>
      {!loaded && <p className="mut" style={{ fontSize: 12.5, marginTop: 6 }}>Loading…</p>}
    </div>
  );
}
