"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { emailReceipt, takeDropSlipSerials } from "@/app/park/ledger-actions";
import {
  receiptBody, dropSlipSerials, dropSlipHalf, dropSlipSummary,
  type ReceiptLines,
} from "@/app/park/receipt-helpers";

/**
 * THE RECEIPT, THE MOMENT THE PAYMENT IS RECORDED.
 *
 * This is the only part of the money layer that gives the RENTER something.
 * Everything else — claims, the disputed state — is repair after the record has
 * already gone wrong. A receipt in somebody's hand is what stops it going
 * wrong, so it appears without being asked for.
 *
 * PRINT IS FIRST, not email. A quarter to a third of this park has no address
 * on file and never will, and the household most exposed to an unrecorded cash
 * payment is exactly the one that cannot be emailed proof of it.
 */

function printText(title: string, blocks: string[]) {
  const w = window.open("", "_blank", "width=680,height=880");
  if (!w) { toast("Your browser blocked the print window."); return false; }
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  w.document.write(
    `<!doctype html><title>${esc(title)}</title><style>
      body{font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:0}
      section{padding:40px 46px;page-break-after:always}
      pre{font:inherit;white-space:pre-wrap;margin:0}
      hr{border:0;border-top:1px dashed #999;margin:26px 0}
     </style>` +
    blocks.map((b) => `<section><pre>${esc(b)}</pre></section>`).join(""),
  );
  w.document.close();
  w.focus();
  w.print();
  return true;
}

export function ReceiptPanel({
  parkId, receipt, renterEmail, onClose,
}: {
  parkId: string;
  receipt: ReceiptLines;
  renterEmail: string | null;
  onClose: () => void;
}) {
  const [busy, start] = useTransition();
  const body = receiptBody(receipt);

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 12, background: "rgba(0,0,0,.02)" }}>
      <strong style={{ fontSize: 15 }}>Their receipt</strong>
      <pre style={{
        font: "12px/1.5 ui-monospace,Menlo,Consolas,monospace",
        whiteSpace: "pre-wrap", margin: "10px 0 0",
      }}>{body}</pre>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button className="ll-btn"
          onClick={() => printText(`Receipt ${receipt.lotNumber}`, [body])}>
          Print it
        </button>

        {/* Only offered when there is somewhere to send it. A disabled button
            labelled "Email" for a paper household is a small daily reminder
            that the software was not built for them. */}
        {renterEmail && (
          <button className="ll-btn ghost" disabled={busy}
            onClick={() =>
              start(async () => {
                const res = await emailReceipt(parkId, renterEmail, receipt);
                toast(res.ok ? (res.signal ?? "Sent.") : (res.error ?? "Couldn't send it."));
              })
            }>
            Email it to them
          </button>
        )}

        <button className="ll-btn ghost" onClick={onClose}>Done</button>
      </div>

      {!renterEmail && (
        <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
          No email on file for them — print it and hand it over.
        </p>
      )}
    </div>
  );
}

/**
 * DROP SLIPS — for money that arrives when nobody is there.
 *
 * A secured box is the realistic mechanism at this park, and it is the worst
 * case for the ledger: cash through a slot, no witness, and no record until
 * somebody empties it days later. A numbered two-part slip is the whole answer,
 * and it needs no phone, no account and no signal.
 */
export function DropSlips({ parkId }: { parkId: string }) {
  const [busy, start] = useTransition();
  const [count, setCount] = useState("40");
  const [open, setOpen] = useState(false);

  const n = /^\d+$/.test(count.trim()) ? Number(count) : 0;

  if (!open) {
    return (
      <button className="ll-btn ghost" onClick={() => setOpen(true)}>
        Print drop-box slips
      </button>
    );
  }

  return (
    <div className="ll-card ll-card-pad">
      <strong style={{ fontSize: 15 }}>Slips for the drop box</strong>
      <p className="mut" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
        Leave a stack by the box. Whoever drops money in fills both halves, puts
        one in with it and keeps the other. That keeps a record for the people
        who&apos;ll never use an app — and it&apos;s the only proof there is for
        cash going into a box when nobody&apos;s there.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
        <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
          <span className="mut">How many</span>
          <input value={count} inputMode="numeric"
            onChange={(e) => setCount(e.target.value)}
            style={{ marginTop: 4, width: 100 }} />
        </label>
        <button className="ll-btn" disabled={busy || n < 1}
          onClick={() =>
            start(async () => {
              const res = await takeDropSlipSerials(parkId, n);
              if (!res.ok || res.from == null) {
                toast(res.error ?? "Couldn't do that."); return;
              }
              const slips = dropSlipSerials(res.parkName!, res.from, n);
              const pages = slips.map((s) =>
                `${dropSlipHalf(s, "box", res.officeLine!)}\n\n` +
                `- - - - - - - - - - - - - - - - - - - - - - - - - -\n\n` +
                `${dropSlipHalf(s, "keep", res.officeLine!)}`,
              );
              if (printText("Drop slips", pages)) {
                toast(dropSlipSummary(res.from, n));
                setOpen(false);
              }
            })
          }>
          Print {n > 0 ? n : ""} slips
        </button>
        <button className="ll-btn ghost" onClick={() => setOpen(false)} disabled={busy}>
          Back
        </button>
      </div>

      <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Printing uses those serial numbers up — the next sheet carries on from
        where this one stops, so nobody can ever hold the same number twice.
      </p>
    </div>
  );
}
