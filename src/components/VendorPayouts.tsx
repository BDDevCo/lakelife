"use client";

/**
 * "Get paid" — a crew's bank-on-file + early payout ("get it now") + batch
 * history, on the Earnings page.
 *
 * SECURITY: routing/account numbers are write-only. setPayoutAccount()
 * never echoes them back — only last4 — and this component never asks for
 * or displays the full numbers again. "Change" always reopens BLANK inputs.
 *
 * CLAUDE.md rule 1 / house rule: every dollar shown here is the crew's own
 * take-home. No customer price, no margin, anywhere on this card.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { setPayoutAccount, requestEarlyPayout } from "@/app/vendor/bank-actions";
import type { PayoutState } from "@/app/vendor/bank-data";

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

const BATCH_KIND_LABEL: Record<string, string> = {
  early: "Early payout ⚡",
  monthly: "Monthly payout",
  referral: "Referral payout",
};

const BATCH_STATUS_PILL: Record<string, string> = {
  queued: "gold",
  exported: "teal",
  paid: "teal",
  failed: "warn",
};

function prettyDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function VendorPayouts({ state }: { state: PayoutState }) {
  return (
    <div className="wrap" style={{ paddingBottom: 24 }}>
      <div style={{ display: "grid", gap: 14 }}>
        <BankCard state={state} />
        <GetItNow state={state} />
        <BatchHistory batches={state.batches} />
      </div>
    </div>
  );
}

function BankCard({ state }: { state: PayoutState }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!state.hasAccount);
  const [bankName, setBankName] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await setPayoutAccount({ bankName, routing, account });
      if (!res.ok) {
        toast(res.error ?? "Couldn't save that bank info.");
        return;
      }
      setBankName(""); setRouting(""); setAccount("");
      setEditing(false);
      toast("Bank on file — encrypted and ready. 🌊");
      router.refresh();
    });
  }

  return (
    <div className="ll-card ll-card-pad">
      {!editing ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {state.bankName ?? "Bank on file"} ····{state.last4}
            </div>
            <p className="mut" style={{ fontSize: 12, margin: "4px 0 0" }}>
              Encrypted at rest. We only ever show the last 4.
            </p>
          </div>
          <button className="ll-btn ghost sm" onClick={() => setEditing(true)} style={{ minHeight: 44 }}>
            Change
          </button>
        </div>
      ) : (
        <div>
          <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Where should the money land? 🏦</h3>
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
            Encrypted at rest. We only ever show the last 4.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Bank name</span>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Lake Community Bank"
                style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
              />
            </label>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Routing number (9 digits)</span>
              <input
                inputMode="numeric"
                value={routing}
                onChange={(e) => setRouting(e.target.value)}
                placeholder="•••••••••"
                maxLength={9}
                style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
              />
            </label>
            <label className="ll-field" style={{ display: "block" }}>
              <span className="mut" style={{ fontSize: 13 }}>Account number</span>
              <input
                inputMode="numeric"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="••••••••"
                style={{ display: "block", marginTop: 6, fontSize: 15, minHeight: 44, width: "100%" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button className="ll-btn gold" onClick={save} disabled={pending} style={{ flex: 1, minHeight: 48 }}>
              {pending ? "Saving…" : "Save bank info"}
            </button>
            {state.hasAccount && (
              <button
                className="ll-btn ghost"
                onClick={() => { setBankName(""); setRouting(""); setAccount(""); setEditing(false); }}
                disabled={pending}
                style={{ minHeight: 48 }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GetItNow({ state }: { state: PayoutState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (state.readyNow <= 0) return null;

  if (!state.hasAccount) {
    return (
      <div className="ll-card ll-card-pad">
        <span className="ll-pill warn">Add your bank to unlock payouts</span>
      </div>
    );
  }

  function getItNow() {
    startTransition(async () => {
      const res = await requestEarlyPayout();
      if (!res.ok) {
        toast(res.error ?? "Couldn't start that payout.");
        return;
      }
      toast(`Early payout queued — ${formatCurrency(res.net ?? 0)} on the way. 🌊`);
      router.refresh();
    });
  }

  return (
    <div className="ll-card ll-card-pad" style={{ background: "var(--sun-soft)" }}>
      <p style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>
        {formatCurrency(state.readyNow)} released and ready
      </p>
      <button
        className="ll-btn gold"
        onClick={getItNow}
        disabled={pending}
        style={{ marginTop: 10, width: "100%", minHeight: 48 }}
      >
        {pending ? "Sending…" : `Get it now — ${formatCurrency(state.netNow)} lands (${formatCurrency(state.feeNow)} early fee)`}
      </button>
      <p className="mut" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Or wait for month-end — always free.
      </p>
    </div>
  );
}

function BatchHistory({ batches }: { batches: PayoutState["batches"] }) {
  if (batches.length === 0) return null;
  return (
    <div className="ll-card" style={{ overflow: "hidden" }}>
      {batches.map((b, i) => (
        <div
          key={b.id}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, padding: "12px 14px",
            borderTop: i === 0 ? "none" : "1px solid var(--line)",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {BATCH_KIND_LABEL[b.kind] ?? b.kind}
            </div>
            <div className="mut" style={{ fontSize: 12 }}>{prettyDate(b.created_at)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>{formatCurrency(b.net)}</div>
            <span className={`ll-pill ${BATCH_STATUS_PILL[b.status] ?? "slate"}`} style={{ marginTop: 3 }}>
              {b.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
