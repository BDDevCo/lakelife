"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import {
  resolvePaymentClaim,
  confirmClaimCollected,
  type OpenClaim,
} from "@/app/park/ledger-actions";
import type { ReceiptLines } from "@/app/park/receipt-helpers";

/**
 * ANSWERING "THEY SAY THEY PAID".
 *
 * A dispute stops the software calling somebody delinquent while the two
 * parties disagree. That is right — but nothing could ever close one. The
 * charge was excluded from arrears, from every reminder and from the late
 * count PERMANENTLY, and the ledger printed "record the payment or say what
 * you found" beside no control for the second half. `resolvePaymentClaim`
 * existed, complete and careful, with no caller anywhere in the app.
 *
 * There are three honest endings, and the FIRST one is the ordinary case:
 *
 *   YES, I COLLECTED IT. The resident is right and the money is in the drawer.
 *   This is the answer given most often and it had no button here at all —
 *   only a trip to the Record-payment form to retype an amount and a date this
 *   screen was already showing. It is the confirmation that credits the bill;
 *   nothing the resident says on its own ever does. LakeLife handles no cash,
 *   so the person who physically took it is the only one who can say it
 *   arrived.
 *
 *   THEY WITHDREW IT. They looked again, found the check uncashed in a drawer,
 *   and said so. Nobody needs to justify that; it costs the renter nothing.
 *
 *   WE LOOKED AND THERE IS NO SUCH PAYMENT. This one puts a household back in
 *   arrears on the park's word against theirs, so the database refuses it
 *   without a written explanation. The note is not bureaucracy — it is the
 *   answer to "what did you actually check?", which is the first question
 *   anybody asks later, including a court.
 *
 * What is deliberately NOT here: any way to delete the claim. The renter's
 * assertion stays on the record whichever way it is answered.
 *
 * AND THE RECEIPT GOES BACK UP. "Yes, I collected it" runs `recordPayment`,
 * which mints a receipt number and a /paid confirmation link — the same
 * payload the Record-payment form hands to the receipt panel. This form's
 * `onDone` took no argument, so on the path the doc above calls "the answer
 * given most often" the receipt was built and dropped. The household that
 * handed over cash and then had to ASSERT they had paid is exactly the one
 * with nothing else to show for it; they got no printed copy and no counterfoil
 * to sign, while the household whose payment was simply typed in got both.
 */
