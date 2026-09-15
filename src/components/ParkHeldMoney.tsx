"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import {
  recordOnAccount, recordDeposit, returnDeposit, applyOnAccount, unapplyAllocation,
  type OnAccountRow, type DepositRow,
} from "@/app/park/money-actions";
import { reversePayment } from "@/app/park/ledger-actions";
import { prettyMonth, money } from "@/app/park/ledger-helpers";
import { longDate } from "@/lib/lake-time";
import { ReceiptPanel } from "@/components/ParkReceipt";
import type { ReceiptLines } from "@/app/park/receipt-helpers";

/**
 * ONE ALLOCATION OF A PAYMENT ON ACCOUNT, as the page reads it (0167): which
 * bill month took how much, when, and whether the run or the office did it —
 * and, if the office has since taken it back off the bill (R3), when and why.
 * A removed line counts toward nothing (the view's `allocated` leaves it out)
 * and is shown as the record of the correction.
 */
export interface HeldAllocation {
  /** The allocation row's id — what "Take it off this bill" hands back. */
  id: string;
  /** YYYY-MM of the bill it went against. */
  periodMonth: string;
  amount: number;
  /** When it was applied — a timestamp. */
  appliedOn: string;
  via: "run" | "office";
  /** When the office took it back off the bill, or null while it stands. */
  removedOn: string | null;
  removedWhy: string | null;
}

