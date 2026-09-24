"use client";

/**
 * "JOSH ALSO NEED TO BE ABLE TO SEND A LINK/TEXT TO A HOME OWNER SO HE CAN GET
 * THEM TO ONBOARD ONTO THE PLATFORM AT HIS REQUEST RECOMENDATION." (23 Sep 2026)
 *
 * TWO WAYS, AND THE SCREEN MUST NEVER BLUR THEM, because only one of them is
 * LakeLife speaking:
 *
 *   WE EMAIL THEM. A name and an address, and LakeLife sends the invitation on
 *   the crew's behalf — the door that already existed, one customer at a time
 *   instead of a pasted list.
 *
 *   THEY SEND IT THEMSELVES. A link the crew copies into their own text, their
 *   own WhatsApp, their own email. LAKELIFE SENDS NOTHING.
 *
 * WHY THE SECOND ONE IS A LINK AND NOT A TEXT WE SEND. He asked for "link/text",
 * and the difference is the whole liability. A crew texting their own customer
 * from their own phone is a relationship they already have. LakeLife texting
 * that same person is a cold SMS to somebody who never opted in — and in this
 * product consent is a column with a writer, set by the resident and nobody
 * else. The bulk door has said so in its own comment since it was written:
 * "TCPA-safe: email only (no cold SMS)". This screen keeps that line intact and
 * gives the crew the thing that does not cross it.
 *
 * Either way the customer lands attached to THIS crew: the emailed invite stages
 * a row that materialises on signup with them as the property's crew, and the
 * link carries their referral code so the same attribution is written.
 */

import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { recommendOneCustomer, type ImportResult } from "@/app/vendor/import-actions";

export function RecommendCustomer({ link, linkReason }: { link: string | null; linkReason?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, start] = useTransition();
  const [copied, setCopied] = useState(false);

  function send() {
    start(async () => {
      const r = await recommendOneCustomer(name, email);
      setRes(r);
      if (r.ok && (r.invited ?? 0) > 0) {
        toast.ok("Invitation sent.");
        setName("");
        setEmail("");
      } else if (r.error) {
        toast.err(r.error);
      }
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.ok("Link copied.");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is refused often enough (an insecure origin, a locked
      // down browser) that a silent failure would leave them tapping a button
      // that looks like it worked. The link is on screen and selectable either
      // way, so say that rather than pretending.
      toast.err("Couldn't copy — select the link and copy it by hand.");
    }
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Bring a customer with you</h3>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 14px" }}>
        When they sign up you&apos;re already their crew — they book you the same
        as they always have, and you keep the work.
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 6 }}>
        <label style={{ fontSize: 12.5, fontWeight: 700 }}>We&apos;ll email them</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name (optional)"
          // 16, NOT 14: iOS zooms the whole page when a focused input is under
          // 16px and never zooms back out, which on a crew's phone at a dock is
          // a screen they have to pinch their way off. The design system has a
          // test for exactly this.
          style={{ padding: "9px 11px", fontSize: 16 }}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Their email"
          type="email"
          autoComplete="off"
          // 16, NOT 14: iOS zooms the whole page when a focused input is under
          // 16px and never zooms back out, which on a crew's phone at a dock is
          // a screen they have to pinch their way off. The design system has a
          // test for exactly this.
          style={{ padding: "9px 11px", fontSize: 16 }}
        />
        <button className="ll-btn" onClick={send} disabled={busy || !email.trim()} style={{ justifySelf: "start" }}>
          {busy ? "Sending…" : "Send the invitation"}
        </button>
      </div>

      {/* THE SKIPPED COUNT IS NOT AN ERROR AND MUST NOT READ AS ONE. The bulk
          door already de-dupes against accounts and open invites elsewhere, so
          "we didn't send it" here usually means somebody got there first —
          which is the system working, and which the crew needs said plainly. */}
      {res && res.ok && (res.skipped ?? 0) > 0 && (
        <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
          {res.skippedReasons?.[0] ?? "They're already with us — nothing sent."}
        </p>
      )}
      {res && res.ok && (res.notEmailed?.length ?? 0) > 0 && (
        <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
          They&apos;re on the list, but the email didn&apos;t go. Send them your
          link below instead.
        </p>
      )}

      <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 14 }}>
        <label style={{ fontSize: 12.5, fontWeight: 700, display: "block", marginBottom: 6 }}>
          Or send this yourself
        </label>
        {link ? (
          <>
            <p className="mut" style={{ fontSize: 13, margin: "0 0 8px" }}>
              Your own link. Text it, message it, read it out — it works the same
              way, and they still land as your customer. We don&apos;t send
              anything to their phone; that part&apos;s yours.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code
                style={{
                  fontSize: 12.5, padding: "7px 9px", background: "var(--sand-light)",
                  borderRadius: 6, wordBreak: "break-all", flex: "1 1 220px",
                }}
              >
                {link}
              </code>
              <button className="ll-btn ghost" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </>
        ) : (
          // A FAILED READ IS NOT AN ABSENT LINK. `getMyCrewLink` hands back the
          // reason it could not produce one — suspended, still onboarding, or a
          // read that simply did not answer — and each of those is a different
          // sentence to the person reading it.
          <p className="mut" style={{ fontSize: 13, margin: 0 }}>
            {linkReason ?? "Your link isn't ready yet."}
          </p>
        )}
      </div>
    </div>
  );
}
