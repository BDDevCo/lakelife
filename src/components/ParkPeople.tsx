"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  inviteParkManager, removeParkManager, resendParkManagerInvite,
  revokeParkManagerInvite, type ParkPeopleView,
} from "@/app/park/handoff-actions";
import {
  MANAGER_CAN, MANAGER_CANNOT, handoffQuietSentence, inviteStanding,
  joinHandoffWords,
} from "@/app/park/handoff-helpers";

/**
 * WHO CAN OPEN THIS PARK.
 *
 * The screen that did not exist. `park_members.role` has allowed 'manager'
 * since migration 0052 and four gates in the module already read the word, but
 * the only statement in the product that ever WROTE a membership was
 * `createPark`, hard-coding "owner". So there was no way to put a second
 * person on a park — the thing he asked for in as many words.
 *
 * SAYS WHAT IT HANDS OVER, BEFORE HE HANDS IT. A park membership is read
 * access to every household's name, lot and payment history. The two lists are
 * drawn from the same constants the invitation email uses, which a test pins
 * to the real owner-only gates — so the promise on screen cannot drift from
 * what the software actually enforces.
 */
export function ParkPeople({ view }: { view: ParkPeopleView }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  /** Which row is mid-act, so one button spinning does not freeze the sheet. */
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const managers = view.people.filter((p) => p.role === "manager");
  const openInvites = view.invites.filter((i) => inviteStanding(i) === "open");

  function invite() {
    start(async () => {
      const res = await inviteParkManager(view.parkId, { email, note });
      if (!res.ok) { toast.err(res.error ?? "Couldn't send that."); return; }
      toast(res.signal ?? "Invitation sent.");
      setEmail("");
      setNote("");
      router.refresh();
    });
  }

  function act(key: string, run: () => Promise<{ ok: boolean; error?: string; signal?: string }>) {
    setBusyRow(key);
    start(async () => {
      const res = await run();
      setBusyRow(null);
      if (!res.ok) { toast.err(res.error ?? "That didn't work."); return; }
      toast(res.signal ?? "Done.");
      router.refresh();
    });
  }

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48, maxWidth: 680 }}>
      <h1 style={{ fontSize: 26, margin: "0 0 6px" }}>Who can open this park</h1>
      <p className="mut" style={{ fontSize: 14, margin: "0 0 18px", lineHeight: 1.55 }}>
        Anybody here can sign in and run {view.parkName}. Only you can add or
        remove them.
      </p>

      {/* THE QUIET STATE IS THE WHOLE POINT OF THE SCREEN. One person who can
          open a park is a single point of failure he may not have noticed, and
          this is the only place that can say so. */}
      {managers.length === 0 && openInvites.length === 0 && (
        <div className="ll-card ll-card-pad" style={{ marginBottom: 14, borderLeft: "4px solid var(--gold)" }}>
          <span className="ll-pill gold">Only you</span>
          <p style={{ fontSize: 14, margin: "10px 0 0", lineHeight: 1.55 }}>
            {handoffQuietSentence(view.parkName)}
          </p>
        </div>
      )}

      {view.viewerIsOwner && (
        <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Ask somebody to help run it</h2>
          <p className="mut" style={{ fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 }}>
            They&apos;ll get an email. Nothing happens until they sign in with
            that address — and if they already have a LakeLife account, that
            same address is fine.
          </p>

          <label className="ll-field" style={{ display: "block", fontSize: 13, margin: 0 }}>
            <span style={{ fontWeight: 700 }}>Their email</span>
            <input
              type="email"
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={{ width: "100%", marginTop: 4 }}
            />
          </label>

          <label className="ll-field" style={{ display: "block", fontSize: 13, marginTop: 12 }}>
            <span style={{ fontWeight: 700 }}>A note, if you want one</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Covering while I'm away in February."
              style={{ width: "100%", marginTop: 4 }}
            />
            <span className="mut" style={{ display: "block", marginTop: 5, fontSize: 12, lineHeight: 1.45 }}>
              Goes in the email, in your words.
            </span>
          </label>

          {/* WHAT HE IS ABOUT TO HAND OVER, before the button and not after
              it. Drawn from the same two lists the email uses. */}
          <div
            style={{
              marginTop: 14, padding: "11px 13px", borderRadius: 10,
              background: "var(--sand-light)", fontSize: 13, lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>They will be able to:</div>
            <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
              {MANAGER_CAN.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>They will not be able to:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {MANAGER_CANNOT.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>

          <button
            className="ll-btn"
            onClick={invite}
            disabled={pending || email.trim().length === 0}
            style={{ marginTop: 14 }}
          >
            {pending && busyRow === null ? "Sending…" : "Send the invitation"}
          </button>
        </div>
      )}

      <div className="ll-card ll-card-pad" style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>
          {view.people.length === 1
            ? "1 person can open this park"
            : `${view.people.length} people can open this park`}
        </h2>
        <div style={{ display: "grid", gap: 8 }}>
          {view.people.map((p) => (
            <div
              key={p.userId}
              style={{
                display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
                padding: "10px 12px", background: "var(--sand-light)", borderRadius: 10,
              }}
            >
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>
                  {p.name || p.email || "Someone"}
                  {p.isYou && <span className="mut" style={{ fontWeight: 400 }}> · you</span>}
                </div>
                <div className="mut" style={{ fontSize: 12.5 }}>
                  {p.role === "owner" ? "Owner" : "Helps run it"}
                  {p.email && p.name ? ` · ${p.email}` : ""}
                </div>
              </div>
              {view.viewerIsOwner && p.role === "manager" && (
                <button
                  className="ll-btn ghost"
                  style={{ flex: "0 0 auto", fontSize: 13, padding: "7px 12px" }}
                  disabled={busyRow === p.userId}
                  onClick={() => act(p.userId, () => removeParkManager(view.parkId, p.userId))}
                >
                  {busyRow === p.userId ? "Removing…" : "Take them off"}
                </button>
              )}
            </div>
          ))}
        </div>
        {managers.length === 0 && (
          <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.5 }}>
            Taking somebody off doesn&apos;t delete their account — it only
            stops them opening this park.
          </p>
        )}
      </div>

      {view.invites.length > 0 && (
        <div className="ll-card ll-card-pad">
          <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Invitations</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {view.invites.map((i) => {
              const standing = inviteStanding(i);
              return (
                <div
                  key={i.id}
                  style={{
                    display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
                    padding: "10px 12px", borderRadius: 10,
                    border: "1px solid var(--line)",
                  }}
                >
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{i.email}</div>
                    <div className="mut" style={{ fontSize: 12.5 }}>
                      {standing === "accepted"
                        ? `Taken up · invited ${i.invitedAtSaid}`
                        : standing === "withdrawn"
                          ? `Withdrawn · invited ${i.invitedAtSaid}`
                          : `Waiting on them · sent ${i.invitedAtSaid}`}
                    </div>
                  </div>
                  {view.viewerIsOwner && standing === "open" && (
                    <>
                      <button
                        className="ll-btn ghost"
                        style={{ flex: "0 0 auto", fontSize: 13, padding: "7px 12px" }}
                        disabled={busyRow === `resend:${i.id}`}
                        onClick={() => act(`resend:${i.id}`, () => resendParkManagerInvite(view.parkId, i.id))}
                      >
                        {busyRow === `resend:${i.id}` ? "Sending…" : "Send it again"}
                      </button>
                      <button
                        className="ll-btn ghost"
                        style={{ flex: "0 0 auto", fontSize: 13, padding: "7px 12px" }}
                        disabled={busyRow === `revoke:${i.id}`}
                        onClick={() => act(`revoke:${i.id}`, () => revokeParkManagerInvite(view.parkId, i.id))}
                      >
                        {busyRow === `revoke:${i.id}` ? "Withdrawing…" : "Withdraw it"}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!view.viewerIsOwner && (
        <p className="mut" style={{ fontSize: 13, marginTop: 14, lineHeight: 1.55 }}>
          You help run {view.parkName}, so you can see this list but not change
          it. You also can&apos;t {joinHandoffWords(MANAGER_CANNOT)} — those
          stay with the owner.
        </p>
      )}
    </div>
  );
}
