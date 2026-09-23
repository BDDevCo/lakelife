"use client";

/**
 * "Add a crew you already use" — the park's half of bring-your-own-crew.
 *
 * Mirrors InviteMyCrew with ONE difference in what it promises: it does not
 * say "they'll always be first on your jobs", because they won't be and
 * shouldn't be. Bringing a crew is not a lock (0178) — they join the platform,
 * they show up on your Choose-your-crew screen labelled as yours and shown
 * first, and every other crew who can do the work is on that same screen. Copy
 * that promised exclusivity here would be a promise the router now refuses to
 * keep.
 */

import { useState } from "react";
import { parkInviteCrew } from "@/app/park/crew-actions";
import { toast } from "@/components/Toast";

export function ParkInviteCrew({ parkId }: { parkId: string }) {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // The invite row exists even when the mail is refused, and the duplicate
  // guard means this button cannot be pressed again for that address — so the
  // true half has to be said, with the link.
  const [warning, setWarning] = useState<string | null>(null);

  async function invite() {
    const co = company.trim();
    const addr = email.trim();
    if (!co || !addr) {
      toast("Add the crew's name and email first.");
      return;
    }
    setBusy(true);
    const res = await parkInviteCrew(parkId, co, addr);
    setBusy(false);
    if (!res.ok) {
      toast.err(res.error ?? "Couldn't send that invite.");
      return;
    }
    setWarning(res.warning ?? null);
    setSentTo(res.company ?? co);
    setCompany("");
    setEmail("");
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Already have a crew you use here? 🌊</h3>

      {sentTo ? (
        warning ? (
          <p style={{ fontSize: 14, margin: 0, color: "var(--ink-warn)", fontWeight: 600 }}>{warning}</p>
        ) : (
          <p style={{ fontSize: 14, margin: 0, color: "var(--teal-dark)", fontWeight: 600 }}>
            ✓ Invite sent to {sentTo}. Once they&rsquo;re set up they&rsquo;ll show as one of your
            options — marked as your crew — whenever you book work for the park.
          </p>
        )
      ) : (
        <>
          <p className="mut" style={{ fontSize: 14, margin: "0 0 14px", maxWidth: 560 }}>
            Invite them and they keep your work — we handle the scheduling, invoicing and
            payment. They also become available to every homeowner on the three lakes, which is
            what makes it worth their while. They set their own prices; when you book, you see
            every crew who can do the job and what each one charges, and you pick.
          </p>

          <div className="ll-field">
            <label>Crew / company name</label>
            <input
              placeholder="Miller's Pier &amp; Lift"
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
          {/* THE RAILS MATCH ON THE EMAIL ADDRESS ALONE. A crew who signs up
              with a different one lands in the homeowner wizard, so both the
              screen and the email say to use this exact address. */}
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
            Use the address they&rsquo;ll actually sign up with — we match their invite on it, and a
            different address puts them in the homeowner sign-up instead.
          </p>

          <button className="ll-btn gold" onClick={invite} disabled={busy}>
            {busy ? "Sending…" : "Invite this crew"}
          </button>
        </>
      )}
    </div>
  );
}
