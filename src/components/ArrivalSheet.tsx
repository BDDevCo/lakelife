"use client";

import { useState } from "react";
import { toast } from "@/components/Toast";
import { submitFlag, recordNoShow } from "@/app/vendor/actions";
import { noAnswerExplainer, FIELD_LABEL, declineMeans } from "@/lib/arrival";

/**
 * THE FIRST THING THE CREW TAPS WHEN THEY PULL IN.
 *
 * Brendon: "if there is a discrepancy it needs to be addressed by the crew
 * when they arrive."
 *
 * So this is deliberately not a "flag" buried among six buttons — it is the
 * first move of the visit, and it asks one question a person can answer while
 * still holding their coffee: does this match what we told you?
 *
 * THREE ANSWERS, AND THEY ARE THE ONLY THREE THAT EXIST:
 *   · Yes — get on with it. Nothing is recorded, because nothing happened.
 *   · No, it's different — say WHAT, in counts. That holds the job until the
 *     owner decides (0084), which is the entire point: the old flow let a crew
 *     do the bigger job and get paid for the smaller one.
 *   · Something else is wrong — in words. The pier is already out. A car is
 *     parked across the whole lawn. It's the wrong house. This header used to
 *     call the other three "the only three that exist", and they are not: a
 *     crew whose problem wasn't a number had to pick a field and invent one,
 *     which rule 6 writes into the customer's profile the moment they approve.
 *   · Nobody's answering — and what that means is NOT the crew's call to make.
 *     The service already knows whether they need to get inside.
 *
 * NO PRICES ANYWHERE IN THIS FILE, and none come back from the actions it
 * calls. The crew states the count; the server turns it into money for the
 * homeowner's eyes only (rule 1).
 */

/** The correction each service actually admits of, in the crew's words. */
const WHAT_CHANGED: Array<{
  key: string;
  field: string;
  prompt: string;
  kind: "count" | "band";
  /** Only offered when the service plausibly involves it. */
  showFor: (service: string) => boolean;
}> = [
  {
    key: "pier_sections", field: "pier_sections", kind: "count",
    prompt: "How many sections are actually there?",
    showFor: (s) => /pier/i.test(s),
  },
  {
    key: "boat_lifts", field: "boat_lifts", kind: "count",
    prompt: "How many boat lifts are actually there?",
    showFor: (s) => /lift|boat/i.test(s),
  },
  {
    key: "pwc_lifts", field: "pwc_lifts", kind: "count",
    prompt: "How many PWC lifts are actually there?",
    showFor: (s) => /pwc|lift|jet/i.test(s),
  },
  {
    key: "jet_skis", field: "jet_skis", kind: "count",
    prompt: "How many jet skis are actually there?",
    showFor: (s) => /jet|toy|pwc/i.test(s),
  },
  {
    key: "toy_lifts", field: "toy_lifts", kind: "count",
    prompt: "How many toy lifts are actually there?",
    showFor: (s) => /toy/i.test(s),
  },
  {
    key: "lawn_band", field: "lawn_band", kind: "band",
    prompt: "How big is the lawn really?",
    showFor: (s) => /lawn|mow/i.test(s),
  },
  {
    key: "panes", field: "panes", kind: "count",
    prompt: "How many panes are actually there?",
    showFor: (s) => /window|glass/i.test(s),
  },
  {
    key: "drive_band", field: "drive_band", kind: "band",
    prompt: "How big is the driveway really?",
    showFor: (s) => /snow|plough|plow|drive/i.test(s),
  },
];

type Step = "ask" | "different" | "somethingelse" | "noanswer";

/**
 * WHAT HAPPENS NEXT, SO NOBODY STANDS THERE GUESSING.
 *
 * Both halves of a decline come out of `declineMeans` — the sentence the crew
 * reads here and the sentence the owner reads on the approval card. This used
 * to be a literal ending "If they say no, do the job as it was booked", which
 * is true of a mow and false of a pier removal, and which sat twenty lines
 * under a field helper saying "you pack up and go". A crew who answered "no, I
 * can't do this without the change" was given both instructions at once.
 *
 * Deliberately silent about money: the crew states the count, the owner sees
 * the price (rule 1).
 */
