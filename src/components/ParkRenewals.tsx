"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { longDate } from "@/lib/lake-time";
import { chipStyle } from "@/components/wizard-controls";
import { lengthInWords, lengthsInWords, agreementSpanWords } from "@/app/park/agreement-helpers";
import { renewAgreement, type RenewalPreview } from "@/app/park/renew-actions";
import { money } from "@/app/park/ledger-helpers";

/**
 * WRITING THE NEXT AGREEMENTS, a cycle at a time.
 *
 * At a park that caps agreement length this is the park's main recurring job
 * — nineteen households, each coming round as often as the length they chose
 * runs out. Doing it one screen-hop at a time is how it stops getting done,
 * and a lapsed tenancy stops being billed silently.
 *
 * So the whole cycle is one list with a button per row, and the common case —
 * renew at the same rent — is a single tap with nothing to type.
 *
 * THE LENGTH IS THE HOUSEHOLD'S CHOICE. The owner's decision: one, three or
 * six months at every renewal. The row offers the lengths the park writes
 * (the server planned each one, season clamp included), starts on the park's
 * house style, and the sentence under the chips shows the real dates of the
 * one picked — because that is what the button writes, in the words the
 * toast will say back (agreementSpanWords, one home for both). This card
 * used to write the cap, so "Renew at the same rent" turned a one-month
 * lease into a three-month one without a word on screen.
 *
 * THE NUMBER ON THE ROW IS THE NUMBER THE BUTTON WRITES. `quotedAmount` is the
 * rent in force on the successor's first morning, which differs from what the
 * prior row carries today only when a served increase lands in between — and
 * then the row says so, because a $425 beside a roll that still reads $400 is
 * a number he did not type and should not have to guess at.
 */

/** True when a served increase lands between today and the successor's start. */
const rentMoves = (r: RenewalPreview) =>
  r.quotedAmount != null && r.priorQuotedAmount != null && r.priorQuotedAmount !== r.quotedAmount;

/** planReRate refuses only "already at that amount", so a served DECREASE
 *  reaches this row too — the sentence must not call it an increase. */
const rentMovesNote = (r: RenewalPreview) =>
  `${money(r.priorQuotedAmount!)} today; the ${r.quotedAmount! > r.priorQuotedAmount! ? "increase" : "decrease"} ` +
  `you served takes effect ` +
  `${r.rentChangeOn ? longDate(r.rentChangeOn) : "before the next one starts"}, ` +
  `so the next one is written at ${money(r.quotedAmount!)}.`;

