"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inviteEveryone, type BulkInviteResult } from "@/app/parks/invite-actions";

/**
 * NINETEEN HOUSEHOLDS, ONE PRESS.
 *
 * This is the thing the printed slip was standing in for. A park that arrives
 * with addresses on its roll should never see a printer.
 *
 * IT NAMES WHO IT COULDN'T REACH. "12 emailed" is the flattering half of the
 * answer and the useless one: the seven households with no address on file are
 * the whole remaining job, and a screen that reports only the success count is
 * how they end up quietly never contacted. The list comes back with lot
 * numbers so it can be walked.
 */
export function InviteEveryone({
  parkId, canReach, needPaper,
}: {
  parkId: string;
  /** Households with an address and no invite yet. */
  canReach: number;
  /** Households with no address at all — paper is the only way to them. */
  needPaper: number;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [res, setRes] = useState<BulkInviteResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Nothing to offer: everyone is either set up, on paper by choice, or already
  // invited. Saying so is better than a button that would do nothing.
  if (canReach === 0 && !res) return null;

  function go() {
    start(async () => {
      const r = await inviteEveryone(parkId);
      setRes(r);
      setConfirming(false);
      router.refresh();
    });
  }

  if (res) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>{res.message}</strong>
        {res.needSlips.length > 0 && (
          <>
            <p className="mut" style={{ fontSize: 13.5, margin: "8px 0 6px", lineHeight: 1.55 }}>
              These need a slip printing and handing over instead. Their rows
              have a <strong>Print a slip</strong> button.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
              {res.needSlips.map((s) => (
                <li key={s.renterId}>
                  Lot {s.lotNumber} — {s.displayName}
                  {/* THE REASON, because the two need different things from
                      him: one is an address to collect, the other is an
                      address to correct. */}
                  <span className="mut">
                    {s.why === "no_email" ? " · no email on file" : " · that address didn't work"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <button className="ll-btn ghost sm" style={{ marginTop: 12 }} onClick={() => setRes(null)}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 12 }}>
      {!confirming ? (
        <>
          <strong style={{ fontSize: 15 }}>
            Invite {canReach} {canReach === 1 ? "household" : "households"} by email
          </strong>
          <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 12px", lineHeight: 1.55 }}>
            One message each, to the address already on their file, with a link
            to their own lot. It doesn&apos;t change how anybody pays, and there
            is no second one.
            {needPaper > 0 && (
              <> {needPaper} {needPaper === 1 ? "household has" : "households have"} no
              email on file — those still need a slip.</>
            )}
          </p>
          <button className="ll-btn" onClick={() => setConfirming(true)} style={{ minHeight: 44 }}>
            Invite them
          </button>
        </>
      ) : (
        <>
          <strong style={{ fontSize: 15 }}>
            Send {canReach} {canReach === 1 ? "email" : "emails"} now?
          </strong>
          <p className="mut" style={{ fontSize: 13.5, margin: "6px 0 12px", lineHeight: 1.55 }}>
            This is the one time we write to them. Nothing is sent to anyone
            who&apos;s already set up or has said no thanks.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" disabled={busy} onClick={go} style={{ minHeight: 44 }}>
              {busy ? "Sending…" : "Yes, send them"}
            </button>
            <button className="ll-btn ghost" disabled={busy} onClick={() => setConfirming(false)} style={{ minHeight: 44 }}>
              Not yet
            </button>
          </div>
        </>
      )}
    </div>
  );
}
