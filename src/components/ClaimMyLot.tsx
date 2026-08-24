"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { claimMyFile } from "@/app/parks/claim-actions";
import { SwitchAccount } from "@/components/SignInHere";

/**
 * THE SCREEN SOMEBODY READS IN THEIR KITCHEN.
 *
 * She is 78, she has lived on lot 14 for eleven years, she pays by cheque, and
 * the park owner is standing beside her. Everything here is shaped by that:
 *
 *   * THREE FIELDS, NO ACCOUNT-BUILDING. Park, lot, code. Nothing is asked
 *     that she would have to go and find — she knows her lot number, and the
 *     other two are printed on the slip in her hand.
 *   * THE PARK IS PRE-FILLED when we can tell which one she means, so in the
 *     normal case it is two fields.
 *   * NO COUNTDOWN, NO ATTEMPT COUNTER ON SCREEN. The database locks after
 *     five tries; showing "2 of 5" turns a form into a test she can fail.
 *   * A WAY OUT THAT IS NOT FAILURE. "I'd rather not do this" is a real
 *     answer, on the screen, no smaller than anything else on the card. 0055 is
 *     explicit that paper is permanent and respectable, and a quarter to a
 *     third of a park never converts. That must not read as her falling at a
 *     hurdle.
 */
export function ClaimMyLot({
  parkSlug, parkName, presetCode, lotsAreNumeric = false, selfUrl,
}: {
  parkSlug?: string;
  parkName?: string;
  /**
   * This same page, with the park and the code still on it. The way back after
   * signing out of the wrong account — without it, the only sign-out is the top
   * bar's, which lands on "/" and throws the claim link and the pre-filled code
   * away. /parks/claim is linked from nowhere in the app, so her only route
   * back would be re-scanning the paper slip.
   */
  selfUrl?: string;
  /** Carried by the QR square on the slip, so only the lot number is left. */
  presetCode?: string;
  /**
   * True only when EVERY lot in this park is a plain number, as read off the
   * park's own lots. It decides between a keypad and a keyboard, and it fails
   * to the keyboard: a keyboard can type digits, a keypad cannot type letters,
   * so the wrong answer costs a little thumb work one way and locks somebody
   * out of their own lot the other.
   */
  lotsAreNumeric?: boolean;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState(parkSlug ?? "");
  const [lot, setLot] = useState("");
  const [code, setCode] = useState(presetCode ?? "");
  // `outcome` is kept so the two endings a person can act on get a control.
  // Without it every refusal was a sentence and nothing else.
  const [said, setSaid] = useState<
    { ok: boolean; message: string; reprintable?: boolean; outcome?: string } | null
  >(null);
  const [busy, start] = useTransition();
  const [optedOut, setOptedOut] = useState(false);

  function submit() {
    start(async () => {
      const res = await claimMyFile({ parkSlug: slug, lotNumber: lot, code });
      setSaid(res);
      if (res.ok) {
        // Straight to their own screen. No "success!" interstitial — the proof
        // that it worked is their lot and their rent being there.
        router.push("/parks/my");
        router.refresh();
      }
    });
  }

  if (optedOut) {
    return (
      <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>That&apos;s absolutely fine 🌊</h2>
        <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>
          Nothing changes. You pay the way you always have, and the office has
          your details exactly as before. If you ever want to look at your rent
          on a phone, ask them for a new slip — there&apos;s no rush and no
          deadline.
        </p>
      </div>
    );
  }

  return (
    <div className="ll-card ll-card-pad" style={{ maxWidth: 520 }}>
      <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>
        See your lot{parkName ? ` at ${parkName}` : ""}
      </h2>
      <p className="mut" style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 18px" }}>
        The office will have given you a slip with a code on it. Enter it here
        and your lot, your rent and your receipts appear on this phone. It
        doesn&apos;t change how you pay.
      </p>

      {!parkSlug && (
        <label className="ll-field" style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
          <span className="mut">Park</span>
          <input
            value={slug}
            placeholder="the-haven"
            autoCapitalize="none"
            style={{ marginTop: 4 }}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
      )}

      <label className="ll-field" style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
        <span className="mut">Your lot number</span>
        <input
          value={lot}
          placeholder="14"
          inputMode={lotsAreNumeric ? "numeric" : "text"}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          style={{ marginTop: 4 }}
          onChange={(e) => setLot(e.target.value)}
        />
      </label>

      <label className="ll-field" style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
        <span className="mut">The code on your slip</span>
        <input
          value={code}
          placeholder="K7QM-3XR9"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          // Big and spaced: this is read off paper and typed with a thumb.
          style={{ marginTop: 4, fontSize: 22, letterSpacing: "0.12em", fontVariantNumeric: "tabular-nums" }}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </label>
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 16px" }}>
        {presetCode
          ? "That came from the square you scanned — just your lot number to go."
          : "Upper or lower case is fine, and the dash is optional."}
      </p>

      {said && (
        <div
          role="status"
          style={{
            margin: "0 0 14px", padding: "12px 14px", borderRadius: 10,
            background: said.ok ? "var(--mint)" : "var(--sand)",
            fontSize: 15, lineHeight: 1.55,
          }}
        >
          {said.message}
          {said.reprintable && (
            <div className="mut" style={{ fontSize: 13, marginTop: 6 }}>
              Nothing is wrong at your end — a new slip takes them a moment.
            </div>
          )}

          {/* THE TWO ENDINGS SHE CAN ACT ON GET A CONTROL, which is the fix
              FollowInvite already carries for the identical case.

              ALREADY SET UP: the likeliest real refusal — the family iPad is
              signed in as her husband, or she claimed it on her own phone last
              week. The sentence says "sign in with that account" and there was
              no way to; the top bar's sign-out lands on "/" and takes the claim
              link and the code with it.

              ALREADY HERE: a true sentence about a lot that is one tap away,
              ending in a full stop. */}
          {said.outcome === "claim_already_set_up" && selfUrl && (
            <div style={{ marginTop: 10 }}>
              <SwitchAccount next={selfUrl} label="Sign in as that account" />
            </div>
          )}
          {said.outcome === "claim_already_here" && (
            <div style={{ marginTop: 10 }}>
              <Link className="ll-btn" href="/parks/my">See my lot →</Link>
            </div>
          )}
        </div>
      )}

      <button
        className="ll-btn"
        style={{ width: "100%", minHeight: 48 }}
        disabled={busy || !lot.trim() || !code.trim() || (!parkSlug && !slug.trim())}
        onClick={submit}
      >
        {busy ? "Checking…" : "See my lot"}
      </button>

      {/* THE WAY OUT, IN THE SAME TYPE SIZE AS EVERYTHING ELSE. Not a footnote
          and not greyed out — declining is a first-class answer, and a screen
          that hides it is a screen that pressures somebody's landlord's
          tenant. */}
      <button
        onClick={() => setOptedOut(true)}
        style={{
          display: "block", width: "100%", marginTop: 14, padding: "10px 0",
          background: "none", border: "none", cursor: "pointer",
          fontSize: 15, color: "var(--sub)", textDecoration: "underline",
        }}
      >
        I&apos;d rather not do this
      </button>
    </div>
  );
}
