"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { setNoticeHold } from "@/app/park/actions";

/**
 * THE ONE SWITCH THAT STOPS EVERYTHING REACHING A HOUSEHOLD.
 *
 * It is enforced inside `sendEmail` and `sendSms`, not at the call sites, so a
 * send path written next year is covered without anybody remembering. That also
 * means it stops the sends HE initiates — the bulk invite, the overdue chase, a
 * document delivery — and it says so here rather than letting him discover it
 * by tapping a button and getting a refusal he does not understand.
 *
 * HELD IS THE DEFAULT FOR A NEW PARK (0141). Day one is nobody's consent, and
 * every park arrives with a roll to load and the same chance to send twenty
 * strangers something before anyone is ready.
 */
export function NoticeHold({
  parkId, heldAt, reason,
}: {
  parkId: string;
  heldAt: string | null;
  reason: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const held = heldAt != null;
  const [why, setWhy] = useState(
    reason ?? "Held until the roll is loaded and the leases are executed.",
  );
  const [confirming, setConfirming] = useState(false);

  function apply(next: boolean) {
    start(async () => {
      const res = await setNoticeHold(parkId, next, why);
      toast(res.ok ? (res.signal ?? "Saved.") : (res.error ?? "Couldn't change that."));
      if (res.ok) { setConfirming(false); router.refresh(); }
    });
  }

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 4px" }}>Notices to your households</h2>
      <p className="mut" style={{ margin: "0 0 14px", lineHeight: 1.5, maxWidth: 640 }}>
        While this is on hold, no email or text reaches anyone on your roll —
        including anything you send by hand. Rent still bills, statements still
        print, and everything on these screens keeps working. Nobody is written
        to.
      </p>

      <div className="ll-card ll-card-pad">
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className={`ll-pill ${held ? "" : "slate"}`}>
            {held ? "On hold" : "Notices can go out"}
          </span>
          {held && heldAt && (
            <span className="mut" style={{ fontSize: 13 }}>
              since {heldAt.slice(0, 10)}
            </span>
          )}
        </div>

        <label className="ll-field" style={{ fontSize: 13, margin: "12px 0 0", display: "block" }}>
          <span className="mut">Why it&apos;s on hold — you&apos;ll want to know in December</span>
          <input value={why} disabled={busy || !held && !confirming}
            onChange={(e) => setWhy(e.target.value)} style={{ marginTop: 4, width: "100%" }} />
        </label>

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {held ? (
            <>
              {/* LIFTING IS THE IRREVERSIBLE-FEELING ONE, so it asks twice. The
                  first send after this reaches real people who have not heard
                  from this park before. */}
              {!confirming ? (
                <button className="ll-btn ghost" disabled={busy}
                  onClick={() => setConfirming(true)}>
                  Lift the hold
                </button>
              ) : (
                <>
                  <button className="ll-btn" disabled={busy} onClick={() => apply(false)}>
                    {busy ? "Lifting…" : "Yes — let notices go out"}
                  </button>
                  <button className="ll-btn ghost" disabled={busy}
                    onClick={() => setConfirming(false)}>
                    Keep it on hold
                  </button>
                </>
              )}
            </>
          ) : (
            <button className="ll-btn ghost" disabled={busy} onClick={() => apply(true)}>
              Put notices on hold
            </button>
          )}
        </div>

        {held && confirming && (
          <p className="mut" style={{ fontSize: 13, margin: "10px 0 0", lineHeight: 1.5 }}>
            After this, anything you send reaches your households for real — and
            the nightly checks can write to them too. Only lift it once
            everyone has signed and knows what to expect.
          </p>
        )}
      </div>
    </section>
  );
}
