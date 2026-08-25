"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  previewChargeRun, runCharges, recordPayment, voidCharge,
  type LedgerPage,
} from "@/app/park/ledger-actions";
import { ClaimForm } from "@/components/ClaimForm";
import { ResolveClaimForm } from "@/components/ResolveClaimForm";
import { ReceiptPanel, DropSlips } from "@/components/ParkReceipt";
import type { ReceiptLines } from "@/app/park/receipt-helpers";
import {
  LEDGER_LABEL, ledgerHeadline, runSummary, prettyMonth, shiftMonth, currentPeriod,
  type RunPlan,
} from "@/app/park/ledger-helpers";
import { previewReminders, sendReminders } from "@/app/park/reminder-actions";
import { reminderSummary, type ReminderPlan } from "@/app/park/reminder-helpers";

/**
 * WHO OWES, WHO PAID, WHO IS LATE.
 *
 * Late sits at the top and nothing else competes with it — it is the only part
 * of this screen that needs him today. Everything unpaid but still inside the
 * office's catch-up window is deliberately NOT called late, because an owner
 * who learns the overdue list is usually wrong stops reading it.
 *
 * Recording a payment is two taps and defaults to CHECK, because that is what
 * actually comes through the office door.
 */

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "ach", label: "Bank transfer" },
  { value: "other", label: "Other" },
] as const;

const STATE_PILL: Record<string, string> = {
  late: "warn", part_paid: "warn", due: "slate", paid: "", void: "slate", credit: "",
  disputed: "warn",
};