/**
 * MONEY THAT ISN'T AGAINST A BILL — on account, and deposits held.
 *
 * The record-a-payment button lives on a row with an open balance, so before
 * this there was nowhere to put a January cheque handed over in December, a
 * second cheque, an overpayment, or a deposit taken at signing. All four
 * happen in month one at a window with nineteen households.
 *
 * MONEY ON ACCOUNT IS SHOWN AS A LIABILITY, NOT AS INCOME. It has no charge,
 * so it reaches no arrears figure and no statement until it is applied — and
 * the screen says so, because a number that looks like takings and isn't is
 * worse than no number.
 *
 * WHAT IS STILL HELD, NOT WHAT ARRIVED (0167). The payment row never moves:
 * a quarter paid ahead keeps `charge_id null` while the run puts $542.53 of
 * it against January, then February. This panel printed the cheque's amount,
 * so "$1,627.59 · Household 9" stood over money two-thirds spent — a figure
 * the office would offer against March, or hand back. The bold number is now
 * the view's `remaining`; the months it already paid sit under it.
 *
 * A CHEQUE SPENT IN FULL STAYS ON THE SCREEN, under "Applied in full". This
 * is the only screen with "Take it back" for a payment with no bill, and a
 * quarter-ahead cheque bounces AFTER the run has put it against three
 * months. Dropped from the list the morning March was applied, it could not
 * be reversed in exactly the case the reversal was built for.
 *
 * TAKING MONEY BACK OFF A BILL (R3) is a ghost control on each line: a
 * reason, a timestamp, a name, and the line stays as the record. The same
 * shape as Take it back, because it is the same class of act.
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
  allocations,
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
  /** Where each listed payment's money has gone, by payment id. Read by the page. */
  allocations: Record<string, HeldAllocation[]>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [mode, setMode] = useState<"none" | "account" | "deposit">("none");
  // THE PAPER, the moment money on account is recorded — the rent screen's
  // own panel, not a second one. It outlives the form's reset and the
  // router refresh, the way it does on the rent screen.
  const [receipt, setReceipt] = useState<{ lines: ReceiptLines; email: string | null } | null>(null);

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

  // STILL HELD, and SPENT. The loader lists both (a row with nothing applied
  // and nothing left is not listed at all); the screen keeps them apart
  // because they want different controls.
  const stillHeld = onAccount.filter((r) => r.remaining > 0);
  const spent = onAccount.filter((r) => r.remaining <= 0);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Money not against a bill</h3>
        <span className="mut" style={{ fontSize: 12.5, marginLeft: "auto" }}>
          {money(onAccountTotal)} on account · {money(depositsHeldTotal)} deposits held
        </span>
      </div>
      {/* "COMES OFF THE NEXT BILL YOU RAISE" IS TRUE (0167): the run puts a
          household's money on account against its bills the moment it raises
          one, oldest open bill first (R1) — so after a line is taken back off
          a bill, the next run puts the money against THAT bill, not a newer
          one. This used to say "sits with the household until you put it
          against a bill", which was the whole job before. */}
      <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 12px", lineHeight: 1.55 }}>
        Neither counts as rent collected. Money on account comes off the next
        bill you raise for that household, their oldest open bill first — or
        put it against an open bill now; a deposit is theirs and goes back —
        it can never pay rent.
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
                <option value="transfer">Bank transfer</option>
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
                if (res.ok) toast.ok(res.signal ?? "Recorded."); else toast.err(res.error ?? "Couldn't record that.");
                if (res.ok) {
                  // The receipt says where the money went the moment it was
                  // keyed and what is still held. A deposit has none yet.
                  setReceipt(res.receipt ? { lines: res.receipt, email: res.renterEmail ?? null } : null);
                  reset();
                  router.refresh();
                }
              })
            }
          >
            {busy ? "Recording…" : mode === "account" ? "Record it" : "Hold the deposit"}
          </button>
        </div>
      )}

      {receipt && (
        <ReceiptPanel
          parkId={parkId}
          receipt={receipt.lines}
          renterEmail={receipt.email}
          onClose={() => setReceipt(null)}
        />
      )}

      {stillHeld.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>On account</div>
          {stillHeld.map((r) => (
            <OnAccountLine key={r.paymentId} row={r} parkId={parkId} openCharges={openCharges}
              lines={allocations[r.paymentId] ?? []}
              busy={busy} start={start} router={router} />
          ))}
        </div>
      )}

      {/* SPENT, AND STILL HERE. Every cent is against bills, so there is
          nothing to apply — only a cheque that can still bounce, and the
          months it paid, each of which can be taken back off. */}
      {spent.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 2 }}>Applied in full</div>
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 6px", lineHeight: 1.5 }}>
            Every cent of these is against bills. They stay listed so a check
            that bounces can still be taken back.
          </p>
          {spent.map((r) => (
            <OnAccountLine key={r.paymentId} row={r} parkId={parkId} openCharges={openCharges}
              lines={allocations[r.paymentId] ?? []}
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
  row, parkId, openCharges, lines, busy, start, router,
}: {
  row: OnAccountRow;
  parkId: string;
  openCharges: Array<{ id: string; renterId: string | null; label: string }>;
  /** The months this payment has already paid, from the page's read. */
  lines: HeldAllocation[];
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [chargeId, setChargeId] = useState("");
  // Only THIS household's bills. Applying one household's cheque to another's
  // rent is an error only ever found by the person chased for money they paid.
  const mine = openCharges.filter((c) => !row.renterId || c.renterId === row.renterId);
  const spent = row.remaining <= 0;
  const applied = lines
    .filter((a) => !a.removedOn)
    .sort((a, b) => a.periodMonth.localeCompare(b.periodMonth));
  const takenOff = lines
    .filter((a) => a.removedOn)
    .sort((a, b) => String(a.removedOn).localeCompare(String(b.removedOn)));

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderTop: "1px dashed var(--line)" }}>
      <span style={{ fontSize: 13.5, flex: 1, minWidth: 160 }}>
        {/* WHAT IS STILL HELD. `amount` is the receipt's number and is named
            as what was received, below, only once some of it has gone. A
            spent row leads with the household: nothing of it is held, and
            the cheque is what the office is looking for. */}
        {spent ? (
          <>
            <b>{row.renterName}</b>
            <span className="mut">
              {" "}· {money(row.amount)} · {longDate(row.receivedOn)} · {row.method}{row.reference ? ` #${row.reference}` : ""}
              {row.receiptNo ? ` · receipt ${row.receiptNo}` : ""}
            </span>
          </>
        ) : (
          <>
            <b>{money(row.remaining)}</b> still on account · {row.renterName}
            <span className="mut">
              {" "}· {longDate(row.receivedOn)} · {row.method}{row.reference ? ` #${row.reference}` : ""}
              {row.receiptNo ? ` · receipt ${row.receiptNo}` : ""}
            </span>
          </>
        )}
      </span>
      {!spent && (mine.length > 0 ? (
        <>
          <select value={chargeId} onChange={(e) => setChargeId(e.target.value)}>
            <option value="">Put against…</option>
            {mine.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button className="ll-btn ghost sm" disabled={busy || !chargeId}
            onClick={() => start(async () => {
              const res = await applyOnAccount(parkId, row.paymentId, chargeId);
              if (res.ok) toast.ok(res.signal ?? "Applied."); else toast.err(res.error ?? "Couldn't apply that.");
              if (res.ok) router.refresh();
            })}>
            Apply
          </button>
        </>
      ) : (
        <span className="mut" style={{ fontSize: 12.5 }}>No open bill for them yet.</span>
      ))}
      {/* ONE CHEQUE, TWO ROWS. When this on-account money is the excess of a
          cheque that was also recorded against a bill, reversePayment takes
          BOTH halves back — so the confirm says so, or it would ask about
          $57.47 and act on $600. */}
      <UndoMoney parkId={parkId} paymentId={row.paymentId}
        what={row.partOfSplit
          ? `the whole cheque — ${money(row.amount)} on account and the part against the bill go back together`
          : "it"}
        busy={busy} start={start} router={router} />
      {/* WHERE THE REST WENT. One line per bill it paid, in month order —
          the record the office reads back when a household asks why March is
          "paid" and there is no March cheque. `allocated` is the view's own
          figure; the lines are the page's read of the same rows. Each line
          can be taken back off its bill, with a reason. */}
      {row.allocated > 0 && (
        <div className="mut" style={{ flexBasis: "100%", fontSize: 12.5, lineHeight: 1.5 }}>
          {/* "All of it" only when it is: a card payment part-refunded and
              the rest applied is spent (remaining 0) with allocated < amount. */}
          {spent && Math.round(row.allocated * 100) >= Math.round(row.amount * 100)
            ? `All ${money(row.amount)} of it is against bills:`
            : `Of ${money(row.amount)} received, ${money(row.allocated)} is against bills:`}
          {applied.map((a) => (
            <div key={a.id} style={{ paddingLeft: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>
                {money(a.amount)} to {prettyMonth(a.periodMonth)} ·{" "}
                {a.via === "run"
                  ? `when ${prettyMonth(a.periodMonth)} was billed`
                  : `by the office, ${longDate(a.appliedOn)}`}
              </span>
              <WithReason
                label="Take it off this bill"
                confirm={`Take ${money(a.amount)} off ${prettyMonth(a.periodMonth)}`}
                placeholder="Why — the wrong month, the wrong household"
                act={(why) => unapplyAllocation(parkId, a.id, why)}
                fallback="Couldn't take that off."
                busy={busy} start={start} router={router} />
            </div>
          ))}
        </div>
      )}
      {/* THE RECORD OF A CORRECTION. A line taken back off its bill counts
          toward nothing; it stays on the screen so "the record shows why"
          is true somewhere the office can read it. */}
      {takenOff.length > 0 && (
        <div className="mut" style={{ flexBasis: "100%", fontSize: 12.5, lineHeight: 1.5 }}>
          {takenOff.map((a) => (
            <div key={a.id} style={{ paddingLeft: 12 }}>
              {money(a.amount)} taken off {prettyMonth(a.periodMonth)} on {longDate(a.removedOn)}
              {a.removedWhy ? <> — &ldquo;{a.removedWhy}&rdquo;</> : null}
            </div>
          ))}
        </div>
      )}
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
          <b>{money(row.amount)}</b> · {row.renterName}
          <span className="mut">
            {" "}· taken {longDate(row.receivedOn)}{row.receiptNo ? ` · receipt ${row.receiptNo}` : ""}
          </span>
        </span>
        {row.returnedOn ? (
          <span className="ll-pill slate">
            {money(row.returnedAmount ?? 0)} returned {longDate(row.returnedOn)}
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
          Kept {money(Math.max(0, row.amount - (row.returnedAmount ?? 0)))} — &ldquo;{row.returnNote}&rdquo;
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
              if (res.ok) toast.ok(res.signal ?? "Returned."); else toast.err(res.error ?? "Couldn't record that.");
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
  return (
    <WithReason
      label="Take it back"
      confirm={`Reverse ${what}`}
      placeholder="Why — a bounced check, a typo"
      act={(why) => reversePayment(parkId, paymentId, why)}
      fallback="Couldn't do that."
      busy={busy} start={start} router={router} />
  );
}

/**
 * A CORRECTION WITH A REASON — the one shape for both. Take it back
 * (reversePayment, 0081) and Take it off this bill (unapplyAllocation, R3)
 * are the same class of act: a ghost button, a reason the database refuses
 * to do without, a confirm that is dead until it is typed, and the row kept
 * as the record. One component, so the second door cannot drift from the
 * first.
 */
function WithReason({
  label, confirm, placeholder, act, fallback, busy, start, router,
}: {
  label: string;
  confirm: string;
  placeholder: string;
  act: (why: string) => Promise<{ ok: boolean; signal?: string; error?: string }>;
  fallback: string;
  busy: boolean;
  start: (fn: () => void) => void;
  router: { refresh: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  if (!open) {
    return (
      <button className="ll-btn ghost sm" disabled={busy} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", width: "100%", marginTop: 6 }}>
      <input
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 180 }}
        autoFocus
      />
      <button className="ll-btn sm" disabled={busy || !why.trim()}
        onClick={() => start(async () => {
          const res = await act(why);
          if (res.ok) toast.ok(res.signal ?? "Done."); else toast.err(res.error ?? fallback);
          if (res.ok) { setOpen(false); setWhy(""); router.refresh(); }
        })}>
        {confirm}
      </button>
      <button className="ll-btn ghost sm" disabled={busy} onClick={() => { setOpen(false); setWhy(""); }}>
        Cancel
      </button>
    </div>
  );
}