export function ResolveClaimForm({
  parkId, claim, lotNumber, today, onDone, onCancel,
}: {
  parkId: string;
  claim: OpenClaim;
  lotNumber: string;
  /** Lake-local today — the default collection date, and the picker's ceiling. */
  today: string;
  /** Carries the receipt up on the collected path, so it can be printed. */
  onDone: (receipt?: { lines: ReceiptLines; email: string | null }) => void;
  onCancel: () => void;
}) {
  const [busy, start] = useTransition();
  const [resolution, setResolution] =
    useState<"collected" | "not_found" | "withdrawn">("collected");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState(
    claim.claimed_amount != null ? claim.claimed_amount.toFixed(2) : "",
  );
  const [receivedOn, setReceivedOn] = useState(claim.claimed_paid_on ?? today);

  // Minted once per open form, so a double-tapped confirm collides on 0081's
  // unique index instead of recording the money twice.
  const [idem] = useState(() => crypto.randomUUID());

  const collected = resolution === "collected";
  const needsNote = resolution === "not_found";
  const amountNum = Number((amount ?? "").replace(/[$,\s]/g, ""));
  const amountBad = collected && (!Number.isFinite(amountNum) || amountNum <= 0);
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  /** "August 14, 2026" — this line is read by a person, never 2026-08-14. */
  const pretty = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  };

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 10, background: "rgba(0,0,0,.02)" }}>
      <strong style={{ fontSize: 14 }}>What did you find on lot {lotNumber}?</strong>

      {/* WHAT THEY ACTUALLY SAID, in front of him while he answers. He is
          about to decide against it or accept it, and the detail is what he
          checked the drop box and the bank against. */}
      <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 10px", lineHeight: 1.55 }}>
        They said they paid
        {claim.claimed_amount != null ? ` ${money(claim.claimed_amount)}` : ""}
        {claim.claimed_paid_on ? ` on ${pretty(claim.claimed_paid_on)}` : ""}
        {claim.method ? ` by ${claim.method}` : ""}
        {claim.reference ? `, ref ${claim.reference}` : ""}.
        {claim.note ? ` “${claim.note}”` : ""}
        {/* THE LINE THAT USUALLY EXPLAINS IT. "I paid Ron" — the seller — is
            the likeliest claim of the takeover month, and this screen could
            not see it: `paid_to` was collected, written, and selected by
            nothing. */}
        {claim.paid_to ? (
          <>
            {" "}
            <b>They say they paid it to {claim.paid_to}.</b>
          </>
        ) : ""}
      </p>

      <div style={{ display: "grid", gap: 7, marginBottom: 10 }}>
        {/* FIRST, because it is the usual answer. */}
        <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13 }}>
          <input type="radio" name="res" checked={collected}
            onChange={() => setResolution("collected")} style={{ marginTop: 3 }} />
          <span>
            <strong>Yes &mdash; I collected it.</strong>{" "}
            <span className="mut">Records the payment and settles the bill.</span>
          </span>
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13 }}>
          <input type="radio" name="res" checked={resolution === "not_found"}
            onChange={() => setResolution("not_found")} style={{ marginTop: 3 }} />
          <span>
            <strong>I checked and there&apos;s no such payment.</strong>{" "}
            <span className="mut">Puts this bill back in arrears.</span>
          </span>
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13 }}>
          <input type="radio" name="res" checked={resolution === "withdrawn"}
            onChange={() => setResolution("withdrawn")} style={{ marginTop: 3 }} />
          <span>
            <strong>They took it back.</strong>{" "}
            <span className="mut">They looked again and agreed it hadn&apos;t gone out.</span>
          </span>
        </label>
      </div>

      {/* HOW MUCH, AND WHEN — prefilled from what they said, because that is
          right nearly every time, and editable because it is sometimes not.
          He may have been handed less than the bill, or on a different day
          than they remember, and the ledger has to record what happened rather
          than what was claimed. */}
      {collected && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 10, marginBottom: 10,
        }}>
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">How much you took</span>
            <input value={amount} inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00" style={{ marginTop: 4 }} />
          </label>
          <label className="ll-field" style={{ fontSize: 13, margin: 0 }}>
            <span className="mut">The day you took it</span>
            <input type="date" value={receivedOn} max={today}
              onChange={(e) => setReceivedOn(e.target.value)}
              style={{ marginTop: 4 }} />
          </label>
        </div>
      )}

      {/* The note belongs to the two answers that DISAGREE with the resident.
          Confirming needs no explanation — the payment row is the record. */}
      {!collected && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={needsNote
            ? "What you checked — drop box, bank statement, the dates you looked at"
            : "Anything worth remembering (optional)"}
          style={{ width: "100%" }}
        />
      )}
      {needsNote && (
        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
          Required for this one. It puts somebody back in arrears on your word,
          so the record has to say what you looked at.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="ll-btn"
          disabled={busy || amountBad || (needsNote && !note.trim())}
          onClick={() =>
            start(async () => {
              if (collected) {
                const res = await confirmClaimCollected(
                  parkId, claim.id, amountNum, receivedOn, idem,
                );
                toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
                if (res.ok) {
                  onDone(res.receipt
                    ? { lines: res.receipt, email: res.renterEmail ?? null }
                    : undefined);
                }
                return;
              }
              const res = await resolvePaymentClaim(parkId, claim.id, resolution, note);
              toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
              if (res.ok) onDone();
            })
          }>
          {busy
            ? "Recording…"
            : collected
              ? "Confirm I collected it"
              : "Record what I found"}
        </button>
        <button className="ll-btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>

      <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Whichever you pick, what they said stays on the record. This adds your
        answer to it — it doesn&apos;t erase theirs.
      </p>
    </div>
  );
}
