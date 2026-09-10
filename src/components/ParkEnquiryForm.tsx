"use client";

import { useState, useTransition } from "react";
import { submitParkEnquiry } from "@/app/for-parks/actions";

/**
 * THE PARK OWNER'S DOOR.
 *
 * Two required fields and five optional ones. The asymmetry is the design: a
 * form that demands a lot count from somebody who is only curious is a form
 * they close, and the lot count is worth far more when it arrives from
 * somebody who chose to give it.
 *
 * It does NOT promise a timescale. "We'll be in touch within 24 hours" is a
 * sentence the product cannot keep on a Sunday, and this codebase has a whole
 * defect class for copy that asserts what the code does not do.
 */
export function ParkEnquiryForm() {
  const [busy, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <div className="ll-card ll-card-pad" style={{ background: "var(--mint)" }}>
        <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>Thanks &mdash; that&apos;s with us.</h3>
        <p className="mut" style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
          We read every one of these ourselves. If you left a phone number we may
          ring rather than write.
        </p>
      </div>
    );
  }

  return (
    <form
      className="ll-card ll-card-pad"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const res = await submitParkEnquiry(data);
          if (res.ok) setDone(true);
          else setError(res.error ?? "That didn't send.");
        });
      }}
    >
      <div style={{ display: "grid", gap: 14 }}>
        <div className="ll-field">
          <label htmlFor="pe-name">Your name</label>
          <input id="pe-name" name="name" autoComplete="name" required maxLength={120} />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-email">Email</label>
          {/* type=email gives a phone the @ key without a second tap. */}
          <input id="pe-email" name="email" type="email" inputMode="email"
                 autoComplete="email" required maxLength={200} />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-phone">Phone <span className="mut">(optional)</span></label>
          <input id="pe-phone" name="phone" type="tel" inputMode="tel"
                 autoComplete="tel" maxLength={40} />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-park">Park name <span className="mut">(optional)</span></label>
          <input id="pe-park" name="park_name" maxLength={160} />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-town">Where it is <span className="mut">(optional)</span></label>
          <input id="pe-town" name="town" maxLength={160} placeholder="Town and state" />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-lots">How many lots <span className="mut">(optional)</span></label>
          {/* inputMode numeric: a keypad, not a full keyboard, for a number. */}
          <input id="pe-lots" name="lots" inputMode="numeric" maxLength={5} placeholder="e.g. 42" />
        </div>

        <div className="ll-field">
          <label htmlFor="pe-note">Anything else <span className="mut">(optional)</span></label>
          <textarea id="pe-note" name="note" rows={4} maxLength={2000}
                    placeholder="How you collect rent today, what you'd want it to do, whatever's on your mind." />
        </div>

        {error && (
          <p role="alert" style={{ fontSize: 13.5, margin: 0, color: "var(--danger)" }}>{error}</p>
        )}

        <button className="ll-btn gold" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send it"}
        </button>
      </div>
    </form>
  );
}
