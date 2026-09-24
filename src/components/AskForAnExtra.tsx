"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { askForAnExtra, repeatAddon } from "@/app/addons/actions";
import { toast } from "@/components/Toast";
import { ADDON_OFFER_BACK_DAYS, ADDON_REQUEST_MAX, lastChargedLine, standardScopeLine } from "@/lib/addons";
import { money } from "@/app/park/ledger-helpers";
import { longDate } from "@/lib/lake-time";
import type { RememberedAddon } from "@/app/addons/data";

/**
 * "CAN THEY TYPE WHAT THEY WANT DONE ABOVE AND BEYOND THE STANDARD SERVICE?"
 *
 * The box, and the extras this crew has already priced at this house.
 *
 * WHAT IT REFUSES TO PRETEND. The panel opens by saying that LakeLife does not
 * hold a written list of what the booked service covers — because it does not:
 * `services` carries a name, rate columns, durations and a photo shot list,
 * and no scope anywhere. Approving a price for work the base visit may already
 * include is not informed consent, so the screen says what is true and points
 * at the box, which is a control it actually draws.
 *
 * THE REMEMBERED PRICES ARE OFFERED, NEVER APPLIED. Each one names what this
 * household was CHARGED last time, the day the crew NAMED that number, and —
 * only when the dial has moved since — what the same quote comes to today. It
 * takes a tap. Anything named more than ninety days ago is not offered at all:
 * the words come back through the box instead and the crew names a current
 * number. That age is measured from `quoted_at`, which a repeat carries
 * forward, so tapping a price cannot keep it alive. Nothing auto-renews and
 * nothing arrives pre-ticked.
 */
export function AskForAnExtra({
  jobId,
  serviceName,
  remembered,
  photographed,
  canAsk,
  whyNot,
}: {
  jobId: string;
  serviceName: string;
  remembered: RememberedAddon[];
  photographed: string[];
  /** False when the visit is finished or has no crew yet. */
  canAsk: boolean;
  whyNot: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // NAME THE BOX ONLY WHERE THE BOX IS DRAWN. The textarea renders only when
  // `canAsk`, and "ask your crew in the box below" was printed regardless —
  // over a finished visit and over one with no crew yet, where there is no box
  // on the screen at all.
  const scope = standardScopeLine({ serviceName, photographed, control: canAsk ? "box" : "none" });

  async function send() {
    setBusy("ask");
    const res = await askForAnExtra(jobId, text);
    setBusy(null);
    if (!res.ok) {
      toast.err(res.error ?? "Something went wrong. Please try again.");
      return;
    }
    setText("");
    toast("Sent to your crew. They'll put a price on it and you can say yes or no — your visit goes ahead either way.");
    router.refresh();
  }

  async function again(r: RememberedAddon) {
    setBusy(r.sourceId);
    const res = await repeatAddon(jobId, r.sourceId, r.priceNow);
    setBusy(null);
    if (!res.ok) {
      toast.err(res.error ?? "Something went wrong. Please try again.");
      return;
    }
    toast(`Added — ${res.price != null ? money(res.price) : "the extra"} goes on this visit at your crew's own price. They've been told.`);
    router.refresh();
  }

  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Want something extra on this visit?</h3>
      <p className="mut" style={{ fontSize: 13, lineHeight: 1.55, margin: "0 0 10px" }}>
        Tell your crew what you&apos;d like doing beyond what&apos;s booked. They put a price on it, you say yes or no,
        and it only joins this visit&apos;s bill if you say yes.
      </p>

      {/* WHAT "STANDARD" INCLUDES — and the honest answer. */}
      <div className="ll-notice" style={{ margin: "0 0 12px", background: "var(--sand)", borderColor: "var(--line)", color: "var(--text)" }}>
        <p style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>{scope.headline}</p>
        <p style={{ fontSize: 12.5, lineHeight: 1.55, margin: "4px 0 0" }}>{scope.detail}</p>
        {scope.photographed.length > 0 && (
          <p className="mut" style={{ fontSize: 12.5, margin: "4px 0 0" }}>{scope.photographed.join(" · ")}</p>
        )}
      </div>

      {remembered.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 800, margin: "0 0 6px" }}>You&apos;ve had these before from this crew</p>
          {remembered.map((r) => (
            <div
              key={r.sourceId}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", marginBottom: 8 }}
            >
              <div style={{ fontSize: 14, lineHeight: 1.45 }}>“{r.requestText}”</div>
              <div className="mut" style={{ fontSize: 12.5, marginTop: 3 }}>
                {/* THE PAST IN PAST FIGURES. `chargedThen` is what this
                    household was actually billed, frozen on the accepted row;
                    `priceNow` is what the same crew quote comes to at today's
                    dial, and it is only named when the two differ. */}
                {lastChargedLine({
                  charged: money(r.chargedThen),
                  named: longDate(r.namedOn),
                  todayPrice: money(r.priceNow),
                })}
              </div>
              <button
                className="ll-btn ghost"
                style={{ marginTop: 8 }}
                onClick={() => again(r)}
                disabled={busy !== null || !canAsk}
              >
                {busy === r.sourceId ? "Adding…" : `Add it again — ${money(r.priceNow)}`}
              </button>
            </div>
          ))}
          <p className="mut" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
            These are your crew&apos;s own prices from earlier visits, and tapping one adds it to this visit at that price.
            We stop offering a price once it&apos;s more than {ADDON_OFFER_BACK_DAYS} days old
            {canAsk ? " — ask again below and they'll price it as it stands." : "; after that your crew names a current one."}
          </p>
        </div>
      )}

      {canAsk ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={ADDON_REQUEST_MAX}
            rows={3}
            placeholder="e.g. Trim the four cedars along the seawall and haul the clippings"
            style={{
              // 16 IS THE FLOOR ON ANYTHING YOU TYPE INTO. Under it, Safari
              // zooms the page on focus and does not zoom back, so the next
              // tap lands somewhere else (design-system-holds).
              width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)",
              fontSize: 16, lineHeight: 1.5, fontFamily: "inherit", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <button className="ll-btn" onClick={send} disabled={busy !== null || text.trim().length === 0}>
              {busy === "ask" ? "Sending…" : "Ask my crew for a price"}
            </button>
            <span className="mut" style={{ fontSize: 12 }}>
              {text.length} / {ADDON_REQUEST_MAX}
            </span>
          </div>
          <p className="mut" style={{ fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" }}>
            Your crew sets the price — LakeLife never sets it for them. Nothing is charged until you say yes,
            and your {serviceName} happens as booked whatever you both decide.
          </p>
        </>
      ) : (
        <p className="mut" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
          {whyNot ?? "You can't add extras to this visit."}
        </p>
      )}
    </div>
  );
}