export function ParkRenewals({
  parkId, rows,
}: { parkId: string; rows: RenewalPreview[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [rent, setRent] = useState("");
  // The length picked per row. Absent means the park's house style — the
  // length the choice starts on — so nothing is chosen for him by this screen
  // that the park's own dial did not.
  const [picked, setPicked] = useState<Record<string, number>>({});

  if (rows.length === 0) return null;

  /** The lengths this row can actually be written for — a lapsed agreement
   *  is planned from its own end, and a short length may be over before
   *  today while a longer one reaches past it. Only those get a chip. */
  function open(r: RenewalPreview) {
    return r.lengths.filter((l) => l.plan.ok && l.plan.start && l.plan.end);
  }

  /** The length this row will be written for, and its plan: the pick, else
   *  the house style when it can be written, else the shortest that can. */
  function choice(r: RenewalPreview) {
    const can = open(r);
    const want = picked[r.reservationId] ?? r.defaultMonths;
    return can.find((l) => l.months === want) ?? can[0] ?? null;
  }

  const lapsed = rows.filter((r) => r.lapsed).length;

  function renew(r: RenewalPreview, newRent?: string) {
    const at = choice(r);
    if (!at) { toast.err("Pick how long the next one runs."); return; }
    start(async () => {
      const res = await renewAgreement(parkId, r.reservationId, { months: at.months, newRent });
      toast(res.ok ? (res.signal ?? "Written.") : (res.error ?? "Couldn't write that."));
      if (res.ok) { setEditing(null); setRent(""); }
      // Refreshed on a refusal too: a tab left open over midnight keeps
      // yesterday's chips, and the server just re-planned the row — the
      // stale chip goes with the refresh rather than inviting a second tap.
      router.refresh();
    });
  }

  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Agreements to write</h2>
      {/* PAST TENSE FOR A PAST EVENT. Fifteen agreements that lapsed on
          1 February read "run out soon" in June. The heading splits on the
          fact the server carries (`lapsed`), and the rows lead with them —
          the list is already oldest-end first. */}
      <p className="mut" style={{ fontSize: 13, marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
        {lapsed === 0
          ? "These run out soon and have nothing behind them. When one lapses the rent stops being billed — quietly, with no error."
          : lapsed === rows.length
            ? `${lapsed === 1 ? "This one has" : "These have"} lapsed with nothing behind ${lapsed === 1 ? "it" : "them"} — nothing has been billed to ${lapsed === 1 ? "the household" : "them"} since.`
            : `${lapsed} of these ${lapsed === 1 ? "has" : "have"} lapsed — nothing has been billed to ${lapsed === 1 ? "that household" : "them"} since. The rest run out soon and have nothing behind them.`}
      </p>

      <div className="ll-card">
        {rows.map((r) => {
          const at = choice(r);
          const can = open(r);
          // Lengths the park writes that would be over before today from
          // this agreement's end — named, so a missing chip is not a mystery.
          const over = r.lengths.filter((l) => l.plan.refusal === "already_ended").map((l) => l.months);
          return (
          <div key={r.reservationId}
            style={{ padding: "11px 14px", borderTop: "1px solid rgba(0,0,0,.06)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ minWidth: 62 }}>Lot {r.lotNumber}</strong>
              <span style={{ flex: 1 }}>{r.renterName ?? "—"}</span>
              <span className="mut" style={{ fontSize: 13 }}>
                {r.lapsed ? `lapsed ${longDate(r.priorEnd)} — nothing billed since` : `ends ${longDate(r.priorEnd)}`}
              </span>
              {r.quotedAmount != null && (
                <span className="mut" style={{ fontSize: 13 }}>{money(r.quotedAmount)}</span>
              )}
            </div>
            {rentMoves(r) && (
              <div className="mut" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
                {rentMovesNote(r)}
              </div>
            )}

            {r.plan.ok && at?.plan.ok && at.plan.start && at.plan.end ? (
              <>
                {/* THE HOUSEHOLD'S CHOICE. One chip per length the park
                    writes AND can write from this end, starting on its
                    house style. The dates under them are the picked
                    length's own plan — season clamp included — because
                    that is exactly what the button writes. */}
                {can.length > 1 && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                    <span className="mut" style={{ fontSize: 13 }}>Renew for</span>
                    {can.map((l) => {
                      const on = l.months === at.months;
                      return (
                        <button key={l.months} type="button" aria-pressed={on} disabled={busy}
                          style={{ ...chipStyle(on), padding: "6px 12px", fontSize: 13 }}
                          onClick={() => setPicked((p) => ({ ...p, [r.reservationId]: l.months }))}>
                          {lengthInWords(l.months)}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* THE PLAN'S OWN WORDS, the same helper the toast reads —
                    "3 months, February 1, 2027 to May 1, 2027", or "3 months,
                    cut short by the season close — September 1, 2027 to
                    October 16, 2027" on a slip lot (the close day is the last
                    night; the agreement ends the morning after). This line used to quote
                    the picked length beside the clamped dates. */}
                <div className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                  Next one: {agreementSpanWords(at.plan)}.
                  {/* CONSECUTIVE is the plan's fact, not the deposit dial's:
                      at a park with no deposit a fresh start after a gap
                      read "Consecutive". A deposit is mentioned only when
                      one is due. */}
                  {at.plan.continuesChain
                    ? " Consecutive with the last one."
                    : ` Starts a new chain — there was a gap after ${longDate(r.priorEnd)}.` +
                      (at.plan.depositDue && at.plan.depositAmount != null ? ` A deposit of ${money(at.plan.depositAmount)} is due.` : "")}
                  {/* THE MONEY FACT OF A BACKFILL: the tap below BILLS the
                      months the run has already passed (gap-bills); the
                      sentence is the server's, which knows today and whether
                      this month ran. */}
                  {r.backfillNote ? ` ${r.backfillNote}` : ""}
                </div>
                {over.length > 0 && (
                  <div className="mut" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
                    From {longDate(r.priorEnd)}, {lengthsInWords(over)} would be over already, so
                    {can.length === 1
                      ? ` only ${lengthInWords(can[0].months)} reaches past today.`
                      : over.length === 1 ? " it isn't offered here." : " those aren't offered here."}
                  </div>
                )}

                {/* Said out loud past a year of consecutive short agreements.
                    Not advice — the length of a chain is a fact he should be
                    looking at, and a court would look at it too. */}
                {at.chainNote && (
                  <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                    {at.chainNote}
                  </div>
                )}

                {editing === r.reservationId ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                      <span className="mut">New rent</span>
                      <input value={rent} inputMode="decimal" autoFocus
                        onChange={(e) => setRent(e.target.value)}
                        placeholder={r.quotedAmount?.toFixed(2) ?? ""}
                        style={{ marginTop: 4, width: 120 }} />
                    </label>
                    {/* A button that cannot do what its label says stays
                        off: a blank box wrote the OLD rent under a toast
                        identical to a change. "Back" is the same-rent door. */}
                    <button className="ll-btn" disabled={busy || !rent.trim()}
                      onClick={() => renew(r, rent)}>Write it</button>
                    <button className="ll-btn ghost" disabled={busy}
                      onClick={() => { setEditing(null); setRent(""); }}>Back</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {/* The common case is one tap and nothing typed. THE
                        LABEL IS WHAT THE TAP WRITES: with no rent on the row
                        this tap writes the successor with none, and "the
                        same rent" named a rent that does not exist — beside
                        a note that says which door sets one. */}
                    <button className="ll-btn" disabled={busy}
                      style={{ padding: "6px 14px", fontSize: 14 }}
                      onClick={() => renew(r)}>
                      {r.quotedAmount == null
                        ? "Renew with no rent set"
                        : rentMoves(r) ? `Renew at ${money(r.quotedAmount)}` : "Renew at the same rent"}
                    </button>
                    <button className="ll-btn ghost" disabled={busy}
                      style={{ padding: "6px 12px", fontSize: 14 }}
                      onClick={() => { setEditing(r.reservationId); setRent(""); }}>
                      Renew at a new rent
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
                {r.refusalText}
              </div>
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}
