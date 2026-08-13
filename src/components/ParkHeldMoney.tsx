"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  recordOnAccount, recordDeposit, returnDeposit, applyOnAccount,
  type OnAccountRow, type DepositRow,
} from "@/app/park/money-actions";
import { reversePayment } from "@/app/park/ledger-actions";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * MONEY THAT ISN'T AGAINST A BILL — on account, and deposits held.
 *
 * The record-a-payment button lives on a row with an open balance, so before
 * this there was nowhere to put a January cheque handed over in December, a
 * second cheque, an overpayment, or a deposit taken at signing. All four
 * happen in month one at a window with nineteen households.
 *
 * MONEY ON ACCOUNT IS SHOWN AS A LIABILITY, NOT AS INCOME. It has no charge,
 * so it reaches no arrears figure and no statement until somebody applies it —
 * and the screen says so, because a number that looks like takings and isn't
 * is worse than no number.
 */
export function ParkHeldMoney({
  parkId,
  today,
  households,
  onAccount,
  deposits,
  onAccountTotal,
  depositsHeldTotal,
  openCharges,
}: {
  parkId: string;
  today: string;
  households: Array<{ id: string; name: string }>;
  onAccount: OnAccountRow[];
  deposits: DepositRow[];
  onAccountTotal: number;
  depositsHeldTotal: number;
  /** Live bills money on account can be put against. */
  openCharges: Array<{ id: string; renterId: string | null; label: string }>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [mode, setMode] = useState<"none" | "account" | "deposit">("none");

  const [renterId, setRenterId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("check");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  const [note, setNote] = useState("");
  // Minted per form-open, so a double-tapped submit collides on the
  // idempotency index instead of recording the money twice.
  const [key, setKey] = useState(() => crypto.randomUUID());

  function reset() {
    setMode("none"); setRenterId(""); setAmount(""); setReference("");
    setNote(""); setReceivedOn(today); setKey(crypto.randomUUID());
  }

  const amt = Number(amount.replace(/[$,\s]/g, ""));
  const ready = renterId && Number.isFinite(amt) && amt > 0 && receivedOn;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Money not against a bill</h3>
        <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>
          {usd(onAccountTotal)} on account · {usd(depositsHeldTotal)} deposits held
        </span>
      </div>
      <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 12px", lineHeight: 1.55 }}>
        Neither counts as rent collected. Money on account sits with the
        household until you put it against a bill; a deposit is theirs and goes
        back — it can never pay rent.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="ll-btn ghost sm" style={{ minHeight: 40 }}
          onClick={() => { reset(); setMode(mode === "account" ? "none" : "account"); }}>
          Money with no bill yet
        </button>
        <button className="ll-btn ghost sm" style={{ minHeight: 40 }}
          onClick={() => { reset(); setMode(mode === "deposit" ? "none" : "deposit"); }}>
          Take a deposit
        </button>
      </div>

      {mode !== "none" && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Household</span>
              <select value={renterId} onChange={(e) => setRenterId(e.target.value)} style={{ marginTop: 4 }}>
                <option value="">Pick one…</option>
                {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Amount</span>
              <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">How it came</span>
              <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ marginTop: 4 }}>
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="transfer">Transfer</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Day it arrived</span>
              <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            {mode === "account" && (
              <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
                <span className="mut">Check no. / reference</span>
                <input value={reference} onChange={(e) => setReference(e.target.value)} style={{ marginTop: 4 }} />
              </label>
            )}
            <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
              <span className="mut">Note</span>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={mode === "account" ? "e.g. for January" : "e.g. security deposit"} style={{ marginTop: 4 }} />
            </label>
          </div>

          <button
            className="ll-btn gold"
            style={{ marginTop: 12, minHeight: 44 }}
            disabled={busy || !ready}
            onClick={() =>
              start(async () => {
                const res = mode === "account"
                  ? await recordOnAccount(parkId, renterId, amt, method as "check", reference, receivedOn, note, key)
                  : await recordDeposit(parkId, renterId, amt, method as "check", receivedOn, note, key);
                toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
                if (res.ok) { reset(); router.refresh(); }
              })
            }
          >
            {busy ? "Recording…" : mode === "account" ? "Record it" : "Hold the deposit"}
          </button>
        </div>
      )}

      {onAccount.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>On account</div>
          {onAccount.map((r) => (
            <OnAccountLine key={r.paymentId} row={r} parkId={parkId} openCharges={openCharges}
              busy={busy} start={start} router={router} />
          ))}
        </div>
      )}

      {deposits.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>Deposits</div>
          {deposits.map((d) => (
            <DepositLine key={d.paymentId} row={d} parkId={parkId} today={today}
              busy={busy} start={start} router={router} />
          ))}
        </div>
      )}
    </div>
  );
}

