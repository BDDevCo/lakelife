"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { getStatement, type StatementPage } from "@/app/park/receipts-actions";
import { reversePayment, refundParkPayment, refundableOn } from "@/app/park/ledger-actions";
import {
  money, receiptsHeadline, monthPeriod, quarterPeriod, yearPeriod, customPeriod,
  type Period,
} from "@/app/park/receipts-helpers";

/**
 * WHAT CAME IN, FOR THE ACCOUNTANT.
 *
 * The whole design rests on one inversion: the FILE stays a plain rectangle of
 * one row per payment, and everything the owner needs to understand lives on
 * the SCREEN. An accountant wants rows they can pivot and tie to a bank
 * statement, not our arithmetic; the owner needs to know what the number
 * leaves out before he forwards it.
 *
 * So the exclusions are not a footnote. They sit under the total, in his own
 * vocabulary, because the dangerous belief is that a tidy figure is a complete
 * one — and this figure has no expenses in it at all.
 */

function lastCompleteMonth(todayISO: string): string {
  const [y, m] = todayISO.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function ParkStatements({
  parkId, page: initial, today,
}: { parkId: string; page: StatementPage; today: string }) {
  const [page, setPage] = useState(initial);
  const [busy, start] = useTransition();
  const [customFrom, setCustomFrom] = useState(page.period.from);
  const [customTo, setCustomTo] = useState(page.period.to);
  // Which receipt he is taking back, and why.
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // Which receipt he is sending BACK to a card, and how much of it. Separate
  // state from the reversal above, because they are separate acts: one
  // corrects our record, the other moves real money outward.
  const [refunding, setRefunding] = useState<string | null>(null);
  // Dollars, from the server. Null while we are still asking.
  const [left, setLeft] = useState<{ amount: number; fee: number } | null>(null);
  const [backAmount, setBackAmount] = useState("");
  const [backFee, setBackFee] = useState(false);
  // Minted when the panel OPENS, not when the button is pressed — that is the
  // whole point. Two taps on one open panel must carry the same key, so the
  // processor recognises the second as a replay of the first.
  const [refundKey, setRefundKey] = useState("");

  function openRefund(paymentId: string) {
    setRefunding(paymentId);
    setLeft(null);
    setBackAmount("");
    setBackFee(false);
    setRefundKey(crypto.randomUUID());
    start(async () => {
      const res = await refundableOn(parkId, paymentId);
      if ("error" in res) { toast(res.error); setRefunding(null); return; }
      if (res.refusal) { toast(res.refusal); setRefunding(null); return; }
      setLeft({ amount: res.amount, fee: res.fee });
      setBackAmount(res.amount.toFixed(2));
    });
  }

  function closeRefund() {
    setRefunding(null); setLeft(null); setBackAmount(""); setBackFee(false); setRefundKey("");
  }
  const router = useRouter();

  function load(p: Period | null) {
    if (!p) { toast("That date range doesn't work — the end has to be on or after the start."); return; }
    start(async () => {
      // `getStatement` THROWS on a failed read now rather than reporting an
      // empty window, and a rejection inside a transition surfaces as a blank
      // failure with no sentence — so it is caught here and said out loud, and
      // the screen keeps showing the window it already had. A server action's
      // rejection arrives on the client as an opaque Error, so this cannot
      // narrow to ReadFailed; either way we have no statement to show.
      let next: StatementPage | null;
      try {
        next = await getStatement(parkId, p.from, p.to);
      } catch (e) {
        console.error("[LakeLife] statement failed to load:", e);
        toast("We couldn't build that just now, so nothing has changed. Try again in a moment.");
        return;
      }
      if (!next) { toast("Couldn't build that."); return; }
      setPage(next);
      setCustomFrom(next.period.from);
      setCustomTo(next.period.to);
    });
  }

  const s = page.summary;
  const year = Number(today.slice(0, 4));
  const href =
    `/park/statements/export?from=${page.period.from}&to=${page.period.to}`;

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Statements</h1>
      <p className="mut" style={{ marginTop: 0, fontSize: 14 }}>
        Money received, on a cash basis — what your accountant asked for.
      </p>

      {/* ---- pick a window ------------------------------------------------ */}
      <section style={{ marginTop: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip label="Last month" busy={busy}
            onClick={() => load(monthPeriod(lastCompleteMonth(today), today))} />
          <Chip label="This month" busy={busy}
            onClick={() => load(monthPeriod(today.slice(0, 7), today))} />
          {([1, 2, 3, 4] as const).map((q) => (
            <Chip key={q} label={`Q${q}`} busy={busy}
              onClick={() => load(quarterPeriod(year, q, today))} />
          ))}
          <Chip label={String(year)} busy={busy} onClick={() => load(yearPeriod(year, today))} />
          <Chip label={String(year - 1)} busy={busy} onClick={() => load(yearPeriod(year - 1, today))} />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">From</span>
            <input type="date" value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">To</span>
            <input type="date" value={customTo}
              onChange={(e) => setCustomTo(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <button className="ll-btn ghost" disabled={busy}
            onClick={() => load(customPeriod(customFrom, customTo, today))}>
            Use these dates
          </button>
        </div>
        <p className="mut" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
          Any two dates — useful for a part-month, like the day you take over to the end of that month.
        </p>
      </section>

      {/* ---- the number --------------------------------------------------- */}
      <div className="ll-card ll-card-pad" style={{ marginTop: 18 }}>
        <div className="mut" style={{ fontSize: 13 }}>
          {page.period.from} to {page.period.to}
        </div>
        <strong style={{ fontSize: 20, display: "block", marginTop: 4 }}>
          {receiptsHeadline(s, page.period)}
        </strong>

        {page.period.open && (
          <p style={{ fontSize: 13, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
            <strong>This window isn&apos;t finished yet.</strong> More money can still
            come in before {page.period.to}, so this is a part-period — the file
            is named that way too.
          </p>
        )}

        {s.count > 0 && (
          <div style={{ display: "grid", gap: 2, marginTop: 14, fontVariantNumeric: "tabular-nums" }}>
            {s.byMethod.map((b) => (
              <Row key={b.key} label={`${b.label.toLowerCase()} (${b.count})`} value={money(b.cents)} />
            ))}
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 6, paddingTop: 6 }}>
              <Row label="received" value={money(s.totalCents)} strong />
            </div>
            {/* CARD FEES SIT BELOW THE TOTAL, NEVER INSIDE IT. The by-method
                rows above must keep summing to `received` or the statement
                stops reconciling against itself — but the bank deposit is
                larger by exactly this, and an accountant who cannot see why
                stops trusting the file. */}
            {s.cardFeesCents > 0 && (
              <div style={{ marginTop: 6 }}>
                <Row
                  label="card fees on top — not yours, not in the total"
                  value={money(s.cardFeesCents)}
                />
                {/* NOT A BANK TOTAL. Deposits and money on account also
                    reached the bank in this window — the notes below this card
                    say so in as many words — and they are deliberately outside
                    `received`. Claiming a bank figure here that omits them put
                    two numbers on one page that cannot both be true, and the
                    person who finds that is an accountant. Say only what this
                    line actually knows. */}
                <Row
                  label="rent plus those fees"
                  value={money(s.totalCents + s.cardFeesCents)}
                />
              </div>
            )}
            {page.billedInWindowCents > 0 && (
              <div style={{ marginTop: 6 }}>
                <Row label="billed as due in this window" value={money(page.billedInWindowCents)} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- what it leaves out. Not a footnote. -------------------------- */}
      <section style={{ marginTop: 16 }}>
        <div className="ll-card ll-card-pad" style={{ background: "rgba(0,0,0,.02)" }}>
          <strong style={{ fontSize: 15 }}>Before you send this</strong>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 7 }}>
            {page.notes.map((n, i) => (
              <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>{n}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- things that need his eye ------------------------------------- */}
      {(s.againstVoided.length > 0 || s.reversed.length > 0 || s.overpaidCents > 0 || s.otherMonthCount > 0) && (
        <section style={{ marginTop: 16 }}>
          <div className="ll-card ll-card-pad">
            <strong style={{ fontSize: 15 }}>Worth a look</strong>
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {s.againstVoided.map((r) => (
                <div key={r.paymentId} style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <strong>Lot {r.lotNumber}</strong> — {money(r.amountCents)} came in
                  on {r.receivedOn} against a bill that was later cancelled. It&apos;s
                  counted here because the money arrived; if you gave it back, that
                  refund isn&apos;t recorded anywhere yet.
                </div>
              ))}
              {/* MONEY TAKEN BACK. Kept out of every total above — a bounced
                  check is not income — but never silently dropped: the receipt
                  number still exists, and a gap in the sequence is what makes
                  an accountant stop trusting the file. */}
              {s.reversed.map((r) => (
                <div key={`rev-${r.paymentId}`} style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <strong>Lot {r.lotNumber}</strong> — {money(r.amountCents)} recorded
                  on {r.receivedOn} and then taken back
                  {r.reversedReason ? `: ${r.reversedReason}` : ""}. It is NOT counted
                  in the totals above.
                </div>
              ))}
              {s.reversed.length > 0 && (
                <div className="mut" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  {money(s.reversedCents)} in total was recorded and then taken back
                  in this window.
                </div>
              )}
              {s.overpaidCents > 0 && (
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {money(s.overpaidCents)} more came in than was billed — somebody
                  paid ahead or overpaid. It counts as received either way.
                </div>
              )}
              {s.otherMonthCount > 0 && (
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {s.otherMonthCount}{" "}
                  {s.otherMonthCount === 1 ? "payment was" : "payments were"}{" "}
                  for a different month&apos;s bill. That&apos;s normal — on cash
                  basis it counts when it arrived, not what it was for.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ---- the file ----------------------------------------------------- */}
      <section style={{ marginTop: 18 }}>
        <a className="ll-btn" href={href} style={{ display: "inline-block", textDecoration: "none" }}>
          {/* THE BUTTON PROMISED A ROW COUNT THE FILE DID NOT HONOUR.
              `s.count` excludes reversed payments — every total on this screen
              does, and it says so. The FILE is built from a date filter alone,
              so a bounced cheque is in it. "Download 11 payments" produced a
              spreadsheet with 12 rows, the twelfth carrying the bounced amount.
              The rows now carry a "Taken back" column, so the honest count is
              every row in the file, with the taken-back ones named separately
              rather than quietly folded in. */}
          {s.count + s.reversed.length > 0
            ? `Download ${s.count + s.reversed.length} ${s.count + s.reversed.length === 1 ? "payment" : "payments"} for your accountant`
            : "Download the empty file anyway"}
        </a>
        <p className="mut" style={{ fontSize: 12, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
          A spreadsheet — one line per payment, with the date, amount, how it was
          paid, which lot and what the bill was made up of.{" "}
          {s.reversed.length > 0
            ? `${s.reversed.length} taken-back ${s.reversed.length === 1 ? "payment is" : "payments are"} in the file too, marked "Taken back" — they're excluded from the totals above, so don't sum the Amount column without filtering that out.`
            : ""}{" "}
          Nothing is rounded
          or summarised in it.
        </p>
      </section>

      {/* ---- the rows ----------------------------------------------------- */}
      {page.receipts.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <div className="ll-card">
            {page.receipts.map((r) => (
              <div key={r.paymentId}
                style={{ padding: "9px 14px", borderTop: "1px solid rgba(0,0,0,.06)",
                         display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mut" style={{ minWidth: 88, fontVariantNumeric: "tabular-nums" }}>
                  {r.receivedOn}
                </span>
                <strong style={{ minWidth: 56 }}>Lot {r.lotNumber}</strong>
                <span style={{ flex: 1 }}>{r.payerName ?? "—"}</span>
                <span className="mut" style={{ fontSize: 13 }}>
                  {r.method}{r.reference ? ` ${r.reference}` : ""}
                </span>
                {r.chargeStatus === "void" && <span className="ll-pill warn">bill cancelled</span>}
                {r.reversedAt && <span className="ll-pill slate">taken back</span>}
                <span style={{ minWidth: 88, textAlign: "right", fontWeight: 700,
                               fontVariantNumeric: "tabular-nums",
                               textDecoration: r.reversedAt ? "line-through" : undefined,
                               opacity: r.reversedAt ? 0.55 : 1 }}>
                  {money(r.amountCents)}
                </span>
                {/* TWO DIFFERENT ACTS, AND THE METHOD DECIDES WHICH IS HONEST.
                    Cash and cheques can be un-recorded, because nothing left
                    anybody's account. Card and ACH money demonstrably moved, so
                    the only truthful correction is sending it back — 0142 makes
                    the database refuse the other one. */}
                {!r.reversedAt && (r.method === "card" || r.method === "ach") && (
                  <button className="ll-btn ghost" style={{ fontSize: 12, padding: "3px 8px" }}
                    onClick={() => openRefund(r.paymentId)}>
                    Refund to card
                  </button>
                )}
                {/* A TRANSPOSED DIGIT USED TO BE PERMANENT. The row survives
                    with its receipt number; only the money stops counting. */}
                {!r.reversedAt && r.method !== "card" && r.method !== "ach" && (
                  <button className="ll-btn ghost" style={{ fontSize: 12, padding: "3px 8px" }}
                    onClick={() => setReversing(r.paymentId)}>
                    Take it back
                  </button>
                )}
                {refunding === r.paymentId && (
                  <div style={{ flexBasis: "100%", marginTop: 6 }}>
                    {!left ? (
                      <p className="mut" style={{ fontSize: 12, margin: 0 }}>
                        Checking what can still go back…
                      </p>
                    ) : (
                      <>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <label style={{ fontSize: 13 }}>Send back</label>
                          <input
                            value={backAmount}
                            onChange={(e) => setBackAmount(e.target.value)}
                            inputMode="decimal"
                            style={{ width: 110, fontVariantNumeric: "tabular-nums" }}
                          />
                          <span className="mut" style={{ fontSize: 12 }}>
                            of {money(Math.round(left.amount * 100))} left
                          </span>
                        </div>
                        {/* THE SURCHARGE IS A SEPARATE DECISION, ASKED EVERY
                            TIME. There is no park setting for it and no
                            default, because a default would be us deciding a
                            money policy nobody set. Only shown when a fee was
                            actually charged. */}
                        {left.fee > 0 && (
                          <label style={{ display: "flex", gap: 6, alignItems: "center",
                                          fontSize: 13, marginTop: 6 }}>
                            <input type="checkbox" checked={backFee}
                              onChange={(e) => setBackFee(e.target.checked)} />
                            <span>
                              Also return the {money(Math.round(left.fee * 100))} card fee
                            </span>
                          </label>
                        )}
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Why is it going back? Charged twice, wrong household…"
                          style={{ width: "100%", marginTop: 6 }}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                          <button className="ll-btn" disabled={busy || !reason.trim() || !backAmount.trim()}
                            onClick={() =>
                              start(async () => {
                                const res = await refundParkPayment(parkId, r.paymentId, {
                                  amount: Number(backAmount.replace(/[$,\s]/g, "")),
                                  feeAmount: backFee ? left.fee : 0,
                                  reason,
                                  idempotencyKey: refundKey,
                                });
                                toast(res.ok ? (res.signal ?? "Sent back.") : (res.error ?? "Couldn't do that."));
                                if (res.ok) { closeRefund(); setReason(""); router.refresh(); }
                              })
                            }>
                            {busy ? "Sending…" : "Send it back"}
                          </button>
                          <button className="ll-btn ghost" disabled={busy}
                            onClick={() => { closeRefund(); setReason(""); }}>
                            Cancel
                          </button>
                        </div>
                        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
                          This moves real money back to the card it came from. The
                          receipt stays on the record with the reason, and the bill
                          goes back to outstanding by whatever you send.
                        </p>
                      </>
                    )}
                  </div>
                )}
                {reversing === r.paymentId && (
                  <div style={{ flexBasis: "100%", marginTop: 6 }}>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="What happened? A bounced check, a typo…"
                      style={{ width: "100%" }}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                      <button className="ll-btn" disabled={busy || !reason.trim()}
                        onClick={() =>
                          start(async () => {
                            const res = await reversePayment(parkId, r.paymentId, reason);
                            toast(res.ok ? (res.signal ?? "Taken back.") : (res.error ?? "Couldn't do that."));
                            if (res.ok) { setReversing(null); setReason(""); router.refresh(); }
                          })
                        }>
                        {busy ? "Recording…" : "Take it back"}
                      </button>
                      <button className="ll-btn ghost" disabled={busy}
                        onClick={() => { setReversing(null); setReason(""); }}>
                        Cancel
                      </button>
                    </div>
                    <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
                      The receipt stays on the record with the reason. The bill goes
                      back to outstanding.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Chip({ label, onClick, busy }: { label: string; onClick: () => void; busy: boolean }) {
  return (
    <button className="ll-btn ghost" onClick={onClick} disabled={busy}
      style={{ padding: "6px 12px", fontSize: 13 }}>
      {label}
    </button>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 120, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
