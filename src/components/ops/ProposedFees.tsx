"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { chargeProposedFee, waiveProposedFee, type ProposedFeeRow } from "@/app/ops/recovery-actions";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * THE FEE DECISIONS WAITING ON A PERSON.
 *
 * The nightly PROPOSES a fee when a customer's window runs out; nothing is
 * charged until somebody here says so. That split is the house autonomy rule:
 * a job may run unattended only when its worst outcome is a sentence on a
 * screen. Putting money on a card because a crew tapped a button on a doorstep
 * is not that, so it stops here.
 *
 * EVERY ROW SHOWS WHAT THE CREW ALREADY GOT FOR THE TRIP, and that is the
 * point of the layout rather than a detail. Waiving is much easier to do
 * kindly when you can see the crew is not the one absorbing it — without that
 * number, ops is choosing between a customer's goodwill and a crew's fuel with
 * only half the facts on screen.
 */
export function ProposedFees({ rows }: { rows: ProposedFeeRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="mut" style={{ fontSize: 13, margin: 0 }}>
        No fee decisions waiting. Visits where nobody was home get a week to
        rebook before one is proposed.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {rows.map((r) => (
        <FeeCard key={r.jobId} row={r} />
      ))}
    </div>
  );
}

function FeeCard({ row }: { row: ProposedFeeRow }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [why, setWhy] = useState("");
  const [waiving, setWaiving] = useState(false);

  return (
    <div className="ll-card ll-card-pad">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{row.serviceName}</strong>
        <span className="mut" style={{ fontSize: 13 }}>{row.address}</span>
        <span className="ll-pill warn" style={{ marginLeft: "auto" }}>{usd(row.fee)} proposed</span>
      </div>

      <p className="mut" style={{ fontSize: 13, margin: "8px 0 0", lineHeight: 1.5 }}>
        {row.outcome === "stood_down" ? "Crew stood down" : "Nobody let them in"} on{" "}
        {row.attemptedOn ? new Date(`${row.attemptedOn}T12:00:00`).toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric",
        }) : "—"}. The customer had a week to pick another day and didn&apos;t.
      </p>
      {row.reason && (
        <p style={{ fontSize: 13, margin: "6px 0 0", fontStyle: "italic" }}>&ldquo;{row.reason}&rdquo;</p>
      )}

      {/* THE FACT THAT SHOULD DECIDE HOW THIS FEELS. */}
      <p
        className="mut"
        style={{
          fontSize: 12.5, margin: "10px 0 0", padding: "8px 10px", borderRadius: 8,
          background: "var(--sand, #f6f3ec)", lineHeight: 1.5,
        }}
      >
        {row.tripFeePaid > 0 ? (
          <>
            The crew has already been paid <b>{usd(row.tripFeePaid)}</b> for the
            trip. Waiving this costs them nothing — it comes off us.
          </>
        ) : (
          <>
            <b>No trip fee reached this crew.</b> Waiving means they drove out
            for nothing — worth a look before you do.
          </>
        )}
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          className="ll-btn gold"
          style={{ minHeight: 44 }}
          disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await chargeProposedFee(row.jobId);
              toast(res.ok ? (res.signal ?? "Charged.") : (res.error ?? "Couldn't charge that."));
              if (res.ok) router.refresh();
            })
          }
        >
          {busy ? "Working…" : `Charge ${usd(row.fee)}`}
        </button>
        <button className="ll-btn ghost" style={{ minHeight: 44 }} disabled={busy}
          onClick={() => setWaiving((w) => !w)}>
          Waive it
        </button>
      </div>

      {waiving && (
        <div className="ll-field" style={{ marginTop: 10 }}>
          {/* A reason is required by the action, deliberately: waiving is a
              decision somebody made, and in six months the only way to know
              why is if they wrote it down. */}
          <label>Why are you waiving it?</label>
          <input
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="e.g. first time, and they called to apologise"
            autoFocus
          />
          <button
            className="ll-btn"
            style={{ marginTop: 8, minHeight: 44 }}
            disabled={busy || !why.trim()}
            onClick={() =>
              start(async () => {
                const res = await waiveProposedFee(row.jobId, why);
                toast(res.ok ? (res.signal ?? "Waived.") : (res.error ?? "Couldn't waive that."));
                if (res.ok) router.refresh();
              })
            }
          >
            {busy ? "Waiving…" : "Waive it"}
          </button>
        </div>
      )}
    </div>
  );
}
