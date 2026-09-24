"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { quoteAddon, declineToQuote } from "@/app/addons/actions";
import { toast } from "@/components/Toast";
import { crewStateSentence, normaliseCrewQuote, ADDON_DECLINE_REASON_MAX } from "@/lib/addons";
import { money } from "@/app/park/ledger-helpers";
// THE ONE AUTHOR OF THIS ARITHMETIC. `Math.round(q * (1 - k) * 100) / 100`
// written here would be a second implementation of the crew's take-home, and
// the day the two disagree is the day a contractor is paid a cent less than
// the screen promised. `crewPayout` is pure and importable from a client
// component precisely so no screen has to do its own multiplication.
import { crewPayout } from "@/lib/platform-fee";
import type { CrewAddon } from "@/app/addons/data";

/**
 * "THE CREW WOULD PROVIDE PRICING ON THAT EXTRA."
 *
 * THE BOX IS EMPTY AND STAYS EMPTY. No default, no placeholder amount, no
 * "crews near you charge about" line: LakeLife does not set a crew's price
 * (0174), and a filled box answers the question wrongly.
 *
 * BOTH NUMBERS, IN WORDS, BEFORE THEY SEND IT. The crew types what they
 * charge; they are paid that LESS the crew-side platform fee. A silent
 * deduction on a contractor's invoice is the worst outcome available on this
 * path, so the take-home is shown live beside the box and again in the text
 * they get when the owner says yes.
 *
 * NO CUSTOMER NUMBER APPEARS HERE (rule 1). The props carry the crew's own
 * quote and nothing else; the loader that fills them names an explicit column
 * list without `customer_price`, and the table grants a crew no select policy.
 */
export function CrewAddonPanel({
  addons,
  failed,
  crewPct,
}: {
  addons: CrewAddon[];
  /** True when the read failed. NOT the same fact as "there are none". */
  failed: boolean;
  /** The live crew-side platform fee, e.g. 0.12. Shown, never hidden. */
  crewPct: number;
}) {
  // A FAILED READ IS NOT AN EMPTY ONE. Showing nothing here would tell a crew
  // this owner has asked for nothing, when they may have asked for three
  // things — so the failure gets a sentence of its own rather than a silence
  // that reads as an answer.
  if (failed) {
    return (
      <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Extras the owner asked for</h3>
        <p className="mut" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
          We couldn&apos;t load these just now, so we can&apos;t tell you whether there are any.
          Pull the page again in a moment. Nothing about the booked job is affected either way.
        </p>
      </div>
    );
  }
  if (addons.length === 0) return null;
  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 16, fontWeight: 800, margin: "0 0 4px" }}>Extras the owner asked for</h3>
      <p className="mut" style={{ fontSize: 13, lineHeight: 1.55, margin: "0 0 12px" }}>
        These are on top of the booked job. Do the booked job as normal whatever happens here —
        nothing on this panel changes it.
      </p>
      {addons.map((a) => (
        <CrewAddonRow key={a.id} addon={a} crewPct={crewPct} />
      ))}
    </div>
  );
}

function CrewAddonRow({ addon, crewPct }: { addon: CrewAddon; crewPct: number }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saying, setSaying] = useState(false);
  const [busy, setBusy] = useState<null | "quote" | "decline">(null);

  const parsed = normaliseCrewQuote(amount);
  // The take-home, live, from the same arithmetic the payout will use.
  // `customerPct: 0` because `crewPayout` reads only the crew side and this
  // screen is never handed a customer figure (rule 1). It is a placeholder for
  // an unused field, not a fee of zero — nothing here bills anybody.
  const takeHome = parsed.ok ? crewPayout(parsed.amount, { customerPct: 0, crewPct }) : null;

  const state = crewStateSentence({
    status: addon.status,
    quote: addon.crewQuote != null ? money(addon.crewQuote) : null,
    payout: addon.crewQuote != null ? money(crewPayout(addon.crewQuote, { customerPct: 0, crewPct })) : null,
  });

  async function send() {
    setBusy("quote");
    const res = await quoteAddon(addon.id, amount);
    setBusy(null);
    if (!res.ok) { toast.err(res.error ?? "Something went wrong."); return; }
    setAmount("");
    toast("Sent. The owner decides — carry on with the booked job either way.");
    router.refresh();
  }

  async function no() {
    setBusy("decline");
    const res = await declineToQuote(addon.id, reason);
    setBusy(null);
    if (!res.ok) { toast.err(res.error ?? "Something went wrong."); return; }
    setSaying(false);
    setReason("");
    toast("Told them. The booked job goes ahead as normal.");
    router.refresh();
  }

  return (
    <div style={{ padding: "12px", borderRadius: 10, border: "1px solid var(--line)", marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <p style={{ fontSize: 15, lineHeight: 1.5, margin: 0, minWidth: 0 }}>“{addon.requestText}”</p>
        <span className={`ll-pill ${state.tone}`}>{state.pill}</span>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.55, margin: "8px 0 0" }}>{state.line}</p>

      {addon.status === "requested" && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}>$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder=""
              aria-label="What you'd charge for this extra"
              // 16, like every typed control: below it iOS zooms on focus and
              // never zooms back (design-system-holds).
              style={{ width: 120, padding: "9px 10px", borderRadius: 10, border: "1px solid var(--line)", fontSize: 16 }}
            />
            <button className="ll-btn" onClick={send} disabled={busy !== null || !parsed.ok}>
              {busy === "quote" ? "Sending…" : "Send this price"}
            </button>
            <button className="ll-btn ghost" onClick={() => setSaying((v) => !v)} disabled={busy !== null}>
              I&apos;d rather not
            </button>
          </div>

          {/* BOTH ENDS, BEFORE THEY SEND IT. */}
          <p className="mut" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "8px 0 0" }}>
            {takeHome != null
              ? `You quote ${money(parsed.amount)}. You're paid ${money(takeHome)} after the ${Math.round(crewPct * 1000) / 10}% platform fee, with this job's payout.`
              : `You name the price — LakeLife doesn't. You're paid what you type less the ${Math.round(crewPct * 1000) / 10}% platform fee, in this job's payout.`}
          </p>
          {amount.trim().length > 0 && !parsed.ok && parsed.problem && (
            <p className="mut" style={{ fontSize: 12.5, margin: "6px 0 0" }}>{parsed.problem}</p>
          )}

          {saying && (
            <div style={{ marginTop: 10 }}>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={ADDON_DECLINE_REASON_MAX}
                placeholder="Why not? (optional — they'll see this)"
                style={{ width: "100%", padding: "9px 10px", borderRadius: 10, border: "1px solid var(--line)", fontSize: 16 }}
              />
              <button className="ll-btn ghost" style={{ marginTop: 8 }} onClick={no} disabled={busy !== null}>
                {busy === "decline" ? "Telling them…" : "Tell them I can't take it on"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