export function ParkRent({ parkId, page }: { parkId: string; page: LedgerPage }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<
    { lines: ReceiptLines; email: string | null } | null
  >(null);

  function preview() {
    start(async () => {
      const res = await previewChargeRun(parkId, page.month);
      if (!res.ok || !res.plan) { toast(res.error ?? "Couldn't work that out."); return; }
      setPlan(res.plan);
    });
  }

  function run() {
    start(async () => {
      const res = await runCharges(parkId, page.month);
      if (!res.ok) { toast(res.error ?? "Couldn't raise those."); return; }
      toast(res.signal ?? "Done.");
      setPlan(null);
      router.refresh();
    });
  }

  const s = page.summary;

  return (
    <div className="wrap" style={{ paddingTop: 14, paddingBottom: 48 }}>
      {/* MONTHS OTHER THAN THIS ONE.
          `/park/rent` was hard-scoped to the current period and nothing linked
          anywhere else — so a June bill still open in August was structurally
          invisible, and the owner holding a July check in his hand had to type
          `?month=2026-07` into the address bar. The page always accepted the
          parameter; there was simply no way to click it.

          Forward stops at the current month on purpose: a month that hasn't
          happened has nothing to collect, and the Bill button on a future
          month would raise everybody's rent early. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <a className="ll-btn ghost" style={{ fontSize: 13 }}
          href={`/park/rent?month=${shiftMonth(page.month, -1)}`}>
          ← {prettyMonth(shiftMonth(page.month, -1))}
        </a>
        <h1 style={{ fontSize: 24, margin: 0 }}>Rent — {prettyMonth(page.month)}</h1>
        {page.month < currentPeriod(page.today) && (
          <a className="ll-btn ghost" style={{ fontSize: 13 }}
            href={`/park/rent?month=${shiftMonth(page.month, 1)}`}>
            {prettyMonth(shiftMonth(page.month, 1))} →
          </a>
        )}
        {page.month !== currentPeriod(page.today) && (
          <a className="mut" style={{ fontSize: 13 }} href="/park/rent">
            back to this month
          </a>
        )}
      </div>

      {/* ---- LATE FIRST. Nothing competes with it. ----------------------- */}
      <div
        className="ll-card ll-card-pad"
        style={{
          marginTop: 12,
          background: s.lateCount > 0 ? "rgba(200,60,40,.07)" : undefined,
        }}
      >
        <strong style={{ fontSize: 16 }}>{ledgerHeadline(s, page.lagDays)}</strong>
        {s.billed > 0 && (
          <div style={{ display: "grid", gap: 2, marginTop: 12, fontVariantNumeric: "tabular-nums" }}>
            <Row label="billed" value={money(s.billed)} />
            <Row label="in" value={money(s.collected)} />
            <Row label="outstanding" value={money(s.outstanding)} strong />
          </div>
        )}
      </div>

      {/* ---- the receipt, the moment a payment lands --------------------- */}
      {receipt && (
        <ReceiptPanel
          parkId={parkId}
          receipt={receipt.lines}
          renterEmail={receipt.email}
          onClose={() => setReceipt(null)}
        />
      )}

      {/* ---- the run ----------------------------------------------------- */}
      <section style={{ marginTop: 18 }}>
        {!plan ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={preview} disabled={busy}>
              {busy ? "Working…" : `Bill ${prettyMonth(page.month)}`}
            </button>
            <DropSlips parkId={parkId} />
          </div>
        ) : (
          <div className="ll-card ll-card-pad">
            <strong>{runSummary(plan, page.month)}</strong>
            {plan.skippedNoTotal > 0 && (
              <p className="mut" style={{ fontSize: 13, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
                The skipped ones have no rent set. They&apos;re left off rather
                than billed at zero — a $0 bill marked paid is how a missing
                rent survives a year.
              </p>
            )}
            <p className="mut" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              Raising bills tells nobody. You hand them out, or post them, the
              way you do now.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button className="ll-btn" onClick={run} disabled={busy || plan.toBill.length === 0}>
                Raise them
              </button>
              <button className="ll-btn ghost" onClick={() => setPlan(null)}>Back</button>
            </div>
          </div>
        )}
      </section>

      {/* ---- reminders. Only when somebody is actually late. -------------- */}
      {s.lateCount > 0 && (
        <Reminders parkId={parkId} month={page.month} onSent={() => router.refresh()} />
      )}

      {/* ---- the ledger --------------------------------------------------- */}
      {page.rows.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <div className="ll-card">
            {page.rows.map((r) => (
              <div key={r.id} style={{ padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ minWidth: 62 }}>Lot {r.lotNumber}</strong>
                  <span style={{ flex: 1 }}>{r.renterName ?? "—"}</span>
                  <span className="mut">{money(r.amount)}</span>
                  {r.paidTotal > 0 && r.balance > 0 && (
                    <span className="mut">{money(r.paidTotal)} in</span>
                  )}
                  <span style={{ minWidth: 80, textAlign: "right", fontWeight: 700 }}>
                    {r.balance > 0 ? money(r.balance) : r.balance < 0 ? `+${money(-r.balance)}` : "—"}
                  </span>
                  <span className={`ll-pill ${STATE_PILL[r.state] ?? ""}`}>
                    {LEDGER_LABEL[r.state]}
                    {r.state === "late" && ` ${r.overdueDays}d`}
                  </span>
                  {r.state !== "void" && r.balance > 0 && (
                    <button className="ll-btn ghost"
                      onClick={() => setPayingId(payingId === r.id ? null : r.id)}>
                      {payingId === r.id ? "Cancel" : "Record payment"}
                    </button>
                  )}
                  {/* CLOSING THE DISAGREEMENT. `resolvePaymentClaim` was
                      written, guarded and tested and then never called from
                      anywhere — so a disputed bill stayed disputed forever,
                      excluded from arrears and from every reminder, with the
                      copy below telling him to "say what you found" and no
                      control to say it with. Shown whenever a claim is open,
                      including on a charge whose balance is already zero —
                      that case had no exit at all, because the only other
                      button is gated on a balance. */}
                  {r.state === "disputed" && page.claims[r.id] && (
                    <button className="ll-btn ghost"
                      onClick={() => {
                        setResolvingId(resolvingId === r.id ? null : r.id);
                        setPayingId(null); setClaimingId(null);
                      }}>
                      {resolvingId === r.id ? "Cancel" : "Say what you found"}
                    </button>
                  )}
                  {/* THE RENTER'S SIDE. Logging it does not mean agreeing
                      with it, and most of these arrive as somebody saying it
                      across a counter.

                      NOT ONLY WHEN THE SOFTWARE ALREADY CALLS IT LATE. This
                      was gated on `state === "late"`, so a household saying "I
                      paid that" about a bill still inside the office's
                      catch-up window — which is exactly when they'd say it,
                      the month a new owner takes over — had nowhere to be
                      recorded. Any live bill without an open claim can carry
                      one; a paid one can be disputed too, because the argument
                      may be about the record itself. */}
                  {r.state !== "void" && !page.claims[r.id] && (
                    <button className="ll-btn ghost"
                      onClick={() => {
                        setClaimingId(claimingId === r.id ? null : r.id);
                        setPayingId(null);
                      }}>
                      {claimingId === r.id ? "Cancel" : "They say they paid"}
                    </button>
                  )}
                </div>

                {resolvingId === r.id && page.claims[r.id] && (
                  <ResolveClaimForm
                    parkId={parkId}
                    claim={page.claims[r.id]}
                    lotNumber={r.lotNumber}
                    today={page.today}
                    onDone={(r) => {
                      setResolvingId(null);
                      // Same panel the Record-payment path opens: confirming a
                      // claim IS a payment, and it prints the same receipt.
                      if (r) setReceipt(r);
                      router.refresh();
                    }}
                    onCancel={() => setResolvingId(null)}
                  />
                )}

                {claimingId === r.id && (
                  <ClaimForm
                    parkId={parkId}
                    chargeId={r.id}
                    lotNumber={r.lotNumber}
                    balance={r.balance}
                    today={page.today}
                    onDone={() => { setClaimingId(null); router.refresh(); }}
                    onCancel={() => setClaimingId(null)}
                  />
                )}

                {payingId === r.id && (
                  <PaymentForm
                    parkId={parkId}
                    chargeId={r.id}
                    balance={r.balance}
                    today={page.today}
                    onDone={(r) => {
                      setPayingId(null);
                      if (r) setReceipt(r);
                      router.refresh();
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {s.disputedCount > 0 && (
            <p style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
              <strong>
                {s.disputedCount === 1 ? "One household disagrees" : `${s.disputedCount} households disagree`}{" "}
                with what&apos;s on the ledger.
              </strong>{" "}
              {s.disputedAmount > 0
                ? "They say they've paid and we haven't found it. "
                : "They say a payment we've already recorded isn't what they handed over. "}
              Nothing is counted as late or chased until you&apos;ve looked — a
              payment is something two people were there for, and this ledger
              only hears your side of it. Check the drop box and the bank, then
              either record the payment or say what you found.
            </p>
          )}

          {page.lagDays > 0 && s.lateCount === 0 && s.outstanding > 0 && (
            <p className="mut" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
              Nothing is marked late until a bill is more than {page.lagDays}{" "}
              days past due — that&apos;s your office catch-up window, so a check
              sitting in an envelope doesn&apos;t make somebody look delinquent.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * REMINDING THE LATE ONES.
 *
 * The paper count is stated OUT LOUD and gated on: a quarter to a third of a
 * park is not on email, and those households are usually the longest-standing
 * ones. If printing were optional the software would quietly log "reminded"
 * for people nobody ever told, and the first thing they'd hear about arrears is
 * something much worse than a reminder. So the send button stays disabled until
 * the notices have actually gone to the printer.
 */
function Reminders({
  parkId, month, onSent,
}: { parkId: string; month: string; onSent: () => void }) {
  const [busy, start] = useTransition();
  const [plan, setPlan] = useState<ReminderPlan | null>(null);
  const [printed, setPrinted] = useState(false);

  function preview() {
    start(async () => {
      const res = await previewReminders(parkId, month);
      if (!res.ok || !res.plan) { toast(res.error ?? "Couldn't work that out."); return; }
      setPlan(res.plan);
      setPrinted(false);
    });
  }

  function printNotices(p: ReminderPlan) {
    const w = window.open("", "_blank", "width=760,height=900");
    if (!w) { toast("Your browser blocked the print window."); return; }
    const esc = (t: string) =>
      t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // One notice per page — these get folded and put through doors.
    const pages = p.toPrint
      .map((r) => `<section><h2>Lot ${esc(r.lotNumber)}</h2><pre>${esc(r.body)}</pre></section>`)
      .join("");
    w.document.write(
      `<!doctype html><title>${esc(month)} notices</title><style>
        body{font:15px/1.6 -apple-system,Segoe UI,sans-serif;margin:0}
        section{padding:56px 60px;page-break-after:always}
        h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:0 0 28px}
        pre{font:inherit;white-space:pre-wrap;margin:0}
       </style>${pages}`,
    );
    w.document.close();
    w.focus();
    w.print();
    setPrinted(true);
  }

  function send() {
    start(async () => {
      const res = await sendReminders(parkId, month);
      toast(res.ok ? (res.signal ?? "Sent.") : (res.error ?? "Couldn't send those."));
      if (res.ok) { setPlan(null); onSent(); }
    });
  }

  if (!plan) {
    return (
      <section style={{ marginTop: 14 }}>
        <button className="ll-btn ghost" onClick={preview} disabled={busy}>
          {busy ? "Working…" : "Remind the late ones"}
        </button>
      </section>
    );
  }

  const needsPrinting = plan.toPrint.length > 0;
  // Reached, but not the way they asked. Worth seeing — a run of these says
  // something about the park, not about one household.
  const downgraded = plan.toSend.concat(plan.toPrint).filter((r) => r.note);

  return (
    <section style={{ marginTop: 14 }}>
      <div className="ll-card ll-card-pad">
        <strong>{reminderSummary(plan)}</strong>

        {needsPrinting && (
          <p className="mut" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
            {plan.toPrint.length === 1 ? "One household isn't" : `${plan.toPrint.length} households aren't`}{" "}
            on email. They get a printed notice you hand over — same wording,
            logged the same way.
          </p>
        )}

        {(plan.blocked.length > 0 || downgraded.length > 0) && (
          <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
            {downgraded.map((d) => (
              <div key={d.chargeId} style={{ fontSize: 13, lineHeight: 1.5 }}>
                <strong>Lot {d.lotNumber}</strong>{" "}
                <span className="mut">— {d.note}</span>
              </div>
            ))}
            {plan.blocked.map((b) => (
              <div key={b.chargeId} style={{ fontSize: 13, lineHeight: 1.5 }}>
                <strong>Lot {b.lotNumber}</strong>{" "}
                <span className="mut">— {b.reason}</span>
              </div>
            ))}
          </div>
        )}

        {plan.skippedAlreadyReminded > 0 && (
          <p className="mut" style={{ fontSize: 13, marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
            {plan.skippedAlreadyReminded} already had one for {prettyMonth(month)} — nobody
            gets chased twice for the same bill.
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {needsPrinting && (
            <button className="ll-btn" onClick={() => printNotices(plan)} disabled={busy}>
              Print {plan.toPrint.length} {plan.toPrint.length === 1 ? "notice" : "notices"}
            </button>
          )}
          {/* Nothing left to send means the only ones outstanding are people we
              can't reach — the blocked lines above are the whole instruction,
              so a dead button here would just be noise. */}
          {plan.totalChased > 0 && (
            <button
              className={`ll-btn${needsPrinting ? " ghost" : ""}`}
              onClick={send}
              disabled={busy || (needsPrinting && !printed)}
            >
              {needsPrinting && !printed
                ? "Print them first"
                : plan.toSend.length > 0
                  ? `Send ${plan.toSend.length} and log the rest`
                  : "Log these as handed over"}
            </button>
          )}
          <button className="ll-btn ghost" onClick={() => setPlan(null)} disabled={busy}>
            Back
          </button>
        </div>
      </div>
    </section>
  );
}

function PaymentForm({
  parkId, chargeId, balance, today, onDone,
}: {
  parkId: string; chargeId: string; balance: number; today: string;
  onDone: (receipt?: { lines: ReceiptLines; email: string | null }) => void;
}) {
  const [busy, start] = useTransition();
  // Defaults to the full balance and to CHECK — the overwhelmingly common case
  // is somebody handing over the exact amount.
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("check");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  // Ties the payment back to the half they kept, which is the whole point of
  // the slip existing.
  const [dropSlipNo, setDropSlipNo] = useState("");
  // ONE KEY PER OPENED FORM. A double-tapped "Record it" — or a retry after
  // the office's connection stutters — used to write the money twice and burn
  // two receipt numbers. The second attempt now collides on 0081's unique
  // index. A genuinely second payment opens the form again and gets a new key.
  const [idemKey] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${chargeId}:${Date.now()}:${Math.random()}`);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How much</span>
          <input value={amount} inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}
            style={{ marginTop: 4 }}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">{method === "check" ? "Check number" : "Reference"}</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder={method === "check" ? "1042" : ""} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">When it came in</span>
          <input type="date" value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">Drop slip, if there was one</span>
          <input value={dropSlipNo} onChange={(e) => setDropSlipNo(e.target.value)}
            placeholder="TH-00041" style={{ marginTop: 4 }} />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="ll-btn" disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await recordPayment(
                parkId, chargeId, Number(amount.replace(/[$,\s]/g, "")),
                method, reference, receivedOn, dropSlipNo, idemKey,
              );
              toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
              if (res.ok) {
                onDone(res.receipt
                  ? { lines: res.receipt, email: res.renterEmail ?? null }
                  : undefined);
              }
            })
          }>
          Record it
        </button>
        <button className="ll-btn ghost" disabled={busy}
          onClick={() =>
            start(async () => {
              const why = window.prompt("Why are you cancelling this bill?");
              if (!why) return;
              const res = await voidCharge(parkId, chargeId, why);
              toast(res.ok ? (res.signal ?? "Cancelled.") : (res.error ?? "Couldn't cancel."));
              if (res.ok) onDone();
            })
          }>
          Cancel this bill
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 110, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</span>
      <span className="mut">{label}</span>
    </div>
  );
}
