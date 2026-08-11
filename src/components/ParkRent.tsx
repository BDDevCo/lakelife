"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  previewChargeRun, runCharges, recordPayment, voidCharge,
  type LedgerPage,
} from "@/app/park/ledger-actions";
import { LEDGER_LABEL, ledgerHeadline, runSummary, type RunPlan } from "@/app/park/ledger-helpers";

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
};

export function ParkRent({ parkId, page }: { parkId: string; page: LedgerPage }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

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
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>Rent — {page.month}</h1>

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

      {/* ---- the run ----------------------------------------------------- */}
      <section style={{ marginTop: 18 }}>
        {!plan ? (
          <button className="ll-btn" onClick={preview} disabled={busy}>
            {busy ? "Working…" : `Bill ${page.month}`}
          </button>
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
                </div>

                {payingId === r.id && (
                  <PaymentForm
                    parkId={parkId}
                    chargeId={r.id}
                    balance={r.balance}
                    today={page.today}
                    onDone={() => { setPayingId(null); router.refresh(); }}
                  />
                )}
              </div>
            ))}
          </div>

          {page.lagDays > 0 && s.lateCount === 0 && s.outstanding > 0 && (
            <p className="mut" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
              Nothing is marked late until it&apos;s {page.lagDays} days past due —
              that&apos;s your office catch-up window, so a check sitting in an
              envelope doesn&apos;t make somebody look delinquent.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function PaymentForm({
  parkId, chargeId, balance, today, onDone,
}: {
  parkId: string; chargeId: string; balance: number; today: string; onDone: () => void;
}) {
  const [busy, start] = useTransition();
  // Defaults to the full balance and to CHECK — the overwhelmingly common case
  // is somebody handing over the exact amount.
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("check");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);

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
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="ll-btn" disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await recordPayment(
                parkId, chargeId, Number(amount.replace(/[$,\s]/g, "")),
                method, reference, receivedOn,
              );
              toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
              if (res.ok) onDone();
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
