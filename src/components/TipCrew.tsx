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
 *
 * AND ONE THING IT NOW DOES: it asks twice for the amount itself. A tip is
 * FINAL (0098) — it releases to the crew on capture and there is no tip refund
 * — so an irreversible charge sat behind a single tap on three 76-pixel
 * buttons on a phone. That is not a policy question, it is a fat finger. The
 * second tap is a guard, not a nudge: "No thanks" stays one tap throughout,
 * because pressure and confirmation are different things and only one of them
 * belongs here.
 */
export function TipCrew({ jobId, view }: { jobId: string; view: TipView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [customArmed, setCustomArmed] = useState(false);

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

  // What they actually typed, read the same way the server will read it
  // (`validateTip` strips $ and commas). Arming on an unparseable string would
  // put "Send $?" on the button and then fail on the second tap.
  const customValue = Number(custom.replace(/[$,\s]/g, ""));
  const customUsable = Number.isFinite(customValue) && customValue > 0;

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
          //
          // The first tap ARMS, the second sends. It cannot be undone, so it
          // should not be one tap on a phone.
          <button
            key={n}
            className={`ll-btn ${pending === n ? "gold" : "ghost"}`}
            style={btn}
            disabled={busy}
            onClick={() => (pending === n ? send(n) : setPending(n))}
          >
            {pending === n ? `Send $${n}?` : `$${n}`}
          </button>
        ))}
        <button
          className="ll-btn ghost"
          style={btn}
          disabled={busy}
          onClick={() => { setPending(null); setCustomArmed(false); setOpen((o) => !o); }}
        >
          Another amount
        </button>
        {/* Same size, same weight, no apology attached — and still ONE tap.
            Declining moves no money and nothing about it needs confirming;
            making "no" the slower path would be exactly the thumb on the
            scale the rest of this screen refuses. */}
        <button className="ll-btn ghost" style={btn} disabled={busy} onClick={() => send(0)}>
          No thanks
        </button>
      </div>

      {pending != null && (
        <p className="mut" style={{ fontSize: 12.5, margin: "10px 0 0", lineHeight: 1.5 }}>
          Tap again to send <b>${pending}</b> — it goes straight to the crew and
          can&apos;t be taken back. <button
            onClick={() => setPending(null)}
            style={{
              background: "none", border: "none", padding: 0, font: "inherit",
              color: "var(--teal-dark)", textDecoration: "underline", cursor: "pointer",
            }}
          >Change my mind</button>.
        </p>
      )}

      {open && (
        <div className="ll-field" style={{ marginTop: 12, maxWidth: 220 }}>
          <label>How much?</label>
          <input
            inputMode="decimal"
            value={custom}
            onChange={(e) => { setCustom(e.target.value); setCustomArmed(false); }}
            placeholder="e.g. 25"
            autoFocus
          />
          {/* THE SAME GUARD, and this is the path that needs it most — the
              ladder tops out at $50, but somebody can type $200 in here and
              a single tap would send it irreversibly. */}
          <button
            className={`ll-btn ${customArmed ? "gold" : ""}`}
            style={{ marginTop: 8, minHeight: 44 }}
            disabled={busy || !customUsable}
            onClick={() => (customArmed ? send(custom) : setCustomArmed(true))}
          >
            {busy ? "Sending…" : customArmed ? `Send $${customValue}?` : "Send it"}
          </button>
          {customArmed && !busy && (
            <p className="mut" style={{ fontSize: 12, margin: "8px 0 0", lineHeight: 1.5 }}>
              Tap again to send it — it goes straight to the crew and can&apos;t
              be taken back.
            </p>
          )}
        </div>
      )}

      {/* THE WINDOW, MENTIONED ONLY WHEN IT IS NEARLY UP.
          There is a 30-day limit and somebody should not discover it by
          finding the buttons gone. But saying "you have 29 days left" on day
          one turns a thank-you into a deadline, and this screen's whole design
          is that declining must feel completely fine. So it stays quiet until
          the last week, and even then it states a fact rather than pressing. */}
      {view.daysLeft != null && view.daysLeft >= 0 && view.daysLeft <= 7 && (
        <p className="mut" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
          {view.daysLeft === 0
            ? "Today is the last day this one can be added."
            : `Open for another ${view.daysLeft} day${view.daysLeft === 1 ? "" : "s"}.`}
        </p>
      )}

      {/* SAID BEFORE THEY GIVE, not discovered afterwards. A tip is final
          (0098) because it reaches the crew immediately, and the only honest
          way to hold that policy is to state it at the moment of the decision
          rather than in an error message later. */}
      <p className="mut" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
        {/* "IT REACHES THEM STRAIGHT AWAY" WAS THE REASON GIVEN FOR
            IRREVERSIBILITY, AND IT IS NOT THE REASON.
            addTip writes the crew's share as a `payouts` row with status
            'released' and no batch. Money only leaves for a crew's bank in
            runMonthlyPayoutBatches, which returns immediately unless today is
            the last day of the month and then claims exactly these rows
            (status 'released', batch_id null). A tip given on the 2nd sits for
            about twenty-nine days. The crew's own screen says so — "goes out
            in the month-end payout".
            The tip IS irreversible, but because no refund path for a tip
            exists, not because the money has gone. Telling somebody their
            money is already spent, when it is sitting in a queue, is the wrong
            reason for the right warning — and it is the sentence they read
            with their thumb over the button. */}
        Every cent goes to the crew — LakeLife doesn&apos;t take a share of a
        thank-you. It&apos;s theirs from the moment you send it and we
        can&apos;t take it back, so please be sure; if something was wrong with
        the work itself, tell us and we&apos;ll put that right separately.
      </p>
    </div>
  );
}
