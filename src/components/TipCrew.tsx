"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { addTip, type TipView } from "@/app/requests/actions";

/**
 * "SEND THE CREW SOMETHING?" — offered once, after the work is done.
 *
 * THE SUGGESTIONS COME FROM TIME ON SITE, NOT THE BILL. At 20% of the price,
 * the implied tip per hour across our own services runs from $9.60 to $126.67
 * — the cleaner works two and a half hours for twenty-four dollars while the
 * boat crew works ninety minutes for a hundred and ninety. A percentage is
 * nearly random with respect to effort, and always favours whoever touched the
 * most expensive object.
 *
 * FOUR THINGS THIS SCREEN WILL NOT DO, and they are the whole design:
 *
 *   NOTHING IS PRE-SELECTED. Not the middle option, not anything. A tip that
 *   arrives because somebody didn't notice a default isn't a tip.
 *
 *   "NO THANKS" IS A REAL BUTTON, the same size and weight as the others, with
 *   no sad face and no consequence. It is the commonest honest answer and the
 *   screen should behave as though that is completely fine, because it is.
 *
 *   IT SAYS THE WORK IS ALREADY PAID FOR. Without that sentence a suggestion
 *   reads as a shortfall, and people who feel dunned tip nothing and resent
 *   being asked.
 *
 *   IT IS ASKED ONCE. No reminders, no second prompt, no nudge email. Ever.
 */
export function TipCrew({ jobId, view }: { jobId: string; view: TipView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState(false);

  if (view.given != null) {
    return view.given > 0 ? (
      <p className="mut" style={{ fontSize: 13, margin: "10px 0 0" }}>
        You sent the crew ${view.given.toFixed(2)} for this one. 🌊
      </p>
    ) : null;   // Declined. Say nothing — it was a complete answer.
  }
  if (!view.canTip) return null;

  function send(amount: number | string) {
    start(async () => {
      const res = await addTip(jobId, amount);
      toast(res.ok ? (res.signal ?? "Thanks.") : (res.error ?? "Couldn't do that."));
      if (res.ok) router.refresh();
    });
  }

  const btn: React.CSSProperties = { minHeight: 44, minWidth: 76, fontSize: 15 };

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 15 }}>Send the crew something?</strong>
      <p className="mut" style={{ fontSize: 13, marginTop: 6, marginBottom: 12, lineHeight: 1.55 }}>
        {view.basis}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {view.options.map((n) => (
          // Deliberately identical styling across all three — no "recommended"
          // ring, no highlight on the middle one. The ladder itself is the
          // suggestion; anything more is a thumb on the scale.
          <button key={n} className="ll-btn ghost" style={btn} disabled={busy} onClick={() => send(n)}>
            ${n}
          </button>
        ))}
        <button
          className="ll-btn ghost"
          style={btn}
          disabled={busy}
          onClick={() => setOpen((o) => !o)}
        >
          Another amount
        </button>
        {/* Same size, same weight, no apology attached. */}
        <button className="ll-btn ghost" style={btn} disabled={busy} onClick={() => send(0)}>
          No thanks
        </button>
      </div>

      {open && (
        <div className="ll-field" style={{ marginTop: 12, maxWidth: 220 }}>
          <label>How much?</label>
          <input
            inputMode="decimal"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. 25"
            autoFocus
          />
          <button
            className="ll-btn"
            style={{ marginTop: 8, minHeight: 44 }}
            disabled={busy || !custom.trim()}
            onClick={() => send(custom)}
          >
            {busy ? "Sending…" : "Send it"}
          </button>
        </div>
      )}

      <p className="mut" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
        Every cent goes to the crew — LakeLife doesn&apos;t take a share of a
        thank-you.
      </p>
    </div>
  );
}
