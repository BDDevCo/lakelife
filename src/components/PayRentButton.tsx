"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "@/components/Toast";
import { payRent } from "@/app/parks/pay-actions";

/**
 * PAY THE RENT.
 *
 * Two taps, not one. Rent is the largest single payment most residents make,
 * and a button that empties an account on a stray thumb is not a convenience.
 * The confirm step names the amount and the park, so nobody pays the wrong
 * month or the wrong place.
 *
 * The button does not render at all unless the park has switched online rent
 * on — a resident is never offered a payment their landlord has not agreed to
 * accept, which is a promise the software would otherwise be making on his
 * behalf.
 */
export function PayRentButton({
  chargeId, amount, parkName, hasCard, disabled,
}: {
  chargeId: string;
  amount: number;
  parkName: string;
  hasCard: boolean;
  /** A disputed bill — the screen explains why; this stays out of the way. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (disabled) return null;

  if (!hasCard) {
    return (
      <Link className="ll-btn ghost sm" href="/profile" style={{ marginTop: 10, display: "inline-block" }}>
        Add a way to pay
      </Link>
    );
  }

  const usd = amount.toLocaleString(undefined, { style: "currency", currency: "USD" });

  return (
    <div style={{ marginTop: 12 }}>
      {!confirming ? (
        <button className="ll-btn gold" style={{ minHeight: 44 }} onClick={() => setConfirming(true)}>
          Pay {usd}
        </button>
      ) : (
        <div className="ll-field">
          <p style={{ fontSize: 13.5, margin: "0 0 8px", lineHeight: 1.55 }}>
            Pay <strong>{usd}</strong> to {parkName} from your saved card?
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="ll-btn gold"
              style={{ minHeight: 44 }}
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const res = await payRent(chargeId);
                  toast(res.ok ? (res.signal ?? "Paid.") : (res.error ?? "That didn't go through."));
                  if (res.ok) { setConfirming(false); router.refresh(); }
                })
              }
            >
              {busy ? "Paying…" : "Yes, pay it"}
            </button>
            <button className="ll-btn ghost" style={{ minHeight: 44 }} disabled={busy}
              onClick={() => setConfirming(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
