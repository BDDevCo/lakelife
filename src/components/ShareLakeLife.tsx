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
  creditAvailable,
  maturing,
  availableIsPayout,
  customerPct = 5,
  crewCap = 250,
}: {
  link: string;
  earnedToDate?: number;
  /**
   * WHAT IS ACTUALLY LEFT, because the two are not the same number and the
   * screens that showed them never said so.
   *
   * `earnedToDate` is LIFETIME — every non-void referral earning, including
   * credits already spent on bills. /billing shows the credit BALANCE. A
   * customer who earned $150 and has spent $100 read "$150 earned" here and
   * "$50 credit" there, with nothing on either explaining why they disagree.
   * Both were true and the pair was confusing, which on somebody's money is
   * its own kind of wrong.
   *
   * The crew's version of this card already names all three of its figures
   * ("earned · maturing · ready for your next payout batch"). This is the
   * customer's, brought up to it.
   */
  creditAvailable?: number;
  /** Earned but not yet mature — not spendable, and not nothing either. */
  maturing?: number;
  /**
   * True when `creditAvailable` is a crew's matured payout rather than
   * spendable credit. A crew who also owns a lake house lands on this card,
   * and the two are not the same money.
   */
  availableIsPayout?: boolean;
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
          ${earnedToDate!.toFixed(2)} earned so far 🎉
          <span className="mut" style={{ fontWeight: 400, fontSize: 13.5 }}>
            {(maturing ?? 0) > 0 && <> · ${maturing!.toFixed(2)} still maturing</>}
            {creditAvailable != null && (
              <>
                {" "}· <b style={{ fontWeight: 700 }}>${creditAvailable.toFixed(2)}</b>{" "}
                {availableIsPayout ? "ready for your next payout batch" : "left to spend on your bills"}
              </>
            )}
          </span>
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
