"use client";

/**
 * Referral share card (roadmap §8 rails). Neighbors are the whole growth
 * flywheel on a lake — one dock talks to the next. Attribution is captured
 * the moment a friend lands through this link; the thank-you economics
 * arrive when the owner turns the §8b dials on.
 */

import { toast } from "@/components/Toast";

export function ShareLakeLife({ link }: { link: string }) {
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
      <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>Know another dock that needs us? 🌊</h3>
      <p className="mut" style={{ fontSize: 13.5, margin: "0 0 10px" }}>
        Share your link — when a neighbor joins through it, they're yours in our book.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 200, fontSize: 12.5, padding: "10px 12px", border: "1.5px solid var(--line)", borderRadius: 10, overflowX: "auto", whiteSpace: "nowrap" }}>{link}</code>
        <button className="ll-btn gold" onClick={copy} style={{ minHeight: 44 }}>Copy link</button>
      </div>
    </div>
  );
}
