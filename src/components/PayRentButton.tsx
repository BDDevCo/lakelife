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
  chargeId, amount, parkName, hasCard, cardFeePct, disabled,
}: {
  chargeId: string;
  amount: number;
  parkName: string;
  hasCard: boolean;
  /**
   * Percent that will actually be added to THIS card — already resolved by
   * `my-data.ts` through the same gate the charge uses, so a debit card
   * arrives here as 0. Disclosed BEFORE the tap, never after, and disclosed
   * when it is zero too.
   */
  cardFeePct: number;
  /** A disputed bill — the screen explains why; this stays out of the way. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  // ONE KEY PER PANEL, minted when it opens and reused by every tap.
  //
  // `disabled={busy}` is not a guard against a double charge: it is
  // client-side, and `payRent` is an exported "use server" action any browser
  // can call. Two tabs, or a phone and a laptop, both read the same
  // paid_total and both charge the card. The key travels to the processor,
  // which replays the first result instead of taking a second payment, and
  // onto the row, where 0081's unique index refuses the duplicate.
  //
  // Minted per PANEL rather than per tap on purpose — a retry after a failed
  // attempt must carry the SAME key, or it is a fresh charge.
  const [idemKey] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);

  if (disabled) return null;

  if (!hasCard) {
    // /profile is right, and it used to be a dead end: the page short-circuited
    // to the lake-house wizard for anybody with no property profile, which is
    // every park resident. The card form is on that branch now, so this link
    // reaches something she can actually use.
    return (
      <Link className="ll-btn ghost sm" href="/profile" style={{ marginTop: 10, display: "inline-block" }}>
        Add a way to pay
      </Link>
    );
  }

  const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  const usd = money(amount);
  // DISCLOSED AT THE POINT OF SALE, which the card networks require and which
  // is anyway the only honest way to charge somebody extra. Cents, once, the
  // same arithmetic the server does (card-fee.ts), so the confirm panel and
  // the receipt cannot disagree by a penny.
  const amountCents = Math.round(amount * 100);
  const feeCents = cardFeePct > 0 ? Math.round((amountCents * cardFeePct) / 100) : 0;
  const fee = feeCents / 100;
  const total = (amountCents + feeCents) / 100;

  return (
    <div style={{ marginTop: 12 }}>
      {!confirming ? (
        <button className="ll-btn gold" style={{ minHeight: 44 }} onClick={() => setConfirming(true)}>
          Pay {usd}
        </button>
      ) : (
        <div className="ll-field">
          <p style={{ fontSize: 13.5, margin: "0 0 8px", lineHeight: 1.55 }}>
            Pay <strong>{money(total)}</strong> to {parkName} from your saved card?
          </p>
          {/*
            THE FEE, OR ITS ABSENCE, BEFORE THE TAP.
            The zero case used to render nothing at all, so "no fee" and "a fee
            nobody mentioned" looked identical on screen — and a zero here is
            now the ordinary case, because a debit card is never surcharged.
            Say which it is either way.

            AND NO BANK TRANSFER. This line used to read "Paying by bank
            transfer costs nothing extra". There is no ACH tender path in the
            product — `payRent` hard-codes method 'card' — so it sent her
            looking for a button nobody has built. Paying at the office is the
            fee-free route that actually exists today.
          */}
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.5 }}>
            {feeCents > 0 ? (
              <>
                {usd} rent plus a {cardFeePct}% card fee of {money(fee)}. Paying
                at the office by cash or cheque costs nothing extra.
              </>
            ) : (
              <>No card fee — you pay {usd} and nothing more.</>
            )}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="ll-btn gold"
              style={{ minHeight: 44 }}
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const res = await payRent(chargeId, idemKey);
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