export function WhatHappensNext({
  canProceed,
  cannotReason,
  serviceName,
}: {
  canProceed: boolean;
  cannotReason: string;
  serviceName: string;
}) {
  const means = declineMeans(
    { crew_can_proceed: canProceed, crew_cannot_reason: cannotReason },
    { serviceName },
  );
  return (
    <div
      style={{
        padding: "10px 12px", borderRadius: 10, marginBottom: 12,
        background: "var(--sun-soft)", border: "1px solid #ecd9ad", color: "#7a5a1e",
        fontSize: 12.5, lineHeight: 1.5,
      }}
    >
      This holds the job and asks the owner to confirm.{" "}
      <b>Don&apos;t start until they answer</b> — you&apos;ll get a text either
      way. {means.crewDetail}
    </div>
  );
}

export function ArrivalSheet({
  jobId,
  serviceName,
  address,
  needsInteriorAccess,
  needsRelease,
  onClose,
  onHeld,
  onNoShow,
}: {
  jobId: string;
  serviceName: string;
  address: string;
  needsInteriorAccess: boolean;
  /** 0150: a third party has to hand the boat over before this can start. */
  needsRelease: boolean;
  onClose: () => void;
  onHeld: () => void;
  onNoShow: () => void;
}) {
  const [step, setStep] = useState<Step>("ask");
  const [busy, setBusy] = useState(false);

  // Offer the corrections this service could plausibly involve, plus a
  // catch-all — a crew looking for "pier sections" on a mow is a crew who
  // stops reading.
  const relevant = WHAT_CHANGED.filter((w) => w.showFor(serviceName));
  const options = relevant.length > 0 ? relevant : WHAT_CHANGED;

  const [field, setField] = useState(options[0]?.field ?? "pier_sections");
  const [countVal, setCountVal] = useState("");
  const [band, setBand] = useState("large");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  // THE QUESTION ONLY THE CREW CAN ANSWER, asked before the owner decides —
  // not discovered afterwards. A pier REMOVAL at 8 of 12 leaves four sections
  // in the water for the ice; "do it as booked" would be damage.
  const [canProceed, setCanProceed] = useState(true);
  const [cannotReason, setCannotReason] = useState("");

  const chosen = WHAT_CHANGED.find((w) => w.field === field) ?? options[0];

  async function sendCorrection(kind: "correction" | "other") {
    if (busy) return;
    // `chosen.field`, NOT a hardcoded key. The count branch was already
    // generic; the band branch wrote `lawn_band` literally, so a driveway
    // correction would have been filed against the customer's LAWN — a wrong
    // fact, approved by the homeowner, repricing the wrong service.
    //
    // NULL for "something else": there is no number, and inventing one is the
    // exact harm this door exists to remove. `note` carries the whole fact and
    // the server's own guard now accepts words in place of counts.
    const proposed: Record<string, unknown> | null =
      kind === "other"
        ? null
        : chosen.kind === "band"
          ? { [chosen.field]: band }
          : { [chosen.field]: Number(countVal) };

    if (kind === "correction" && chosen.kind === "count" && !countVal.trim()) {
      toast("Put the real number in — that's what the owner approves.");
      return;
    }
    if (kind === "other" && note.trim().length < 6) {
      toast("Say what you found — the owner is being asked to stop the job on it.");
      return;
    }
    if (!canProceed && !cannotReason.trim()) {
      toast("Say why you can't — the owner is choosing between two outcomes.");
      return;
    }
    setBusy(true);
    // atArrival = true. This is the flag that STOPS the job.
    const res = await submitFlag(jobId, kind === "other" ? "other" : chosen.field, note, proposed, true, {
      canProceed,
      cannotReason: canProceed ? "" : cannotReason,
    });
    setBusy(false);
    if (!res.ok) { toast(res.error ?? "Couldn't send that."); return; }
    toast("Sent. Don't start until they say yes — you'll get a text.");
    onHeld();
  }

  async function sendNoShow() {
    if (busy) return;
    if (!reason.trim()) { toast("Say what happened — the owner may be charged for this."); return; }
    setBusy(true);
    const res = await recordNoShow(jobId, reason);
    setBusy(false);
    if (!res.ok) { toast(res.error ?? "Couldn't record that."); return; }
    toast("Recorded. Ops will sort the reschedule — move on to your next stop.");
    onNoShow();
  }

  const selectStyle: React.CSSProperties = {
    width: "100%", padding: "12px 13px", border: "1.5px solid var(--line)",
    borderRadius: 10, fontSize: 16, fontFamily: "inherit", background: "#fff", color: "var(--text)",
  };
  // Thumb-sized, because this is used one-handed, outdoors, in a hurry.
  //
  // THE COLUMN IS LOAD-BEARING. `.ll-btn` is `display: inline-flex` with
  // `align-items: center`, so the two-line buttons here — a label plus a
  // `display: block` span under it — put the span BESIDE the label as a second
  // flex item, squeezing "It's different from the profile" into a four-line
  // column an inch wide at 375px. `textAlign: left` does nothing to a flex
  // child. Stacking and starting them is what that line was reaching for.
  const bigBtn: React.CSSProperties = {
    width: "100%", textAlign: "left", padding: "14px 16px", marginBottom: 10,
    fontSize: 15.5, lineHeight: 1.35,
    flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
  };

  return (
    <div
      className="ll-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ll-modal" style={{ maxWidth: 460 }}>
        <div className="ll-modal-head">
          <div>
            <span className="ll-pill">On arrival</span>
            <h3 style={{ fontSize: 20, marginTop: 8 }}>{address}</h3>
            <div className="mut" style={{ fontSize: 13 }}>{serviceName}</div>
          </div>
          <button className="ll-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ll-modal-body">
          {step === "ask" && (
            <>
              <p style={{ fontSize: 15, marginTop: 0, marginBottom: 14, lineHeight: 1.5 }}>
                Before you start — does the job match what we told you?
              </p>

              <button className="ll-btn gold" style={bigBtn} onClick={onClose}>
                Yes, it all matches — start work
              </button>

              <button className="ll-btn ghost" style={bigBtn} onClick={() => setStep("different")}>
                It&apos;s different from the profile
                <span className="mut" style={{ display: "block", fontSize: 12.5, marginTop: 3 }}>
                  More sections, bigger lawn, an extra lift — we&apos;ll ask the owner
                  before you start.
                </span>
              </button>

              {/* THE DOOR FOR EVERYTHING THAT ISN'T A NUMBER. The pier is
                  already out, a car is parked across the lawn, it's the wrong
                  house. Without this the crew's only way to say so was to pick
                  a count field and invent a figure — which rule 6 then writes
                  into the customer's profile when they approve it. */}
              <button className="ll-btn ghost" style={bigBtn} onClick={() => setStep("somethingelse")}>
                Something else is wrong
                <span className="mut" style={{ display: "block", fontSize: 12.5, marginTop: 3 }}>
                  Not a count — anything that means you shouldn&apos;t start
                  until they&apos;ve seen it.
                </span>
              </button>

              <button className="ll-btn ghost" style={bigBtn} onClick={() => setStep("noanswer")}>
                Nobody&apos;s answering
              </button>
            </>
          )}

          {(step === "different" || step === "somethingelse") && (
            <>
              {step === "different" ? (
                <>
                  <div className="ll-field">
                    <label>What&apos;s different?</label>
                    <select value={field} onChange={(e) => { setField(e.target.value); setCountVal(""); }} style={selectStyle}>
                      {options.map((o) => (
                        <option key={o.key} value={o.field}>
                          {FIELD_LABEL[o.field as keyof typeof FIELD_LABEL] ?? o.field}
                        </option>
                      ))}
                    </select>
                  </div>

                  {chosen.kind === "count" ? (
                    <div className="ll-field">
                      <label>{chosen.prompt}</label>
                      <input
                        inputMode="numeric"
                        value={countVal}
                        onChange={(e) => setCountVal(e.target.value)}
                        placeholder="e.g. 12"
                        autoFocus
                        style={{ fontSize: 17 }}
                      />
                    </div>
                  ) : (
                    <div className="ll-field">
                      <label>{chosen.prompt}</label>
                      <select value={band} onChange={(e) => setBand(e.target.value)} style={selectStyle}>
                        <option value="small">Small — under ¼ acre</option>
                        <option value="medium">Medium — ¼ to ½ acre</option>
                        <option value="large">Large — over ½ acre</option>
                      </select>
                    </div>
                  )}
                </>
              ) : (
                /* NO SELECT, NO NUMBER. The words ARE the fact here, and they
                   are the only thing the owner will have to go on. */
                <div className="ll-field">
                  <label>What&apos;s wrong?</label>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. the pier's already out of the water"
                    autoFocus
                    style={{ fontSize: 17 }}
                  />
                </div>
              )}

              {/* WHAT HAPPENS IF THEY SAY NO. The crew is the only person who
                  can answer it, and they are standing there now. */}
              <div className="ll-field">
                <label>If they say no, can you still do what was booked?</label>
                <select
                  value={canProceed ? "yes" : "no"}
                  onChange={(e) => setCanProceed(e.target.value === "yes")}
                  style={selectStyle}
                >
                  <option value="yes">Yes — I&apos;ll do the booked amount and leave the rest</option>
                  <option value="no">No — I can&apos;t do this job without the change</option>
                </select>
              </div>

              {!canProceed && (
                <div className="ll-field">
                  <label>Why not?</label>
                  <input
                    value={cannotReason}
                    onChange={(e) => setCannotReason(e.target.value)}
                    placeholder="e.g. removal — leaving 4 in the water would wreck them over winter"
                    autoFocus
                  />
                  {/* WHAT HAPPENS IF THEY STILL SAY NO used to be spelled out
                      here as well, in words that contradicted the banner
                      below. One outcome, said once. */}
                  <p className="mut" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                    The owner reads this before deciding.
                  </p>
                </div>
              )}

              {step === "different" && (
                <div className="ll-field">
                  <label>Anything else the owner should know? (optional)</label>
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. counted 12 including the end platform"
                  />
                </div>
              )}

              <WhatHappensNext
                canProceed={canProceed}
                cannotReason={cannotReason}
                serviceName={serviceName}
              />

              <button
                className="ll-btn gold"
                style={{ width: "100%" }}
                onClick={() => sendCorrection(step === "somethingelse" ? "other" : "correction")}
                disabled={busy}
              >
                {busy ? "Sending…" : "Send to the owner"}
              </button>
              <button
                className="ll-btn ghost"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => setStep("ask")}
                disabled={busy}
              >
                Back
              </button>
            </>
          )}

          {step === "noanswer" && (
            <>
              {/* THE RULE, NOT THE CREW'S JUDGEMENT. The service already knows
                  whether they need to get inside, so a tired crew at the end of
                  a hot afternoon is never the one deciding. */}
              <p style={{ fontSize: 15, marginTop: 0, lineHeight: 1.55 }}>
                {noAnswerExplainer({ needs_interior_access: needsInteriorAccess, needs_release: needsRelease }, serviceName)}
              </p>

              {!needsInteriorAccess && !needsRelease ? (
                <button className="ll-btn gold" style={{ width: "100%", marginTop: 6 }} onClick={onClose}>
                  Got it — doing it as booked
                </button>
              ) : (
                <>
                  <div className="ll-field" style={{ marginTop: 12 }}>
                    <label>What happened?</label>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. knocked and called twice, door locked, no lockbox"
                      autoFocus
                    />
                  </div>
                  <p className="mut" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
                    The owner is told straight away and <b>is not charged by this</b>.
                    Ops will offer them another day.
                  </p>
                  <button className="ll-btn" style={{ width: "100%" }} onClick={sendNoShow} disabled={busy}>
                    {busy ? "Recording…" : "Record a no-show"}
                  </button>
                </>
              )}

              <button
                className="ll-btn ghost"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => setStep("ask")}
                disabled={busy}
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