function OnAccountLine({
  row, parkId, openCharges, busy, start, router,
}: {
  row: OnAccountRow;
  parkId: string;
  openCharges: Array<{ id: string; renterId: string | null; label: string }>;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [chargeId, setChargeId] = useState("");
  // Only THIS household's bills. Applying one household's cheque to another's
  // rent is an error only ever found by the person chased for money they paid.
  const mine = openCharges.filter((c) => !row.renterId || c.renterId === row.renterId);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderTop: "1px dashed var(--line)" }}>
      <span style={{ fontSize: 13.5, flex: 1, minWidth: 160 }}>
        <b>{usd(row.amount)}</b> · {row.renterName}
        <span className="mut">
          {" "}· {row.receivedOn} · {row.method}{row.reference ? ` #${row.reference}` : ""}
          {row.receiptNo ? ` · receipt ${row.receiptNo}` : ""}
        </span>
      </span>
      {mine.length > 0 ? (
        <>
          <select value={chargeId} onChange={(e) => setChargeId(e.target.value)} style={{ fontSize: 13 }}>
            <option value="">Put against…</option>
            {mine.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button className="ll-btn ghost sm" disabled={busy || !chargeId}
            onClick={() => start(async () => {
              const res = await applyOnAccount(parkId, row.paymentId, chargeId);
              toast(res.ok ? (res.signal ?? "Applied.") : (res.error ?? "Couldn't apply that."));
              if (res.ok) router.refresh();
            })}>
            Apply
          </button>
        </>
      ) : (
        <span className="mut" style={{ fontSize: 12.5 }}>No open bill for them yet.</span>
      )}
      <UndoMoney parkId={parkId} paymentId={row.paymentId} what="it"
        busy={busy} start={start} router={router} />
    </div>
  );
}

function DepositLine({
  row, parkId, today, busy, start, router,
}: {
  row: DepositRow;
  parkId: string;
  today: string;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(row.amount));
  const [when, setWhen] = useState(today);
  const [note, setNote] = useState("");
  const amt = Number(amount.replace(/[$,\s]/g, ""));

  return (
    <div style={{ padding: "8px 0", borderTop: "1px dashed var(--line)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13.5, flex: 1, minWidth: 160 }}>
          <b>{usd(row.amount)}</b> · {row.renterName}
          <span className="mut">
            {" "}· taken {row.receivedOn}{row.receiptNo ? ` · receipt ${row.receiptNo}` : ""}
          </span>
        </span>
        {row.returnedOn ? (
          <span className="ll-pill slate">
            {usd(row.returnedAmount ?? 0)} returned {row.returnedOn}
          </span>
        ) : (
          <>
            <button className="ll-btn ghost sm" onClick={() => setOpen((o) => !o)}>
              {open ? "Cancel" : "Give it back"}
            </button>
            {/* Reversing is for a deposit recorded in ERROR. Giving it back is
                the ordinary end of one; a deposit already returned cannot be
                reversed at all, and the server refuses it. */}
            <UndoMoney parkId={parkId} paymentId={row.paymentId} what="the deposit"
              busy={busy} start={start} router={router} />
          </>
        )}
      </div>

      {/* WHY ANY OF IT WAS KEPT. The form demands this and nothing read it
          back, so the only record of the reason lived in a column no screen
          opened. */}
      {row.returnedOn && row.returnNote && (
        <p className="mut" style={{ fontSize: 12, margin: "2px 0 0", lineHeight: 1.45 }}>
          Kept {usd(Math.max(0, row.amount - (row.returnedAmount ?? 0)))} — &ldquo;{row.returnNote}&rdquo;
        </p>
      )}

      {open && !row.returnedOn && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
          <label className="ll-field" style={{ fontSize: 13, margin: 0, maxWidth: 130 }}>
            <span className="mut">Returning</span>
            <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <label className="ll-field" style={{ fontSize: 13, margin: 0, maxWidth: 160 }}>
            <span className="mut">On</span>
            <input type="date" value={when} onChange={(e) => setWhen(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <label className="ll-field" style={{ fontSize: 13, margin: 0, flex: 1, minWidth: 160 }}>
            <span className="mut">Why, if you kept any</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 4 }} />
          </label>
          <button className="ll-btn" style={{ minHeight: 40 }}
            disabled={busy || !(amt > 0) || amt > row.amount}
            onClick={() => start(async () => {
              const res = await returnDeposit(parkId, row.paymentId, amt, when, note);
              toast(res.ok ? (res.signal ?? "Returned.") : (res.error ?? "Couldn't record that."));
              if (res.ok) { setOpen(false); router.refresh(); }
            })}>
            Record it
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * TAKE IT BACK. `reversePayment` was fixed to reach a payment with no charge,
 * and then no screen offered it — a working branch with no caller, which is
 * this codebase's most common way of shipping nothing. A reason is required
 * by the database, so it is required here.
 */
function UndoMoney({
  parkId, paymentId, what, busy, start, router,
}: {
  parkId: string;
  paymentId: string;
  what: string;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  if (!open) {
    return (
      <button className="ll-btn ghost sm" disabled={busy} onClick={() => setOpen(true)}>
        Take it back
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", width: "100%", marginTop: 6 }}>
      <input
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder={`Why — a bounced check, a typo`}
        style={{ flex: 1, minWidth: 180, fontSize: 13 }}
        autoFocus
      />
      <button className="ll-btn sm" disabled={busy || !why.trim()}
        onClick={() => start(async () => {
          const res = await reversePayment(parkId, paymentId, why);
          toast(res.ok ? (res.signal ?? "Taken back.") : (res.error ?? "Couldn't do that."));
          if (res.ok) { setOpen(false); setWhy(""); router.refresh(); }
        })}>
        Reverse {what}
      </button>
      <button className="ll-btn ghost sm" disabled={busy} onClick={() => { setOpen(false); setWhy(""); }}>
        Cancel
      </button>
    </div>
  );
}
