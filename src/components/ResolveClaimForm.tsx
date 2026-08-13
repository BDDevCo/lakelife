"use client";

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { resolvePaymentClaim, type OpenClaim } from "@/app/park/ledger-actions";

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
 * There are exactly two honest endings that are not "we found it and recorded
 * it" (that path is the Record-payment button, and settling the money closes
 * the claim on its own):
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
 */
export function ResolveClaimForm({
  parkId, claim, lotNumber, onDone, onCancel,
}: {
  parkId: string;
  claim: OpenClaim;
  lotNumber: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, start] = useTransition();
  const [resolution, setResolution] = useState<"not_found" | "withdrawn">("not_found");
  const [note, setNote] = useState("");

  const needsNote = resolution === "not_found";
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 10, background: "rgba(0,0,0,.02)" }}>
      <strong style={{ fontSize: 14 }}>What did you find on lot {lotNumber}?</strong>

      {/* WHAT THEY ACTUALLY SAID, in front of him while he answers. He is
          about to decide against it or accept it, and the detail is what he
          checked the drop box and the bank against. */}
      <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 10px", lineHeight: 1.55 }}>
        They said they paid
        {claim.claimed_amount != null ? ` ${money(claim.claimed_amount)}` : ""}
        {claim.claimed_paid_on ? ` on ${claim.claimed_paid_on}` : ""}
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

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={needsNote
          ? "What you checked — drop box, bank statement, the dates you looked at"
          : "Anything worth remembering (optional)"}
        style={{ width: "100%", fontSize: 13 }}
      />
      {needsNote && (
        <p className="mut" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
          Required for this one. It puts somebody back in arrears on your word,
          so the record has to say what you looked at.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="ll-btn" disabled={busy || (needsNote && !note.trim())}
          onClick={() =>
            start(async () => {
              const res = await resolvePaymentClaim(parkId, claim.id, resolution, note);
              toast(res.ok ? (res.signal ?? "Recorded.") : (res.error ?? "Couldn't record that."));
              if (res.ok) onDone();
            })
          }>
          {busy ? "Recording…" : "Record what I found"}
        </button>
        <button className="ll-btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>

      <p className="mut" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
        Either way, what they said stays on the record. This adds your answer to
        it — it doesn&apos;t erase theirs.
      </p>
    </div>
  );
}
