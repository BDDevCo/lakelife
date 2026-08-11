"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { logPaymentClaim } from "@/app/park/ledger-actions";

/**
 * "THEY SAY THEY PAID" — the renter's side, with enough detail to check.
 *
 * WHAT THIS DELIBERATELY DOES NOT COLLECT: a photo of the check.
 *
 * The strip along the bottom of a check is the routing and account number plus
 * a signature specimen — a bank credential that can be used to pull money by
 * ACH. Holding those for every household makes this a target, and showing them
 * to the park hands a landlord their tenants' bank details, which is a
 * capability nobody asked for and cannot be un-given.
 *
 * The evidence a dispute actually turns on is the CHECK NUMBER, the amount and
 * the date it was written — that is what gets matched against the drop box and
 * the bank statement. The account number adds nothing to that and carries all
 * the risk. So the fields below are the whole of it.
 *
 * EVERY FIELD IS OPTIONAL. A quarter to a third of this park will never touch a
 * screen, and their claims arrive as somebody saying "I paid you" across a
 * counter with nothing in their hand. A form that demands a check number before
 * it records anything records nothing from exactly the households least able to
 * produce paperwork — and then their claims look thin next to the ones that
 * came with detail. Absence of evidence must never become the accusation.
 */

const METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "other", label: "Some other way" },
] as const;

export function ClaimForm({
  parkId, chargeId, lotNumber, balance, today, onDone, onCancel,
}: {
  parkId: string;
  chargeId: string;
  lotNumber: string;
  balance: number;
  today: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, start] = useTransition();
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("check");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [paidOn, setPaidOn] = useState("");
  const [note, setNote] = useState("");

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      {/* Explicit {" "} — JSX drops the space that follows an interpolation at
          a line break, and "Lot 1says" is the result. */}
      <strong style={{ fontSize: 14 }}>
        Lot {lotNumber}{" "}says they&apos;ve already paid this
      </strong>
      <p className="mut" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
        Write down whatever they told you — <strong>all of it optional</strong>.
        Recording this doesn&apos;t mean you agree with it, and it doesn&apos;t
        mark the bill paid. It stops them being chased or counted as late until
        you&apos;ve had a chance to look.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How they say they paid</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}
            style={{ marginTop: 4 }}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>

        {/* The field that actually settles it. A check number matches against
            the drop box and the bank statement; nothing else needs to. */}
        {method === "check" && (
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">Check number, if they know it</span>
            <input value={reference} onChange={(e) => setReference(e.target.value)}
              placeholder="1042" inputMode="numeric" style={{ marginTop: 4 }} />
          </label>
        )}

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How much</span>
          <input value={amount} inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)} style={{ marginTop: 4 }} />
        </label>

        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">When they say they paid it</span>
          <input type="date" value={paidOn} max={today}
            onChange={(e) => setPaidOn(e.target.value)} style={{ marginTop: 4 }} />
        </label>
      </div>

      <label className="ll-field" style={{ fontSize: 13, display: "block", marginTop: 10 }}>
        <span className="mut">Anything else they said</span>
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Dropped it in the box Tuesday, gave it to Dave, posted it…"
          style={{ marginTop: 4 }} />
      </label>

      <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Don&apos;t ask them to photograph the check. The strip along the bottom
        is their bank account number — the check number above is what matches it
        up, and it&apos;s all you need.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button className="ll-btn" disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await logPaymentClaim(parkId, chargeId, {
                amount, paidOn, method, reference, note,
              });
              toast(res.ok ? (res.signal ?? "Noted.") : (res.error ?? "Couldn't record that."));
              if (res.ok) onDone();
            })
          }>
          Note what they said
        </button>
        <button className="ll-btn ghost" onClick={onCancel} disabled={busy}>Back</button>
      </div>
    </div>
  );
}
