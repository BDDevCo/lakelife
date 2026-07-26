"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitJobVerdict, postJobMessage, settleMyDispute } from "@/app/requests/job-detail-actions";
import { toast } from "@/components/Toast";

/**
 * The two interactive bits of the customer's job page: the 👍/👎 quality check
 * and the comment composer. Everything else on that page is a server render.
 *
 * Both follow the house pattern — call a server action, toast the outcome,
 * then router.refresh() so the new state comes back from the server render
 * (no optimistic local copy of money or dispute state to drift out of sync).
 * ToastHost is already mounted once in layout.tsx; never mount another.
 */

export function JobVerdictButtons({ jobId, serviceName }: { jobId: string; serviceName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  function send(verdict: "good" | "issue") {
    startTransition(async () => {
      const res = await submitJobVerdict(jobId, verdict, verdict === "issue" ? note : "");
      if (!res.ok) {
        toast(res.error ?? "Couldn't record that just now.");
        return;
      }
      if (res.recorded === false) {
        toast("Thanks — your answer was already in. 🌊");
      } else if (verdict === "good") {
        toast("Thanks — your crew gets the credit. 🌊");
      } else {
        toast("Flagged — your crew has been told and it's on them to make it right.");
      }
      setNoteOpen(false);
      setNote("");
      router.refresh();
    });
  }

  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>
        {`How did the ${serviceName} go?`}
      </div>
      <p className="mut" style={{ fontSize: 13.5, margin: "0 0 12px" }}>
        One tap. A thumbs-up gives your crew the credit; a thumbs-down puts their pay on hold until it&apos;s made
        right — and it never costs you anything.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          className="ll-btn"
          onClick={() => send("good")}
          disabled={pending}
          style={{ minHeight: 44 }}
        >
          {pending ? "One sec…" : "All good 👍"}
        </button>
        <button
          className="ll-btn ghost"
          onClick={() => setNoteOpen((v) => !v)}
          disabled={pending}
          style={{ minHeight: 44 }}
        >
          Something&apos;s off 👎
        </button>
      </div>

      {noteOpen && (
        <div style={{ marginTop: 12 }}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="What happened? (optional)"
            aria-label="What went wrong"
            style={{
              width: "100%", boxSizing: "border-box", minHeight: 88, padding: "10px 12px",
              border: "1.5px solid var(--line)", borderRadius: 10, fontFamily: "inherit", fontSize: 14,
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button
              className="ll-btn"
              onClick={() => send("issue")}
              disabled={pending}
              style={{ minHeight: 44, background: "var(--danger, #b34a3a)" }}
            >
              {pending ? "Sending…" : "Send it — flag the issue"}
            </button>
            <button className="ll-btn ghost" onClick={() => setNoteOpen(false)} disabled={pending} style={{ minHeight: 44 }}>
              Never mind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Comment on THIS job. Posts to the property board annotated with the job id,
 *  so the conversation stays where ops already looks. */
export function JobMessageComposer({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  function send() {
    const text = body.trim();
    if (!text || pending) return;
    startTransition(async () => {
      const res = await postJobMessage(jobId, text);
      if (!res.ok) {
        toast(res.error ?? "Couldn't send that — try again.");
        return;
      }
      setBody("");
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
      <input
        style={{
          flex: 1, padding: "11px 13px", border: "1.5px solid var(--line)", borderRadius: 10,
          fontFamily: "inherit", fontSize: 14, minWidth: 0,
        }}
        placeholder="Add a comment about this job…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        disabled={pending}
        aria-label="Add a comment about this job"
      />
      <button className="ll-btn gold" onClick={send} disabled={pending || !body.trim()} style={{ minHeight: 44 }}>
        {pending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}

/**
 * The two Make-It-Right answers, in-portal. Until now these existed ONLY as
 * links in a text message — a customer who lost the text had no way to close
 * out their own complaint.
 *
 * "Still not right" fires the policy engine and can move real money, so it
 * asks once before sending. Neither button ever sees a dispute token: the
 * server action resolves it from the job.
 */
export function DisputeAnswerButtons({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function answer(a: "resolved" | "still") {
    startTransition(async () => {
      const res = await settleMyDispute(jobId, a);
      if (!res.ok) {
        toast(res.error ?? "Couldn't update that just now.");
        return;
      }
      toast(
        a === "resolved"
          ? "Thanks — glad that's sorted. 🌊"
          : "Got it — we're taking it from here.",
      );
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      <button
        type="button"
        className="ll-btn"
        disabled={pending}
        onClick={() => answer("resolved")}
        style={{ fontSize: 14 }}
      >
        {pending ? "One sec…" : "That settles it 👍"}
      </button>

      {confirming ? (
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mut" style={{ fontSize: 13 }}>Sure? We&apos;ll take it from here.</span>
          <button type="button" className="ll-btn" disabled={pending} onClick={() => answer("still")} style={{ fontSize: 14 }}>
            Yes — still not right
          </button>
          <button type="button" className="ll-btn ghost" disabled={pending} onClick={() => setConfirming(false)} style={{ fontSize: 14 }}>
            Never mind
          </button>
        </span>
      ) : (
        <button type="button" className="ll-btn ghost" disabled={pending} onClick={() => setConfirming(true)} style={{ fontSize: 14 }}>
          It&apos;s still not right
        </button>
      )}
    </div>
  );
}
