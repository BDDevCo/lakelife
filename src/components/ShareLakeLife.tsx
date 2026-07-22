"use client";

/**
 * Referral share card (roadmap §8 rails). Neighbors are the whole growth
 * flywheel on a lake — one dock talks to the next. Attribution is captured
 * the moment a friend lands through this link. The quoted numbers arrive
 * as props from the live platform dials so this card can never promise
 * something the machine doesn't pay.
 */

import { toast } from "@/components/Toast";

export function ShareLakeLife({
  link,
  earnedToDate,
  customerPct = 5,
  crewCap = 250,
}: {
  link: string;
  earnedToDate?: number;
  customerPct?: number;
  crewCap?: number;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied — send it to a neighbor. 🌊");
    } catch {
      toast("Couldn't copy — long-press the link instead.");
    }
  }
  return (
    <div className="ll-card ll-card-pad" style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>Give the lake a hand — earn credits 🌊</h3>
      <p className="mut" style={{ fontSize: 13.5, margin: "0 0 10px" }}>
        When a neighbor joins through your link, you earn {customerPct}% of what they spend for a year — as credits on your own bills. Bring your crew aboard instead and earn up to ${crewCap}.
      </p>
      {(earnedToDate ?? 0) > 0 && (
        <p style={{ fontSize: 15, fontWeight: 800, color: "var(--teal-dark)", margin: "0 0 10px" }}>
          You&apos;ve earned ${earnedToDate!.toFixed(2)} so far 🎉
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 200, fontSize: 12.5, padding: "10px 12px", border: "1.5px solid var(--line)", borderRadius: 10, overflowX: "auto", whiteSpace: "nowrap" }}>{link}</code>
        <button className="ll-btn gold" onClick={copy} style={{ minHeight: 44 }}>Copy link</button>
      </div>
      <p className="mut" style={{ fontSize: 12, margin: "8px 0 0" }}>
        <a href="/referral-terms" style={{ color: "inherit" }}>How the program works — plain-English terms</a>
      </p>
    </div>
  );
}
