"use client";

/**
 * "Bring your own crew" — a homeowner invites the pro they already use.
 * On submit we call inviteMyContractor(company, email), which creates an
 * unclaimed crew invite AND sets them as this property's preferred crew, so
 * the owner keeps their guy (first right of refusal at dispatch). The card
 * flips to a success state so the owner sees exactly what happened.
 */

import { useState } from "react";
import { inviteMyContractor } from "@/app/book/contractor-actions";
import { toast } from "@/components/Toast";

export function InviteMyCrew() {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function invite() {
    const co = company.trim();
    const addr = email.trim();
    if (!co || !addr) {
      toast("Add your crew's name and email first.");
      return;
    }
    setBusy(true);
    const res = await inviteMyContractor(co, addr);
    setBusy(false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't send that invite.");
      return;
    }
    setSentTo(res.company ?? co);
    setCompany("");
    setEmail("");
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 18, margin: "0 0 6px" }}>Already have a crew you love? 🌊</h3>

      {sentTo ? (
        <p style={{ fontSize: 14, margin: 0, color: "var(--teal-dark)", fontWeight: 600 }}>
          ✓ Invite sent to {sentTo} — they&rsquo;ll get an email to join, and they&rsquo;re
          set as your preferred crew.
        </p>
      ) : (
        <>
          <p className="mut" style={{ fontSize: 14, margin: "0 0 14px", maxWidth: 540 }}>
            Invite them — they keep your business, we handle the scheduling &amp; payment.
            They&rsquo;ll always be first on your jobs.
          </p>

          <div className="ll-field">
            <label>Crew / company name</label>
            <input
              placeholder="Miller's Pier & Lift"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <div className="ll-field">
            <label>Crew email</label>
            <input
              type="email"
              inputMode="email"
              placeholder="crew@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <button className="ll-btn gold" onClick={invite} disabled={busy}>
            {busy ? "Sending…" : "Invite my crew"}
          </button>
        </>
      )}
    </div>
  );
}
