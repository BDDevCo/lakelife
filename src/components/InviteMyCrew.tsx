"use client";

/**
 * "Bring your own crew" — a homeowner invites the pro they already use.
 * On submit we call inviteMyContractor(company, email), which creates an
 * unclaimed crew invite AND sets them as this property's preferred crew.
 *
 * WHAT "PREFERRED" MEANS NOW, because this card used to promise more than it
 * delivers. It said "They'll always be first on your jobs", and that was true
 * while the router picked and the customer never saw the alternatives. Since
 * 0178 the customer picks from every available crew, and preferred is a "Your
 * crew" badge and first place in the sort — never a filter, and never a first
 * right of refusal that skips the choice. Bringing a crew is not a lock:
 * "the owner needing the service should still see all the options, if any, for
 * the crews available and their pricing."
 *
 * AND IT ASKS BEFORE IT DUPLICATES. A different address is still probably the
 * same business, so the door comes back with `needsConfirm` and a short list
 * rather than quietly creating a second Josh.
 */

import { useState } from "react";
import { inviteMyContractor } from "@/app/book/contractor-actions";
import { SimilarCrewList } from "@/components/SimilarCrewList";
import type { SimilarCrew } from "@/lib/invite-guard";
import { toast } from "@/components/Toast";

export function InviteMyCrew() {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // "✓ Invite sent" was asserted unconditionally behind a fire-and-forget send.
  // When the mail is refused the crew is still bound as preferred — so the card
  // must say the true half and hand over the link, because the duplicate-invite
  // guard means this button cannot be pressed again for that address.
  const [warning, setWarning] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarCrew[] | null>(null);
  const [alreadyHere, setAlreadyHere] = useState<string | null>(null);

  async function invite(inviteAnyway = false) {
    const co = company.trim();
    const addr = email.trim();
    if (!co || !addr) {
      toast("Add your crew's name and email first.");
      return;
    }
    setBusy(true);
    const res = await inviteMyContractor(co, addr, inviteAnyway);
    setBusy(false);

    // NOT AN ERROR AND NOT A SEND. The name looks like somebody already here,
    // so the card turns into a question.
    if (!res.ok && res.needsConfirm && res.similar?.length) {
      setSimilar(res.similar);
      return;
    }
    if (!res.ok) {
      toast.err(res.error ?? "Couldn't send that invite.");
      return;
    }
    setSimilar(null);
    // A cross-reference that could not run must not read as an all-clear.
    setWarning(
      res.warning ??
        (res.crossReferenceUnavailable
          ? "Invite sent. We couldn't check whether they were already with us, so if they say they already have a LakeLife account, tell us and we'll join them up."
          : null),
    );
    setSentTo(res.company ?? co);
    setCompany("");
    setEmail("");
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>Already have a crew you love? 🌊</h3>

      {alreadyHere ? (
        <p style={{ fontSize: 14, margin: 0, color: "var(--teal-dark)", fontWeight: 600 }}>
          {alreadyHere} is already on LakeLife — nothing sent. They&rsquo;ll be one
          of your options next time you book, with their own price and days.
        </p>
      ) : similar ? (
        <SimilarCrewList
          typed={company.trim()}
          crews={similar}
          busy={busy}
          onMine={(c) => {
            // NOTHING IS SENT, and nothing is bound behind their back. They are
            // already on the platform, so the honest outcome is to say so — the
            // owner picks them on the offers screen like any other crew.
            setSimilar(null);
            setAlreadyHere(c.company);
            setCompany("");
            setEmail("");
          }}
          onNotMine={() => void invite(true)}
        />
      ) : sentTo ? (
        warning ? (
          <p style={{ fontSize: 14, margin: 0, color: "var(--ink-warn)", fontWeight: 600 }}>
            {warning}
          </p>
        ) : (
          <p style={{ fontSize: 14, margin: 0, color: "var(--teal-dark)", fontWeight: 600 }}>
            ✓ Invite sent to {sentTo} — they&rsquo;ll get an email to join, and
            they&rsquo;ll show up as your crew when you book.
          </p>
        )
      ) : (
        <>
          <p className="mut" style={{ fontSize: 14, margin: "0 0 14px", maxWidth: 540 }}>
            Invite them — they keep your business, we handle the scheduling &amp;
            payment. They&rsquo;ll be marked as your crew and shown first when you
            book, alongside anyone else working your lake.
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

          <button className="ll-btn gold" onClick={() => void invite()} disabled={busy}>
            {busy ? "Sending…" : "Invite my crew"}
          </button>
        </>
      )}
    </div>
  );
}
